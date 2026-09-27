# Agent Loop

Everpeace 将 OpenAI Codex 的核心 turn/sampling/follow-up 控制流程适配为 TypeScript，并通过 `ReactAgent` 接入真实 CLI/TUI；这不是完整 Rust runtime 的原样复制。

## 上游来源

固定参考：`openai/codex` revision `e269f2164cbb9f499e4f22301c393500e2a831f3`。

- [session/turn.rs](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/core/src/session/turn.rs)：`run_turn`、`run_sampling_request`、`try_run_sampling_request`；请求、工具后续采样、完成判断、可重试错误边界。
- [stream_events_utils.rs](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/core/src/stream_events_utils.rs)：`handle_output_item_done`，先记录调用再执行工具。
- [tools/parallel.rs](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/core/src/tools/parallel.rs)：工具 runtime 的执行、错误输出和取消边界；本项目只在显式能力标记下并行执行无副作用读取工具。

Apache-2.0 许可证与改动归属位于 `third_party/codex/`，随构建包包含。

## 本地结构

- `src/agent/agent-loop.ts`：sampling → record → tools → follow-up/completed；负责错误分类、有界采样预算、取消和能力标记驱动的工具批次，不依赖 Ink、文件存储或权限实现。
- `src/agent/react-agent.ts`：现有入口兼容适配器，负责 Responses 请求、指令、工具权限、工具路由、usage、恢复 context、可选 stream recovery adapter 和持久化 callback。
- `src/agent/repair-context.ts`：旧不完整工具上下文修复。

每次收到 completed 请求后先持久化响应，再执行工具；每个串行结果立即持久化后才进入下一工具。由 `canRunInParallel` 明确标记的 `read_file`、`list_directory`、`read_skill` 可组成连续批次，批次内同时执行，结果仍按模型原始顺序落盘，guidance 和 stop 在整批落盘后统一应用。取消时为所有已启动或未完成调用记录结构化结果，并为未启动调用补齐 `cancelled`、`steered` 或 `skipped`，之后抛出取消错误。持久化失败停止任务，不能在调用记录保存失败后执行副作用。SSE 在 `response.completed` 之前结束或断开时不会把半截输出当作成功，也不会启动工具；若 provider 显式提供 recovery adapter，当前 turn 只消耗独立续接预算，续接失败回退到默认最多两次的有界整轮采样重试。

只要存在 function call 或端点明确返回 `end_turn: false` 就继续采样。没有工具且没有明确继续信号时结束；兼容不提供 `end_turn` 的端点。非 completed 状态返回错误，不执行其中可能不完整的工具调用。call_id 缺失/重复在持久化前拒绝。

请求层对连接、超时、限流、服务端和半截流错误默认最多重试两次，退避可取消；上下文超限和永久错误不进入普通重试。主循环请求关闭 SDK 内部重试，避免重试叠加。仅重试采样，不重跑此前工具；采样、stream recovery 和 context compaction 各自维护预算。`onPhase` 提供 sampling/tools/completed/cancelled/failed 扩展入口；`ReactAgent` 同实例拒绝并发 turn。


## 优化路线边界

当前路线按正确性优先：先守住 `response.completed` 后整批执行的 durable-record 不变量，再迁移能力声明/共享资源闸门，最后在真实 provider 证据充分时评估 output-item 执行。item-level 执行只有在 provider 明确保证 `output_item.done` 顺序、durable record 和可恢复 cursor 时启用；未知端点继续整批路径。step snapshot 已通过 `prepareStep` 落地：采样重试复用当前 snapshot，工具 follow-up 重新捕获 MCP/Skill 状态；dispatch 仍重新检查当前权限。

benchmark 只用于协议变更前建立证据，不是当前实现的替代品。hooks、多 Agent、完整 MCP lifecycle、Plugin/远端 provider 和外部 app-server 不属于首轮 loop 优化，也不能用 no-op 或伪造成功暴露。并发工具后续从工具名白名单迁移到保守能力声明和读写闸门；未明确证明无副作用的工具继续串行。

## P0 实施状态

P0 协议基线已完成：`LoopEvent` 可报告 `response_rejected`；incomplete/failed 响应、重复/缺失 `call_id`、SSE/buffered、半截流、stream recovery、取消、steering、工具顺序和结果配对均有回归。采样重试、stream recovery、context compaction 各自维护预算；结果不进入 Session JSONL。现有 loop 仍等待 `response.completed` 后执行工具，未启用 item-level 调度。

当前阶段必须保持：半截 response 或 `response.failed` 不执行工具；响应 durable record 先于副作用；工具结果按模型顺序落盘；采样重试不重跑已完成工具；取消和持久化失败 fail-closed。

本地 no-op adapter smoke 只验证 benchmark harness 记录链路，不构成真实 provider baseline。固定任务 manifest 和真实 provider smoke 完成前，不以模拟或本地 smoke 结果推动 P1 协议改变。

## 当前与上游差异

上游是 Rust async runtime、流式 Responses 事件及多服务 Session；本地现在优先使用 Responses SSE。只有端点在尚未发出任何事件前明确拒绝 streaming 时，当前 Agent 才切换到 buffered `create`，并在该 Agent 生命周期内记住这个能力结果。连接中断、异常 EOF 和 `response.failed` 不会 fallback，而是按错误分类进行有界重试或失败。没有复制 Codex prompt、UI、账户登录或内部私有服务。

当前未移植：hook、多 Agent、流中途提前执行工具。并行工具只限显式能力标记的无副作用读取工具；基于 response id 的流续接也只在 provider 明确提供 adapter 时启用。`ReactAgent` 已支持已知阈值前置压缩，并在明确的 context-limit 错误后最多额外执行一次原生 compaction 和恢复采样；压缩失败不会进入普通采样重试，也不做本地摘要回退。模型 shell 已通过固定版本 Codex CLI 接入平台 sandbox；MCP tools 和主机 Skills 已作为现有 function-call 调度器的扩展接入，但不等同于 Codex 的完整 MCP/Plugin/Skill provider runtime，边界见 [CODEX_CAPABILITIES.md](./CODEX_CAPABILITIES.md)。循环提供 `LoopEvent`、流式文字 delta 和 safe-checkpoint steering：采样中的纠正会停止当前 SSE，工具执行中的纠正在工具结果持久化后生效；未启动的 function call 会写入 `steered` output，保证后续请求上下文完整。Ctrl+C 取消时，已提交但尚未应用的纠正会先写入模型 context，避免遗留到未来轮次。实时增量只属于当前 UI，不写入 JSONL。新增的批次/续接事件只用于 TUI、测试和诊断，不写入 Session JSONL。

自动测试使用模拟 Responses 与现有真实工具回归；不声称已验证真实供应商完整端到端或与 Codex 全功能等价。
