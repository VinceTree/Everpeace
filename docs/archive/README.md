# 历史归档

- [Memory 串行读取交付](HANDOFF_MEMORY_SERIALIZED_READ_DELIVERY.md)：本轮开始前的完整交接、CI 修正与远端验收。

这些文件保存整理前的执行记录与计划，**不代表当前功能或未完成任务**。旧记录中的“当前”“下一步”“已通过”等均只描述当时状态；不提供付费、发布或其他操作授权。

- [历史交接](HANDOFF_HISTORY.md)：整理前完整交接记录。
- [历史计划](PLAN_HISTORY.md)：整理前累计的计划与阶段说明。
- [项目地图与受控编辑交接](HANDOFF_PROJECT_MAP.md)、[对应计划](PLAN_PROJECT_MAP.md)：Plan 优化前一轮的实现、交付及验证记录。
- [Plan 修订与显式执行交接](HANDOFF_PLAN_EXECUTION.md)、[对应计划](PLAN_PLAN_EXECUTION.md)：批准后等待、手动执行、离线回归和授权交付记录。
- [整体框架与验证基线交接](HANDOFF_FRAMEWORK_BASELINE.md)、[对应计划](PLAN_FRAMEWORK_BASELINE.md)：完整 TSX 类型覆盖、依赖边界与架构记录，以及第一阶段交付证据。
- [任务与会话协调交接](HANDOFF_APPLICATION_COORDINATION.md)、[对应计划](PLAN_APPLICATION_COORDINATION.md)：应用协调状态提取、TUI 竞态、资源清理与跨平台验收记录。
- [Agent 工具目录交接](HANDOFF_STEP_TOOL_CATALOG.md)、[对应计划](PLAN_STEP_TOOL_CATALOG.md)：逻辑 step 广告／准入／binding 与并发归属，以及离线和交付验收记录。
- [后台任务生命周期交接](HANDOFF_BACKGROUND_JOB_LIFECYCLE.md)、[对应计划](PLAN_BACKGROUND_JOB_LIFECYCLE.md)：登记／准入、原子终态、重复清理与迟到输出，以及第四阶段离线和交付验收记录。
- [Session 搜索快照交接](HANDOFF_SESSION_SEARCH_SNAPSHOTS.md)、[对应计划](PLAN_SESSION_SEARCH_SNAPSHOTS.md)：返回状态隔离、缓存成本、picker／恢复回归，以及第五阶段离线和交付验收记录。
- [Composer 生命周期交接](HANDOFF_COMPOSER_LIFECYCLE.md)、[对应计划](PLAN_COMPOSER_LIFECYCLE.md)：重复提交、新草稿保护、输入订阅回归与第六阶段交付记录。

- [共享进程清理交接](HANDOFF_PROCESS_LIFECYCLE.md)：launcher、宿主 Bash 与评测 wrappers 的严格清理等待和授权交付证据。
- [导航与读取进程清理交接](HANDOFF_READ_PROCESS_OWNERSHIP.md)：duplex、搜索、项目地图、导航和 Skill Git 的清理与交付记录。
- [模型流资源清理交接](HANDOFF_MODEL_STREAM_OWNERSHIP.md)：iterator、恢复控制器、SDK body 取消、可靠计量及失败结算证据。
- [逐次请求计量交付](HANDOFF_REQUEST_SETTLEMENT_DELIVERY.md)：恢复、重试、压缩的实际 attempt 计量与授权提交、CI、跳过 Release 的核对记录。
- [手动压缩与请求所有权交付](HANDOFF_REQUEST_OWNERSHIP_DELIVERY.md)：Goal 边界、辅助准入、Memory 重试与关闭等待，以及授权交付的真实 CI 和 Release 核对记录。
- [Memory 持久请求恢复交接](HANDOFF_MEMORY_CAPTURE_RECOVERY.md)：请求 pending/usage 标记、租约绑定、真实进程中断恢复与持续存储故障的离线验证记录。
- [手动 Memory 生命周期交接](HANDOFF_MEMORY_MANUAL_LIFECYCLE.md)：手动请求、Esc/迟到结果、延迟存储、重复与重入关闭、真实故障的生产及离线 SDK 验证。
- [Memory 共享实际请求计量交接](HANDOFF_MEMORY_SHARED_ACCOUNTING.md)：Memory/辅助 scope、可靠取消、准入前零请求、旧资源错误和异步认领策略复核的离线验证。
- [Memory 空闲生命周期交接](HANDOFF_MEMORY_IDLE_LIFECYCLE.md)：完整任务/单轮暂停、失败与 Plan 退出的旧队列恢复、重启重新计时和异步开始关闭竞态的生产回归。

新 Session 默认只读 [当前交接](../HANDOFF.md) 和 [当前计划](../PLAN.md)，仅在追溯历史时查阅这里。归档正文中的旧相对路径以当时 `docs/` 所在位置理解；当前文件定位以 [项目地图](../architecture/PROJECT_MAP.md) 为准。
