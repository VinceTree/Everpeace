# 验证证据、Session 隐私与任务性能

后续增强、changed-line/独立来源、Memory 审查 CLI、二进制事务及真实评测状态见 [本轮验收](../implementation/REPORT.md)。

问题 20–30 的实现契约集中在本页；当前候选、实际门禁和未完成证据只在 [HANDOFF](../HANDOFF.md) 维护。模型效果尚未实测，不改变三轮生产修复上限、默认单 Agent、权限或请求准入。

## 验证证据

[verification-evidence](../../src/workflow/verification-evidence.ts) 为现有 workflow suite 增加可选摘要，区分未发现检查、静态/构建、测试入口；TAP/JUnit 的报告数量不证明执行过断言，断言字段保持 unknown。只读取固定、有界、非链接路径的报告，并比较运行前后文件身份及摘要；workspace revision 变化或不可确认时撤销解释性证据。旧 Session 不推断数量、覆盖或独立验证。

LCOV/Istanbul 表示改动**文件**是否出现执行命中，不证明改动行或业务场景覆盖。项目自带报告属于项目证据，即使模型新增测试也不是独立验证。`modifiedTests` 表示测试路径发生改动，不伪造作者身份。`/verify` 属于 supplemental_check；独立功能通过只能由评测宿主控制的外置评分器建立。保留 verified 结算语义，不因 unknown 覆盖自动失败；无测试、零测试或明确未覆盖会建议针对性测试。

入口与回归：[verifier](../../src/workflow/verifier.ts)、[workflow runtime](../../src/workflow/runtime.ts)、[evidence tests](../../tests/unit/workflow/verification-evidence.test.ts)。

## Session 保留、扫描、导出

`/privacy` 是本地管理窗口，不请求模型。CLI `everpeace privacy status` 展示真实位置与独立存储，`preview <forever|days>` 生成十分钟、单次消费的预览 token；`configure <token>` 确认保留策略，`cleanup <token>` 按当前策略执行。默认永久保留。TUI 使用 `/privacy retention forever|30|90|180|<days>` 和 `/privacy cleanup`，默认 Cancel。

到期按最后持久活动计算，启动/切换空闲 Session 时每天最多自动清理一次。活动租约跨进程保活；同一 SessionStore 的 TUI 与 Agent 引用共享租约，全部安全关闭后才写 closed。自动清理排除活动、未知归属、损坏/无法读取的记录和保留团队。成员 Session 在根发布团队引用前持久标记归属；这些标记保守保留，不因成员已完成就自动删除。删除在串行队列、Session 锁和活动租约内重查预览，清理所属附件并使缓存失效；部分失败报告 failed，可人工重新预览重试。旧会话没有安全关闭标记，自动清理跳过；用户可在原有 `/resume` 管理入口明确删除。

Session 模型协议及执行参数不盲目改写；持久上下文可能包含用户文本、源码、客户数据、工具正文及 reasoning。`scan <id>`/`/privacy scan` 使用共用 [sensitive-scan](../../src/util/sensitive-scan.ts)，覆盖常见 token、Bearer、配置值、URL 凭据、JSON 转义及多行/截断私钥；结果仅有规则计数，无命中原文。有界扫描触及限额明确 complete=false，不能证明没有其他敏感业务信息。

默认 `export <id> <new-file>` / `/privacy export <new-file>` 只导出白名单诊断：无对话、源码、绝对路径、正文、参数或 reasoning。`/privacy export-conversation <new-file>` 是额外的显式选项，预览脱敏对话后确认，并重查 Session 指纹；正文工具输出与附件默认不包含。原子创建新文件，拒绝覆盖和链接父目录。导出及 UI 不承诺识别全部客户敏感信息。删除是逻辑删除，不擦除备份、磁盘残留或第三方副本；Memory、凭据、全局输入历史、团队产物和用户导出是独立存储。

入口与回归：[SessionPrivacy](../../src/storage/session-privacy.ts)、[activity leases](../../src/storage/session-activity.ts)、[CLI](../../src/cli/commands/privacy.ts)、[privacy tests](../../tests/unit/storage/session-privacy.test.ts)、[TUI](../../tests/unit/tui/app.test.tsx)。

## Memory 审查

项目经验创建或人工续期后 90 天到期，暂停召回；普通使用和自动去重/合并不续期。用户明确长期偏好没有自动到期。旧项目经验由有效 createdAt 起算；时间无法确认则待审。confidence 是提取置信度，不是事实准确率。合并保留有界来源集合，纠正保存 supersedes/superseded 关系。

`/memory list` 后可 `inspect <scope> <id>` 查看来源、适用条件、到期和 revision；`renew`、`disable`、`delete` 和 `correct <scope> <id> {"lesson":"...","applyWhen":"..."}` 均预览后确认。锁内重查 revision，提升 generation、取消旧后台操作并使缓存失效。来源 Session 删除时只显示 unavailable，不扩大搜索。每个实际 provider 请求（包括流式回退/恢复/重试）重新加载有效 Memory，不修改已经冻结的请求对象。

回归：[expiry](../../tests/unit/memory/expiry.test.ts)、[request validity](../../tests/unit/agent/memory-request-validity.test.ts)。这些测试证明生命周期，不能证明真实模型提取的经验普遍正确。

## 子目录、Worktree 与状态所有权

团队记录区分 gitRoot、授权 source/workspaceRoot、workspacePrefix 和成员 workspace；快照只枚举、读取、复制授权子树。已有 linked worktree 可用，共享 Git 元数据及其他 worktree 保持保护。子模块、链接逃逸、不完整快照、二进制整合及超限仍拒绝。原始字节、并发版本、取消 ownership、冲突和原工作区最终验证继续保留。成员原生隔离依旧必须实机证明，hosted skip 或路径 fixture 不代替。

ReactAgent 保留任务准入、steering、取消、审批和最终清理；[ModelRequestRuntime](../../src/agent/model-request-runtime.ts)/[ResponseStreamConsumer](../../src/agent/response-stream-consumer.ts) 管理请求传输/恢复；[AgentContextRuntime](../../src/agent/context-runtime.ts) 管理上下文 revision 与持久压缩；[FileToolRuntime](../../src/agent/file-tool-runtime.ts) 管理当前进程文件观察、搜索与审查。接口只提供必要回调，不传整个 Agent。完整响应先落盘、结果按序提交及 sticky unknown/清理失败语义不变。

回归：[workspace layout](../../tests/unit/team/workspace-layout.test.ts)、[subsystems](../../tests/unit/agent/subsystems.test.ts)、既有 ReactAgent/stream/team 集成测试。

## 网页正文与性能

[html-content](../../src/tools/html-content.ts) 有界 DOM 遍历优先 main/article，回退去噪 body；保留标题、列表、引用、原始代码块、表格逐行单元格和来源链接。忽略 base，以最终 URL 解析相对链接；排除脚本/样式/表单/显式隐藏内容，不执行 JS。返回契约保留，并添加 extraction/extractionTruncated 解释，超限明确截断。

固定 [web-content 语料](../../tests/fixtures/web-content/manifest.json) 是有许可的项目技术文档渲染快照，外层页面结构明确是合成；[独立对照](../../tests/fixtures/prove-web-content.ts) 对人工核对的正文块与无关外壳算 F1，逐字核对代码和链接。该语料不是外部网站或全网准确度评测。

`/perf`、SDK 的可选 performance_report 事件和 JSONL 报告复用 [TaskPerformance](../../src/performance/task-report.ts)、PerformanceTrace 及请求账本。包括失败/取消/重试、压缩、辅助请求和成员请求；请求身份去重，任务 generation 阻止晚到结算迁移到新任务。价格与性能均按 input/output 计量，不重复加入 reasoning。

报告区分墙钟、累计并发/嵌套阶段，沙箱启动包含在工具/验证耗时中，不能把各阶段相加当墙钟。首模型事件/文字是从任务开始算的里程碑，不冒充每请求首 token 延迟。缺测阶段 unavailable，未知用量保持 incomplete。仅固定标签、次数、时间和计量落盘；重复调用用任务随机 HMAC 内存集合，文件版本变化不视为重复读取，不保存命令、路径、参数或摘要。前三耗时/Token 来源是观测，不自动修改配置。

## 安全属性与对照实验

固定 fast-check 开发依赖；PR 纯属性至少 1000 用例、状态序列至少 100，日检扩大十倍。七类不变量含 DNS 绑定、路径、目录替换、权限 revision、取消/持久化失败、MCP 信任与资源关闭；异步所有者等待清理，执行次数不足或关闭失败不能通过。[重放配置](https://fast-check.dev/docs/api/interfaces/Parameters/) 与 [propertyCheck](../../tests/fixtures/property-check.ts) 记录 seed、缩减反例和 replayPath，反例仅合成数据。Windows 原生仍单独验收。

[对照准备](../../tests/fixtures/prepare-controlled-experiments.ts) 复用 campaign/目录/外置评分器，为 repair 和 single/team 各准备独立的 19 任务、每臂三次、交错配对方案，并冻结 source/build/evaluation 身份。`repairStrategy` 只在 benchmark 准入；候选策略对环境/授权直接停止、type/lint 最多两轮，其他最多三轮；相同诊断且 revision 未变提前停止。团队对照根加两个同模型成员，两臂保持其他设置相同。草案预算与 invalid 端点不是调用授权。

`controlled-comparison.json` 保留计划分母、首次通过、耗时、所有请求/Token、未知计量、重复读取、冲突和人工介入。单 Agent 无团队重复指标时为 unknown。**任务专属错误修改分类仍需独立回归/范围评分证据；未提供时 errorModificationRate=null，eligibleForDefault=false**，不能从 Agent 自评或一次失败推算。离线证明不宣称修复/团队收益；第 21、26 真实效果和 Memory 的真实模型效果保持未完成。
