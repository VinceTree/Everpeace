# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](HANDOFF.md)。第二阶段任务与会话协调的 [计划](archive/PLAN_APPLICATION_COORDINATION.md) 和 [交接](archive/HANDOFF_APPLICATION_COORDINATION.md) 已归档。

## 第三阶段首轮：逻辑 step 工具目录

本轮处理 Agent 引擎中的一个明确问题：ReactAgent 分别保存广告工具定义、可调用名称与 MCP binding，并在另一处判定并发资格。这些派生状态属于同一逻辑 step，提取为独立工具目录，供请求准备、工具准入与并发调度读取。

1. 工具目录按当前模式和可用宿主能力构建，保持既有工具集合及顺序；深复制并冻结定义和 MCP metadata。
2. 同一个目录拥有名称准入、MCP binding 和保守并发资格，未知工具与 MCP annotations 不获得本地并发能力。
3. 所有 step 来源准备完毕后发布目录；普通采样 retry 复用，follow-up／steering 刷新，turn 收尾丢弃，不从 Session 恢复。
4. 实时权限、审批、取消／预算、文件观察、durable record 和实际工具执行留在现有路径；不提取第二套 dispatcher、loop、runner 或存储。
5. 保持公共 CLI/SDK 参数、Session schema、请求工具定义及用户流程；使用离线 fake provider 验收。

- [x] 提取工具目录并接入请求、工具准入、MCP binding 与并发资格。
- [x] 覆盖 Plan 集合、可选能力、嵌套定义隔离、binding 隔离、未知工具与并发屏障。
- [x] 保留并通过重试／follow-up、steering、权限收紧、取消、持久化及生产入口回归。
- [x] 更新运行时、loop、项目地图、架构决策及交接。
- [x] 串行执行实际 typecheck → lint → test → build，首败停止；记录 lint 缺项，检查差异和文档链接。
- [x] 按用户授权更新展示版本、提交并推送 main；Windows／Linux Test CI 通过，Release workflow 实际跳过、Release 未变化，未推送 tag；证据见交接。

## 后续顺序

Agent 引擎的其余请求投影／上下文职责在下一轮按具体问题细化；本轮不一并拆分整个 ReactAgent。之后依次推进工具与进程、存储与恢复、终端交互，每轮完成回归和交接后再进入下一项。整体框架见 [PROJECT_MAP](architecture/PROJECT_MAP.md#整体分层与状态归属)。

## 独立验收

真实 Windows Terminal 手工验收仍单独 pending，自动测试不能替代；不调用真实模型，不创建或更新 Release，不推送 tag，保留用户所有原有未跟踪内容。
