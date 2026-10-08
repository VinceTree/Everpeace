# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 定位。本轮授权交付当前 Memory 修复，展示版本已同步为 0.3.22；功能源码 ea659ef590015299f5150de13e85849ce947053e 已提交、推送，首次 CI 的 Windows 时钟 fixture 故障已修正并重新通过本地门禁，继续核对修正提交的远端结果。

## 本轮范围与授权

用户明确要求提交、推送、更新版本，并禁止更新 Release。展示版本从 0.3.21 调整为 0.3.22，package.json 与双语 README 一致。代码提交标题使用 fix: preserve memory request ownership and idle recovery [skip publish]，不使用 [skip ci]，不创建或推送 tag，不调用付费模型。开始时 main 与 origin/main 同步，基线为 45401588a16f3205bee413fe92a1fbb00294d9c0；git fetch --no-tags 确认 ahead/behind 均为零，目标 v0.3.22 tag 不存在。

本轮交付此前已实现的 Memory 持久请求恢复、手动生命周期、共享实际请求计量和完整任务空闲范围；没有趁交付新增产品实现。完整定位目标仍 active，[PLAN](PLAN.md) 九项剩余验收继续，不把提交和门禁通过视为全部定位完成。后续开发不自动重复升版、提交或推送；付费调用另需明确授权和 task/campaign 数值预算。

## 已交付改动

- capture-jobs.json 的 pending/usageComplete 标记绑定原 running 租约，provider 前先保存 pending，可靠结算后才继续。中断或 unknown 请求不因重启、重排或 controller 重建而自动重发；持续存储故障和资源错误保持可见。
- 手动 Memory 请求由 runtime/TUI 服务持有，取消后保留可靠 usage，原子提交前复核策略与 generation，关闭等待请求后存储。Esc 与操作身份拒绝迟到结果；临时手动 runtime 不消费共享后台队列。
- Memory 与辅助服务使用同一 RequestAccountingScope，实际 provider attempt 只结算一次；准入前拒绝不制造 unknown，旧资源错误不重复计量，真正未知用量继续 sticky。后台认领后和 pending 写入后复核实时策略。
- Memory 的完整任务暂停接到现有 Agent/runner，Plan 审批、宿主验证、修复和 Goal 续跑期间不启动后台请求。任务退出及 runtime 重建重新计满五分钟，无新材料或失败/停止也恢复可靠旧队列；异步开始返回后检查 Agent 是否已关闭，防止迟到 TaskProgress。

生产回归和失败证据分别保存于 [恢复交接](archive/HANDOFF_MEMORY_CAPTURE_RECOVERY.md)、[手动生命周期](archive/HANDOFF_MEMORY_MANUAL_LIFECYCLE.md)、[共享计量](archive/HANDOFF_MEMORY_SHARED_ACCOUNTING.md) 和 [空闲范围](archive/HANDOFF_MEMORY_IDLE_LIFECYCLE.md)。代码和测试定位见 [MEMORY](architecture/MEMORY.md) 与 [PROJECT_MAP](architecture/PROJECT_MAP.md)。此前交付记录见 [请求所有权](archive/HANDOFF_REQUEST_OWNERSHIP_DELIVERY.md)，旧 CI 不代替本轮验证。

## 本轮交付门禁

升版后重新发现实际 manifest 并串行执行：typecheck 通过 → 实际没有 lint script → test 1054 项、1051 通过、0 失败、0 cancelled、3 项平台跳过（60,854.2129 ms）→ build 通过。构建前确认 dist 的绝对路径及父目录在本工作区。最新日志位于宿主临时目录：everpeace-memory-delivery-0.3.22-{typecheck,test,build}-ci-fix-20261009.log，不使用开发阶段旧门禁冒充本次验证。

测试包含真实生产 factory/runner、Session 持久化、实际 SDK fake fetch、隔离 Git 项目、进程中断和 Ink 回归；它们不调用真实付费模型，也不替代 Windows Terminal 手工体验或真实模型质量验收。

## 交付中 CI 修正

功能提交 ea659ef 的 [首次 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37858600081) 中 Linux 通过，Windows 在 overdue reliable running 回归期间出现 cancelledByParent，后续同文件测试也被取消。读取实际 GitHub 注释后定位到 fixture 同时冻结所有 setTimeout：Windows 原子 rename 的 10–160ms backoff 和锁重试因此不能完成，finally 的关闭等待也停滞。独立负向用 10ms timer 复现 false 而预期 true（everpeace-memory-delivery-clock-retry-baseline-20261009.log）。

修正仅控制五分钟及以上 idle/租约 timer，存储 backoff 和锁心跳继续使用真实 timer；清理仍等待真正持久化，不削弱生产策略、业务断言或 CI。新增真实 Windows store 的一次 EBUSY 注入，断言第二次 rename 成功、条目落盘且 idle Date 未推进。首次扩展定向 15/15 通过；补齐严格的 Node/DOM timer handle 类型与真实 Windows 回归后，最终完整门禁 1051 通过。设计操作说明回填 [DEVELOPMENT](DEVELOPMENT.md)。修正后的远端 CI 另行核对，首次失败不能被描述为通过。

## 远端验证与保护状态

Release workflow 的 branch-push job 条件明确排除 head_commit.message 包含 [skip publish] 的提交；Test workflow 独立运行 Windows/Linux Node 22。本轮已通过既有 Git 凭据只读取得 27 个 Release 的 ID/tag/updated_at/draft/prerelease/asset ID 与更新时间基线，目标 Release 不存在；认证内容未输出或落盘。基线为宿主临时目录 everpeace-0.3.22-release-baseline-20261009.json。功能提交的 [Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37858600246) 和 Publish version job 均实际 skipped；远端 main 精确匹配 ea659ef，27 个 Release 全基线不变，无 v0.3.22 tag。修正提交与最后交接提交随后继续核对准确 HEAD 的 CI 和同一 Release 基线。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 全部保留，不 stage、删除或纳入交付。首次功能提交仅包含 21 份明确 tracked 文件和 12 份本次开发的测试/fixture/交接归档，共 33 份；CI 修正只更新空闲 fixture、开发说明和交接。pnpm-lock.yaml 无依赖变更。

## 后续范围

按 PLAN 继续核对 production factory/辅助所有者关闭期间的准入、其他前台操作与 Memory 空闲关系，以及 Session/公开 exec、SDK 的剩余要求。当前交付不宣称所有资源或前台表面已验收。最终 candidate 的 preflight/fixture proof、独立评分与付费计划需按最终代码重做。

GitHub push 另报告一项 [MCP SDK 高危依赖告警](https://github.com/VinceTree/Everpeace/security/dependabot/1)：GHSA-6qxp-vccf-f47h，OAuth client 可能把凭据发送给 MCP server 选择的 authorization server。只读核对时为 open，关联 pnpm-lock.yaml 中的 @modelcontextprotocol/sdk；本轮没有依赖升级。后续功能完善需要核对和处理，当前交付不宣称安全告警已解决。

Windows LSP direct-socket denial probe 尚未通过，保持失败关闭，不削弱隔离或回退宿主。任意 detached 后代、其他原生平台和真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍需独立验收。
