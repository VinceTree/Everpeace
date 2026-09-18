# Agent Loop

Everpeace 将 OpenAI Codex 的核心 turn/sampling/follow-up 控制流程适配为 TypeScript，并通过 `ReactAgent` 接入真实 CLI/TUI；这不是完整 Rust runtime 的原样复制。

## 上游来源

固定参考：`openai/codex` revision `e269f2164cbb9f499e4f22301c393500e2a831f3`。

- [session/turn.rs](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/core/src/session/turn.rs)：`run_turn`、`run_sampling_request`、`try_run_sampling_request`；请求、工具后续采样、完成判断、可重试错误边界。
- [stream_events_utils.rs](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/core/src/stream_events_utils.rs)：`handle_output_item_done`，先记录调用再执行工具。
- [tools/parallel.rs](https://github.com/openai/codex/blob/e269f2164cbb9f499e4f22301c393500e2a831f3/codex-rs/core/src/tools/parallel.rs)：工具 runtime 的执行、错误输出和取消边界；本次保留串行执行，不移植其并发调度器。

Apache-2.0 许可证与改动归属位于 `third_party/codex/`，随构建包包含。

## 本地结构

- `src/agent/agent-loop.ts`：sampling → record → tools → follow-up/completed；不依赖 Ink、文件存储或权限实现。
- `src/agent/react-agent.ts`：现有入口兼容适配器，负责 Responses 请求、指令、工具权限、工具路由、usage、恢复 context 和持久化 callback。
- `src/agent/repair-context.ts`：旧不完整工具上下文修复。

每次请求成功后先持久化响应，再执行工具；每个结果立即持久化后才进入下一工具。取消时为剩余调用记录 cancelled，之后抛出取消错误。持久化失败停止任务，不能在调用记录保存失败后执行副作用。

只要存在 function call 或端点明确返回 `end_turn: false` 就继续采样。没有工具且没有明确继续信号时结束；兼容不提供 `end_turn` 的端点。非 completed 状态返回错误，不执行其中可能不完整的工具调用。call_id 缺失/重复在持久化前拒绝。

请求层对连接失败、408/409/429/5xx 默认最多重试两次，退避可取消；400/401/403 等不重试。主循环请求关闭 SDK 内部重试，避免重试叠加。仅重试采样，不重跑此前工具。`onPhase` 提供 sampling/tools/completed/cancelled/failed 扩展入口；`ReactAgent` 同实例拒绝并发 turn。

## 明确差异与后续优化

上游是 Rust async runtime、流式 Responses 事件及多服务 Session；本地现在优先使用 Responses SSE，并在兼容端点不提供流式接口时回退到 buffered `create`。没有复制 Codex prompt、UI、账户登录或内部私有服务。

当前未移植：并行工具调度、自动 context compaction、hook、MCP、多 Agent、系统沙箱及完整流中断重试。循环提供 `LoopEvent`、流式文字 delta 和 safe-checkpoint steering：采样中的纠正会停止当前 SSE，工具执行中的纠正在工具结果持久化后生效；未启动的 function call 会写入 `steered` output，保证后续请求上下文完整。Ctrl+C 取消时，已提交但尚未应用的纠正会先写入模型 context，避免遗留到未来轮次。实时增量只属于当前 UI，不写入 JSONL。

自动测试使用模拟 Responses 与现有真实工具回归；不声称已验证真实供应商完整端到端或与 Codex 全功能等价。
