# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](HANDOFF.md)。第三阶段首轮的 [计划](archive/PLAN_STEP_TOOL_CATALOG.md) 和 [交接](archive/HANDOFF_STEP_TOOL_CATALOG.md) 已归档。

## 第四阶段首轮：后台任务准入与结算

本轮处理后台任务生命周期的一个明确问题：执行器在登记任务之前调用，同步启动异常不能走正常终态路径，清理期间未阻止新启动，终态任务还接受迟到输出。由现有 BackgroundJobManager 管理启动占位、取消与完整结算，不建立第二套进程或任务管理器。

1. 检查预先取消和管理器可用状态；先登记任务及完成 promise，再调用既有执行器，保留立即取得运行预览的能力。
2. 同步抛错和异步失败进入同一失败终态，解绑父信号、发布一次完成通知和执行保留裁剪；不自动重试命令。
3. stop／wait 等待登记任务的完成 promise；stopAll 期间关闭新启动准入，重叠清理全部完成后恢复，dispose 永久关闭启动。
4. 终态快照与时间、结果一起发布；完成以后忽略迟到预览，保留取消清理期间的有效部分输出。
5. 继续使用现有 shell、原生 sandbox、实时权限、task generation、文件观察和 coding runner；不改变公共 CLI/SDK 参数、Session schema、工具定义或正常用户流程。

- [x] 覆盖同步启动失败、预先取消、重入启动限额与结果快照隔离。
- [x] 覆盖重复 stop／stopAll／dispose、清理期间拒绝启动和迟到输出。
- [x] 接入既有 Agent 通知与 runner 收束回归，验证结算不越过未结束任务。
- [x] 更新工具／运行时契约、架构决策、地图、开发指南和交接。
- [x] 串行执行实际 typecheck → lint → test → build，首败停止；记录 lint 缺项，检查差异与文档链接。
- [x] 按新增授权更新版本、重新执行交付门禁、提交并推送 main；双平台 Test CI 通过，Release workflow 实际跳过、Release 未变，未推送 tag；证据见交接。

## 后续顺序

第四阶段后续只在具体问题细化后继续工具／进程的错误、资源和取消路径；随后依次推进存储与恢复、终端交互。第三阶段其余请求投影／上下文整理保留为后续独立问题，不在本轮混合实施。整体框架见 [PROJECT_MAP](architecture/PROJECT_MAP.md#整体分层与状态归属)。

## 独立验收

真实 Windows Terminal 手工验收仍单独 pending，自动测试不能替代；不调用真实模型。用户已明确授权更新版本、提交并推送，提交均带 `[skip publish]`，不创建或更新 Release，不推送 tag，保留用户所有原有未跟踪内容。
