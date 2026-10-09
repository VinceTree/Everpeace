# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 定位。本轮授权交付当前 Memory 修复，展示版本已同步为 0.3.22。交付验证中追加 capture job 读取与原子替换串行修正，工作树基于 b0d5c41fece572e910cd07c864bf30358ff05777，最新完整本地门禁 1052 项通过。最终提交 HEAD、准确 SHA 的远端 CI 和 Release 验收以本文件所列最终收据为准。

## 本轮范围与授权

用户明确要求提交、推送、更新版本，并禁止更新 Release。展示版本从 0.3.21 调整为 0.3.22，package.json 与双语 README 一致。代码提交标题使用 fix: preserve memory request ownership and idle recovery [skip publish]，不使用 [skip ci]，不创建或推送 tag，不调用付费模型。开始时 main 与 origin/main 同步，基线为 45401588a16f3205bee413fe92a1fbb00294d9c0；git fetch --no-tags 确认 ahead/behind 均为零，目标 v0.3.22 tag 不存在。

本轮交付此前已实现的 Memory 持久请求恢复、手动生命周期、共享实际请求计量和完整任务空闲范围；交付验证发现 Windows 存储替换与同 store 状态读取竞争，追加聚焦修复。完整定位目标仍 active，[PLAN](PLAN.md) 九项剩余验收继续，不把提交和门禁通过视为全部定位完成。后续开发不自动重复升版、提交或推送；付费调用另需明确授权和 task/campaign 数值预算。

## 已交付改动

- capture-jobs.json 的 pending/usageComplete 标记绑定原 running 租约，provider 前先保存 pending，可靠结算后才继续。中断或 unknown 请求不因重启、重排或 controller 重建而自动重发；持续存储故障和资源错误保持可见。
- 手动 Memory 请求由 runtime/TUI 服务持有，取消后保留可靠 usage，原子提交前复核策略与 generation，关闭等待请求后存储。Esc 与操作身份拒绝迟到结果；临时手动 runtime 不消费共享后台队列。
- Memory 与辅助服务使用同一 RequestAccountingScope，实际 provider attempt 只结算一次；准入前拒绝不制造 unknown，旧资源错误不重复计量，真正未知用量继续 sticky。后台认领后和 pending 写入后复核实时策略。
- Memory 的完整任务暂停接到现有 Agent/runner，Plan 审批、宿主验证、修复和 Goal 续跑期间不启动后台请求。任务退出及 runtime 重建重新计满五分钟，无新材料或失败/停止也恢复可靠旧队列；异步开始返回后检查 Agent 是否已关闭，防止迟到 TaskProgress。
- 同一 LearnedMemoryStore 的 capture job 读取和写入共用每路径队列，读取等待原子替换及锁释放后取得最新持久状态，避免本实例状态轮询与 Windows 替换竞争。存储格式、跨进程写锁、有界 rename 重试和持续故障关闭语义保留。

生产回归和失败证据分别保存于 [恢复交接](archive/HANDOFF_MEMORY_CAPTURE_RECOVERY.md)、[手动生命周期](archive/HANDOFF_MEMORY_MANUAL_LIFECYCLE.md)、[共享计量](archive/HANDOFF_MEMORY_SHARED_ACCOUNTING.md) 和 [空闲范围](archive/HANDOFF_MEMORY_IDLE_LIFECYCLE.md)。代码和测试定位见 [MEMORY](architecture/MEMORY.md) 与 [PROJECT_MAP](architecture/PROJECT_MAP.md)。此前交付记录见 [请求所有权](archive/HANDOFF_REQUEST_OWNERSHIP_DELIVERY.md)，旧 CI 不代替本轮验证。

## 本轮交付门禁

读取串行修正后重新发现实际 manifest 并串行执行：typecheck 通过 → 实际没有 lint script → test 1055 项、1052 通过、0 失败、0 cancelled、3 项平台跳过（73,495.4813 ms）→ build 通过。构建前确认 dist 的绝对路径及父目录在本工作区且不是 symlink。最新日志位于宿主临时目录：everpeace-memory-delivery-0.3.22-{typecheck,test,build}-serialized-read-verified-20261009.log，不使用开发阶段旧门禁冒充本次验证。

测试包含真实生产 factory/runner、Session 持久化、实际 SDK fake fetch、隔离 Git 项目、进程中断和 Ink 回归；它们不调用真实付费模型，也不替代 Windows Terminal 手工体验或真实模型质量验收。

## 交付中 CI 修正

功能提交 ea659ef 的 [首次 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37858600081) 中 Linux 通过，Windows 在 overdue reliable running 回归期间出现 cancelledByParent，后续同文件测试也被取消。读取实际 GitHub 注释后定位到 fixture 同时冻结所有 setTimeout：Windows 原子 rename 的 10–160ms backoff 和锁重试因此不能完成，finally 的关闭等待也停滞。独立负向用 10ms timer 复现 false 而预期 true（everpeace-memory-delivery-clock-retry-baseline-20261009.log）。

修正仅控制五分钟及以上 idle/租约 timer，存储 backoff 和锁心跳继续使用真实 timer；清理仍等待真正持久化，不削弱生产策略、业务断言或 CI。新增真实 Windows store 的一次 EBUSY 注入，断言第二次 rename 成功、条目落盘且 idle Date 未推进。首次扩展定向 15/15 通过；补齐严格的 Node/DOM timer handle 类型与真实 Windows 回归后完整门禁 1051 通过。设计操作说明回填 [DEVELOPMENT](DEVELOPMENT.md)。

时钟修正提交 a9d9168e01ddb823a4ee8261183080b19724e569 的 [第二次 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37859761531) 中 Linux 通过，Windows 的空闲生命周期回归已通过，但两项既有测试失败：验证命令超时测试的两秒任务 deadline 在 taskkill 清理中到期，使 cancelled 同为 true；Memory 队列保存依赖两次写入在 40ms idle 窗口内完成，消费提前启动后 queued 只剩一项。分别直接测试 verification deadline（任务取消/任务超时仍有独立回归），以及 beginTask 显式暂停保存两轮内容、释放后由新 runtime 消费。队列同时断言持久化的两项 queued、旧 runtime 零请求、新 runtime 恰好两次请求、条目和 jobs 结算，finally 始终清理 runtime。没有改变产品 timeout、Memory 策略或 CI 门禁，两次历史失败均保留为失败证据。

读取串行修正之前，源码与测试提交 00369977c84bc50df9923bb5b1494130e0bebe53 的 [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37860517447) 中 Windows/Linux Node 22 两项 job 全部 success；typecheck、test、build、whitespace 步骤实际通过。旧源码收据保存在宿主临时目录 everpeace-0.3.22-ci-races-20261009.json，不代替读取串行修正后的证据。

交接提交 b0d5c41 的 [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37871838632) 虽只改文档，Windows 首次执行仍在 Plan approve 等待 queued 时失败。仅重跑失败 job 后，该 Plan 回归通过，但 legacy queued 恢复与完整验证/Goal 空闲回归失败；读取完整日志确认 capture-jobs.json 原子 rename 为 EPERM。该文件当时的 loadJobs 在每路径写队列之外，回归高频轮询会与替换重叠。首次和第二次失败注释、完整日志分别保存在宿主临时目录 everpeace-0.3.22-final-ci-failure-20261009.json、everpeace-0.3.22-final-ci-failure-attempt2-20261009.json、everpeace-0.3.22-final-ci-attempt2-windows.log；不把重跑失败描述为成功。

新增受控原子替换回归：写入暂停在真实 rename 前，立即发起读取，旧实现实际触发替换期间的 read（true，而预期 false），失败日志为 everpeace-memory-job-read-replacement-baseline-20261009.log。修正仅让 loadJobs 复用现有每路径队列，等待替换与锁释放后返回最新条目；Memory 恢复与空闲生命周期定向 46/46 通过，日志为 everpeace-memory-job-read-replacement-positive-20261009.log。新增条目的 outcome 字面量首次类型检查失败后修正为 verified，实际重新启动完整门禁，最终 1052 通过。没有跳过业务断言、增大重试时限或放宽存储故障策略。

## 远端验证与保护状态

Release workflow 的 branch-push job 条件明确排除 head_commit.message 包含 [skip publish] 的提交；Test workflow 独立运行 Windows/Linux Node 22。本轮通过既有 Git 凭据只读取得 27 个 Release 的 ID/tag/updated_at/draft/prerelease/asset ID 与更新时间基线，目标 Release 不存在；认证内容未输出或落盘。基线为宿主临时目录 everpeace-0.3.22-release-baseline-20261009.json。功能提交的 [Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37858600246) 和 Publish version job 均实际 skipped；在 0036997 与 b0d5c41 的只读验收时远端 main 均匹配对应 HEAD，27 个 Release 的全基线不变，无 v0.3.22 tag。

最后读取串行修正涉及 Memory store、受控回归、Memory 专题和交接，继续使用 [skip publish]。交付时核对最终 HEAD 的远端 main、准确 SHA 的两平台 Test CI 与同一 Release 基线；最终收据保存于宿主临时目录 everpeace-0.3.22-final-remote-verification-20261009.json，历史失败收据独立保留，不以旧成功覆盖新结果。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 全部保留，不 stage、删除或纳入交付。首次功能提交仅包含 21 份明确 tracked 文件和 12 份本次开发的测试/fixture/交接归档，共 33 份；后续交付修正累计涉及四份测试 fixture、Memory store、开发说明、Memory 专题和交接，本轮仍为 36 份文件。pnpm-lock.yaml 无依赖变更。

## 后续范围

按 PLAN 继续核对 production factory/辅助所有者关闭期间的准入、其他前台操作与 Memory 空闲关系，以及 Session/公开 exec、SDK 的剩余要求。当前交付不宣称所有资源或前台表面已验收。最终 candidate 的 preflight/fixture proof、独立评分与付费计划需按最终代码重做。

GitHub push 另报告一项 [MCP SDK 高危依赖告警](https://github.com/VinceTree/Everpeace/security/dependabot/1)：GHSA-6qxp-vccf-f47h，OAuth client 可能把凭据发送给 MCP server 选择的 authorization server。只读核对时为 open，关联 pnpm-lock.yaml 中的 @modelcontextprotocol/sdk；本轮没有依赖升级。后续功能完善需要核对和处理，当前交付不宣称安全告警已解决。

Windows LSP direct-socket denial probe 尚未通过，保持失败关闭，不削弱隔离或回退宿主。任意 detached 后代、其他原生平台和真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍需独立验收。
