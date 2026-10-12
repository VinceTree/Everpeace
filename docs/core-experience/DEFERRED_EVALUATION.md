# Deferred real-model evidence / 暂停的真实模型评测

The user explicitly paused live tests. No additional model preflight, translation, benchmark or paid request is authorized while that deferral applies. Current preparation reads neither credentials nor model configuration.

用户明确暂停真实模型测试。在暂停期间不执行模型预检、模型翻译、评测或其他付费请求；当前准备脚本不读取凭据或模型配置。

The [full plan](reports/plan.json) preserves 150 slots: five scenarios, three task definitions each, two versions, five repetitions. Pair order and pair sequence use fixed seed `20261012`; a pair's two arms execute sequentially, with one pair at a time. Model and total token caps are explicitly `null`. Timeouts, cancellation and no-progress stopping remain required when execution resumes.

[完整计划](reports/plan.json) 保存 150 个位置：五类场景各三项定义、两版本、每组五次。固定种子随机化配对内顺序与配对次序，一次仅运行一对；Token 总上限显式为 `null`。恢复执行后仍须超时、取消及无进展终止。

| Scenario | Planned | Executed | Current conclusion |
| --- | --- | --- | --- |
| [Protected modifications](reports/protected_modification.json) | 30 | 0 | Unknown |
| [DeepSeek long tasks](reports/deepseek_long_task.json) | 30 | 0 | Unknown |
| [Cancellation and recovery](reports/cancellation_recovery.json) | 30 | 0 | Unknown |
| [Verification and repair](reports/verification_repair.json) | 30 | 0 | Unknown |
| [Uncommitted edits](reports/uncommitted_preservation.json) | 30 | 0 | Unknown |

These are frozen **definitions**, not frozen executable task fixtures. Before live execution: create isolated acceptance fixtures separate from development examples; bind source, host-owned acceptance/regression entry points and allowed modifications by digests; prove the reference and negative controls offline; freeze the candidate commit; recover a usable `deepseek-flash` registration through the existing auth layer; then freeze the selected model, endpoint and request settings after successful preflight. Cancellation scenarios additionally need paired cancellation/resume legs with complete aggregate accounting and resource receipts.

这里只冻结了任务定义，尚未冻结可执行 fixture。恢复实测前须准备独立验收任务，绑定源码、宿主只读验收/回归入口、允许改动范围及摘要，离线证明参考修复和失败样本；再冻结候选，并通过认证层恢复可用的 deepseek-flash 配置。预检成功后固定模型、端点和参数。取消场景还须记录取消与恢复两段的完整用量和资源收据。

The historical baseline stays at `1e805410b713ab90ee09040fced7137416186d0c`. Every planned failure, timeout, intervention and skip remains in the denominator. Missing usage or price cannot become zero or complete cost. Safety claims require no unauthorized writes, data loss or unresolved cleanup; efficiency claims additionally require non-decreasing quality, no increased erroneous modifications/interventions, at least 10% improvement in tokens or wall time and no worsening of the other measure, with paired uncertainty reported.

历史基线保持固定。失败、超时、介入和跳过均保留在分母，用量或价格缺失不能记作零或完整费用。安全宣传须无越权修改、数据丢失和未解决清理失败；效率宣传另须质量不下降、错误修改与介入不增加，Token 或耗时至少改善 10%，另一项不恶化，并报告配对不确定性。

To reproduce planning without a provider call, run `pnpm benchmark:product-plan <new-empty-output-directory>`. Existing files are not overwritten. This command does not execute fixtures or demonstrate product benefit. The fixture/harness freezing work and the 150 live runs remain deferred acceptance items.

使用该命令可以离线复现计划，已有文件不覆盖。它不会执行任务或证明产品收益；fixture/harness 冻结和真实运行仍属后续验收。
