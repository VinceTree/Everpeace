# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。已完成交付见 [请求所有权交接](../archive/HANDOFF_REQUEST_OWNERSHIP_DELIVERY.md)，此前 Memory 持久恢复见 [恢复归档](../archive/HANDOFF_MEMORY_CAPTURE_RECOVERY.md)，手动请求、存储与 Esc/关闭见 [生命周期归档](../archive/HANDOFF_MEMORY_MANUAL_LIFECYCLE.md)。

## 当前基线与授权

main/origin/main 为 45401588a16f3205bee413fe92a1fbb00294d9c0，展示版本 0.3.21，package.json 和双语 README 一致。用户要求的升版、提交和推送已完成，提交带 [skip publish]；该准确 HEAD 的 Windows/Linux Test CI 成功，Release workflow/job skipped，27 个现有 Release 与交付前基线一致，无 v0.3.21 tag。准确远端与 Release 复核见交付归档，不将这些 CI 当作当前未提交源码的验证。

本轮继续完整实现定位目标，完成 Memory/辅助服务共享实际请求的计量与后台认领准入边界。本轮不重复升版、提交、推送或发布，不调用付费模型；live 仍需明确授权及 task/campaign 数值预算。总目标保持 active，不能把当前切片当作 [PLAN](../PLAN.md) 九项完整验收完成。上一 goal turn 是有源码、生产回归和最终完整门禁证据的 progress，不是等待或无进展。

## 本轮缺陷与失败证据

原 production factory/TUI 在 Memory RequestExecutor 外再次使用 AuxiliaryRequestExecutor 的 executor 包围 provider。内层已记录可靠响应、但随后因取消拒绝时，外层把它记为 unknown；内层在 provider 前拒绝时，外层仍制造 attempt；内层直接返回旧 ModelStreamCleanupError 时，Memory 又累计旧响应的 usage。

[生产 factory 新回归](../../tests/unit/runtime/memory-request-ownership.test.ts) 最终负向 7 项、2 通过、5 失败、无 cancelled，日志 everpeace-memory-nested-accounting-baseline-final-20261009.log。直接覆盖手动及后台可靠响应后取消、准入前取消、已关闭辅助所有者和既有资源故障；真实新 Memory 清理故障及真正未知 transport 的正向检查原本通过。最初日志 everpeace-memory-nested-accounting-baseline-20261009.log 有一项额外 fixture 清理失败：两个关闭 Promise 已启动，却先后观察，使第二个拒绝被延后处理。修正同时观察后才取得上述干净负向证据，当前 fixture 使用 allSettled 确保所有清理结束后再移除自身目录。

后台 job 的 store 认领已经落盘、但尚未返回时，暂停 capture 没有可取消的 controller；旧 runtime 继续调用 provider。独立负向 1/1 断言失败，实际请求为一次而预期零次，日志 everpeace-memory-claim-admission-baseline-20261009.log。该例观察实际请求，不把等待超时或分析推断作为缺陷证明。

## 本轮实现

- [RequestAccountingScope](../../src/agent/request-executor.ts) 只携带已有 ledger/executor；[AuxiliaryRequestExecutor](../../src/agent/auxiliary-request-executor.ts) 可使用该 scope，在自身所有者和取消准入通过后，由同一个 executor 调用实际 provider。按 ledger 保留已记录位置；换 signal 不恢复未知准入，同一 ledger 不得替换 executor。
- [Memory runtime](../../src/memory/learned-memory.ts) 默认仍通过现有 RequestExecutor 执行；生产 host runner 接收同一操作 scope 和取消信号。Memory 状态与辅助累计显示分别观察该账本，只结算一次实际请求。可靠响应后取消保留用量；provider 前拒绝没有新样本，旧资源错误不重复记入 Memory。实际未知样本继续 sticky，后续独立操作不能把累计显示改成完整。
- [production factory](../../src/runtime/production.ts) 与 [TUI dependencies](../../src/tui/app/dependencies.ts) 将 scope 传入辅助所有者，直接 provider adapter 不再嵌套新的 attempt。手动和后台提取/合并均使用该边界；已有关闭等待、故障优先级、自动队列隔离和持久恢复标记保留。
- 后台每次请求在认领之后、pending 写入之后都复核 generation、capture 策略、全局开关与信号，实际 callback 前也检查取消。暂停发生在异步认领期间时不发送 provider，保存 false/true 的可靠零请求状态，不写入长期条目。

[辅助 scope 回归](../../tests/unit/agent/auxiliary-request-executor.test.ts) 检查可靠取消、准入前取消、原 token budget、换 signal、executor 身份和 sticky unknown。新 [实际 SDK fixture](../../tests/fixtures/memory-accounting-offline.ts) 使用真实 DeepSeek provider/SDK 和 fake fetch，在隔离子进程分别验证 SDK 解码后取消、SDK 准入前取消及正常保存；断言实际调用数、Memory/辅助用量一致、条目有无及关闭后不追加请求。它没有真实网络模型、付费凭据或真实终端交互。

双语 README、MEMORY、RUNTIME、STATE_AND_UI、PROJECT_MAP、DECISIONS、PLAN 与归档索引已同步。没有新依赖、版本变更、Session schema、错误包装或平行计量实现。上一轮的 pending/usage 恢复和手动 Memory 修复继续留在工作区，验证记录已经各自归档。

## 当前验证

最终重新发现 manifest 并串行运行：typecheck 通过 → 实际没有 lint script → test 1038 项、1035 通过、0 失败、0 cancelled、3 项平台跳过（56,478.1807 ms）→ build 通过。构建前确认生成目录 dist 的绝对路径及父目录均在本工作区。日志位于宿主临时目录：everpeace-memory-shared-accounting-{typecheck,test,build}-final-20261009.log。完整 suite 按原并发度 4 覆盖本轮新增 14 项及全部既有回归，不构成付费效果或真实 Windows Terminal 验收。

共享计量首轮定向 97/97 通过（everpeace-memory-shared-accounting-focused-20261009.log），严格类型预检查通过；实际 SDK/生产服务扩展 29/29 通过（everpeace-memory-shared-accounting-sdk-20261009.log）；认领准入补充后的相关检查 100/100 通过（everpeace-memory-shared-boundaries-20261009.log）。集合与完整 suite 不相加，最后的取消检查和 fixture 清理加强也由上述最终完整门禁覆盖，不使用旧结果代替当前验证。

git diff --check 和本轮含前两轮待提交内容的 28 份文件空白检查通过，13 份本轮文档的 535 个本地链接目标存在，双语展示版本仍与 package.json 一致。staged 差异为空，所有当前改动继续留在本地。本轮没有新增远端交易，旧 CI 只验证既有提交。

## 未完成范围与下一步

继续 PLAN 九项完整生产验收，下一步核对 Memory 的真实空闲条件，以及前台任务、Plan、取消、失败/停止及宿主验证结束时的后台恢复；当前源码阅读提示这些边界需要更强行为证据，尚不据此宣称缺陷或完整可用。其余 Session、工具、公开 SDK 和能力要求仍需逐项复核。最终 candidate 的 preflight/fixture proof、独立评分和可审阅付费计划仍待按最终代码重做，不提前调用真实模型。

Windows LSP 的 direct-socket denial probe 尚未通过，保持失败关闭，不削弱隔离或回退宿主。任意 detached 后代、其他原生平台，以及真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍需独立验收。不得用受控 fixture 或 Ink 单测替代真实终端证据。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 保持原样，不 stage、删除或纳入交付。本轮及前两轮新增六份 Memory 测试/fixture 与三份交接归档属于本地开发，全部相关改动仍未提交或推送。
