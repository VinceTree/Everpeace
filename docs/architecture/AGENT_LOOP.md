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

每次收到 completed 请求后先持久化响应，再执行工具；每个串行结果立即持久化后才进入下一工具。由 step capability 明确标记的 `read_file`、`list_directory`、`read_skill` 可组成连续读取区间，并由滑动的有界任务池执行：某项完成后即可补入下一项，不等待固定批次中的慢任务；结果仍按模型原始顺序落盘，同时限制已完成但尚未落盘的结果数量。guidance、取消、预算和持久化错误在启动下一项前检查，写操作、MCP 和审批构成串行屏障，不跨屏障重排。取消时为所有已启动或未完成调用记录结构化结果，并为未启动调用补齐 `cancelled`、`steered` 或 `skipped`，之后抛出取消错误。持久化失败停止任务，不能在调用记录保存失败后执行副作用。SSE 在 `response.completed` 之前结束或断开时不会把半截输出当作成功，也不会启动工具；若 provider 显式提供 recovery adapter，当前 turn 只消耗独立续接预算，续接失败回退到默认最多两次的有界整轮采样重试。

只要存在 function call 或端点明确返回 `end_turn: false` 就继续采样。没有工具且没有明确继续信号时结束；兼容不提供 `end_turn` 的端点。非 completed 状态返回错误，不执行其中可能不完整的工具调用。call_id 缺失/重复在持久化前拒绝。

请求层对连接、超时、限流、服务端和半截流错误默认最多重试两次，退避可取消；上下文超限和永久错误不进入普通重试。主循环请求关闭 SDK 内部重试，避免重试叠加。仅重试采样，不重跑此前工具；采样、stream recovery 和 context compaction 各自维护预算。`onPhase` 提供 sampling/tools/completed/cancelled/failed 扩展入口；`ReactAgent` 同实例拒绝并发 turn。

正常 follow-up sampling step 另有独立上限：默认每个 turn 32 个逻辑 step，可由 `ReactAgentOptions.maxSteps` 覆盖。step 内的采样重试复用同一 `prepareStep` 快照；工具结果完成后才清除快照并为下一 step 重新获取 MCP/Skill/Memory 状态。达到上限返回结构化 `step_limit`；可选 `maxTurnDurationMs` 使用同一停止协议返回 `deadline_exceeded`，默认不设置期限。限制触发后不再启动工具、采样、workflow 修复或 Goal 续跑，也不报告任务完成。该预算与采样重试、stream recovery、context compaction 分离，且不扩展 Session JSONL schema。

`LoopEvent.timing_recorded` 提供采样、退避、压缩、工具顺序等待和工具执行耗时；事件只含操作类型与时长，不记录 prompt、工具参数或凭据。`AgentLoopResult` 同时返回逻辑 step 数与轮次耗时，供 TUI 和 benchmark 诊断使用。


## 优化路线边界

当前路线按正确性优先：守住 `response.completed` 后整批执行的 durable-record 不变量，使用能力声明和有界批次控制并发，最后在真实 provider 证据充分时评估 output-item 执行。item-level 执行只有在 provider 明确保证 `output_item.done` 顺序、durable record 和可恢复 cursor 时启用；未知端点继续整批路径。step snapshot 已通过 `prepareStep` 落地：采样重试复用当前 snapshot，工具 follow-up 重新捕获 MCP/Skill 状态；dispatch 仍重新检查当前权限。

benchmark 只用于协议变更前建立证据，不是当前实现的替代品。hooks、多 Agent、完整 MCP lifecycle、Plugin/远端 provider 和外部 app-server 不属于首轮 loop 优化，也不能用 no-op 或伪造成功暴露。并发已采用保守能力声明和共享资源键冲突检查；写操作作为串行屏障，不跨写操作重排，也不声称已实现通用读写锁调度器。

## 工具能力与并发准入

`runAgentLoop` 可接收可选的 `toolCapabilities`，声明 `readOnly`、`idempotent`、`parallelSafe` 和 `resourceKeys`。只有前三项均为真且批次内资源键不冲突时才允许并发；未知能力或共享资源键保持串行。旧的 `canRunInParallel` 仅作为兼容回调，在没有能力声明时使用，不改变默认串行语义。ReactAgent 只为当前 step 提供的内置文件/Skill 读取声明并发能力；MCP annotations 不授予本地 parallelSafe，MCP 与所有审批保持串行。显式开启 `parallelToolCalls` 后每批默认最多 4 项，可由 `maxParallelTools` 调整。

function call 仍先完整校验并 durable record，再 dispatch；无效或重复 call_id、缺少 name/arguments 的响应在落盘和副作用前拒绝。这是当前 `response.completed` 批处理模型的安全边界，不等价于 Codex 的 `output_item.done` item-level 调度。

## P0 实施状态

P0 协议基线已完成：`LoopEvent` 可报告 `response_rejected`；incomplete/failed 响应、重复/缺失 `call_id`、SSE/buffered、半截流、stream recovery、取消、steering、工具顺序和结果配对均有回归。采样重试、stream recovery、context compaction 各自维护预算；结果不进入 Session JSONL。现有 loop 仍等待 `response.completed` 后执行工具，未启用 item-level 调度。

当前阶段必须保持：半截 response 或 `response.failed` 不执行工具；响应 durable record 先于副作用；工具结果按模型顺序落盘；采样重试不重跑已完成工具；取消和持久化失败 fail-closed。

本地 no-op adapter smoke 只验证 benchmark harness 记录链路，不构成真实 provider baseline。固定任务 manifest 和真实 provider smoke 完成前，不以模拟或本地 smoke 结果推动 P1 协议改变。

## 当前与上游差异

上游是 Rust async runtime、流式 Responses 事件及多服务 Session；本地现在优先使用 Responses SSE。只有端点在尚未发出任何事件前明确拒绝 streaming 时，当前 Agent 才切换到 buffered `create`，并在该 Agent 生命周期内记住这个能力结果。连接中断、异常 EOF 和 `response.failed` 不会 fallback，而是按错误分类进行有界重试或失败。没有复制 Codex prompt、UI、账户登录或内部私有服务。

当前未移植：hook、多 Agent、流中途提前执行工具。并行工具只限显式能力标记的无副作用读取工具；基于 response id 的流续接也只在 provider 明确提供 adapter 时启用。`ReactAgent` 已支持已知阈值前置压缩，并在明确的 context-limit 错误后最多额外执行一次原生 compaction 和恢复采样；压缩失败不会进入普通采样重试，也不做本地摘要回退。模型 shell 已通过固定版本 Codex CLI 接入平台 sandbox；MCP tools 和主机 Skills 已作为现有 function-call 调度器的扩展接入，但不等同于 Codex 的完整 MCP/Plugin/Skill provider runtime，边界见 [CODEX_CAPABILITIES.md](./CODEX_CAPABILITIES.md)。循环提供 `LoopEvent`、流式文字 delta 和 safe-checkpoint steering：采样中的纠正会停止当前 SSE，工具执行中的纠正在工具结果持久化后生效；未启动的 function call 会写入 `steered` output，保证后续请求上下文完整。Ctrl+C 取消时，已提交但尚未应用的纠正会先写入模型 context，避免遗留到未来轮次。实时增量只属于当前 UI，不写入 JSONL。新增的批次/续接事件只用于 TUI、测试和诊断，不写入 Session JSONL。

自动测试使用模拟 Responses 与现有真实工具回归；不声称已验证真实供应商完整端到端或与 Codex 全功能等价。

## 交叉边界与停止结果

每个逻辑 step 深复制 MCP/Skill metadata 与工具 definitions，并冻结广告工具集合；请求重试复用该集合，dispatch 拒绝未提供的工具并重新检查当前权限。Plan 的只读限制在 dispatch 生效，不依赖模型遵守工具列表。guidance 中的显式 Skill 引用参与下一个 step 的准备。

Steering 使用独立的 `hasPendingSteering` 查看接口和 `applySteering` 提交接口。先按顺序持久化工具结果及未启动调用的 `steered` output，再保存用户消息；消息保存成功才移出队列。新 guidance 刷新 step 并消耗正常步数，完成前再次检查 pending input。取消或正常错误收尾保留已接收 guidance；持久化失败立即停止，不在同一次失败处理中自动重试存储。

`runAgentLoop` 返回 `AgentLoopResult`，`AgentTurnResult.stopReason` 可为 `budget_limited` 或 `usage_limited`。本轮关联 Goal 的状态在采样/重试前、usage 更新后及工具检查点检查；触达限额后保留已收到响应，为未执行调用补齐带原因的 `skipped`，发出 `stopped` phase，不发出伪 `completed`。TUI 显示停止原因并跳过 workflow 自动验证修复及 Goal 自动续跑。预算基于已返回 usage，正在进行的单次请求可能越过剩余预算；已知消耗仍如实累计。预算停止不触发 learned-memory 成功提炼。

`PersistenceError` 区分 context、usage、Goal 和 workflow 存储失败；不会进入模型请求重试，也不会被转换成普通工具失败继续执行。真正的工具错误仍返回 function output。并行批次等待所有已启动调用结束，按模型顺序落盘，取消后不启动下一批。所有步数、重试及并发配置必须是合法有限整数。

## 压缩与流缓存

阈值自动压缩在 step 准备阶段运行，不因普通采样网络重试重复执行；明确 context-limit 恢复保留独立预算。compaction 的 usage 只表示本次消耗，不能作为压缩后 context 大小：Agent、TUI 和 Session 重放均将压缩后占用设为未知，下一次正常 response usage 到达后再更新。沿用已有 `context_compacted` 和 usage 事件，无 schema 迁移。

实际新采样请求发送 `sampling_started`，清除 UI 上一请求的临时状态。未配置 recovery adapter 时不保存完整 SSE event log；配置后恢复缓存默认 8 MiB，可通过 `recoveryCacheMaxBytes` 调整。超过上限释放缓存并禁用本响应的 cursor recovery；完整流继续正常消费，断流则使用原有有界整请求重试。该上限不裁剪最终模型内容或工具参数。
