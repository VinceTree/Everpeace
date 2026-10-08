# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](HANDOFF.md)。第一阶段整体框架与验证基线的 [计划](archive/PLAN_FRAMEWORK_BASELINE.md) 和 [交接](archive/HANDOFF_FRAMEWORK_BASELINE.md) 已归档。

## 当前里程碑：任务与会话协调

用户授权先交付第一阶段，再开始第二阶段。本轮处理一个明确问题：TUI 入口同时保存会话身份、模式、模型任务占用、批准正文和命令操作身份，相关判断分散。按状态所有者提取 UI 无关的应用协调对象，保留现有 runner、production factory、Session 存储、权限与用户流程。

具体方案与边界：

1. 协调对象管理当前 Session／Agent 身份、模式、模型任务准入／取消、Plan 批准和命令操作身份，TUI 持有单一实例及显示投影。
2. 取消仅发信号，活动任务保持占位直到 runner 清理；句柄身份保护迟到完成，Session 和 Agent 替换推进身份。
3. 初次惰性创建绑定已有任务；新建／恢复／清空／fork 只在宿主成功后替换协调身份，失败保留原状态和批准。
4. 批准复制完整正文；显式执行同步消费并准入，不自动重试或从历史恢复。旧身份、已取消和重复结果不能授权。
5. 存储 I/O、工作目录切换、审批界面、直接 PTY、guidance 与重放仍由适配入口负责；fork 验证债务仍按现有 runner 结算，不新增 schema 或公共参数。

- [x] 提取并接入 ApplicationCoordinator，保持核心依赖边界。
- [x] 增加状态语义回归，覆盖清理占用、单次消费、取消、会话／Agent 替换、迟到与重复结果。
- [x] 增加 TUI 竞争回归：清空期间的 Plan 清理与初次 Session 创建不能进入新会话。
- [x] TUI、Plan、Session、runner、SDK 和生产闭环定向回归通过；原有断言保留。
- [x] 更新项目地图、运行时／状态契约、TUI 结构、决策及交接。
- [x] 最终串行执行实际 typecheck → lint → test → build，记录缺少 lint；差异、文档链接通过。
- [ ] 推送后核对 Windows/Linux Test CI 和 Release 状态，补录交接。

## 后续模块顺序

1. Agent 引擎：先细化请求准备、上下文维护和工具调度的具体内部边界。
2. 工具与进程：错误反馈、资源归属和取消清理，保持权限与文件观察约束。
3. 存储与恢复：Session、usage、历史附件和 Memory 状态边界。
4. 终端交互：输入、审批、resize、重放和真实 Windows Terminal 验收。

以上仅确定顺序，不把路线图视为立即实施授权。每轮细化方案、完成回归和交接后进入下一项，整体框架见 [PROJECT_MAP](architecture/PROJECT_MAP.md#整体分层与状态归属)。

## 独立验收

本轮沿用离线 fake provider，不调用真实模型。真实 Windows Terminal 手工验收仍单独 pending，自动测试不能替代；不创建或更新 Release，不推送 tag，保留用户所有原有未跟踪内容。
