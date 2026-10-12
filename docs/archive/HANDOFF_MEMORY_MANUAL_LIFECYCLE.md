# 手动 Memory 生命周期交接（历史）

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。已完成交付见 [请求所有权交接](../archive/HANDOFF_REQUEST_OWNERSHIP_DELIVERY.md)，上一轮 Memory 持久恢复及其验证见 [恢复归档](../archive/HANDOFF_MEMORY_CAPTURE_RECOVERY.md)。

## 当前基线与授权

main/origin/main 为 45401588a16f3205bee413fe92a1fbb00294d9c0，展示版本 0.3.21，package.json 和双语 README 一致。用户要求的升版、提交和推送已完成，提交带 [skip publish]；准确 HEAD 的 Windows/Linux Test CI 成功，Release workflow/job skipped，27 个现有 Release 与交付前基线一致，无 v0.3.21 tag。实际证据与链接见交付归档。本轮 git ls-remote 再次确认远端 main 与本地 HEAD 一致且无上述 tag；这些 CI 不验证当前未提交修改。

本轮继续完整实现定位目标，完成手动 Memory 的请求、持久化与关闭所有权。本轮不重复升版、提交、推送或发布，不调用付费模型；live 仍需明确授权及 task/campaign 数值预算。总目标保持 active，不能把当前切片当作 [PLAN](../PLAN.md) 九项完整验收完成。

## 本轮缺陷与失败证据

原手动 remember 不等待启动，不持有 runtime 取消控制器，不在响应及写入处复核 generation；dispose 只等待后台队列，清空或关闭后迟到响应仍可写回。初始负向回归 15 项全部断言失败、无 cancelled，日志 everpeace-memory-manual-baseline-20261009.log；包括重复关闭 Promise、六种失效动作、延迟写入、提交后取消、关闭/禁用准入和可靠错误用量。取消案例较慢不作为超时证据；fixture 清理现明确等待实际手动操作结束后再删除自己的临时目录，避免依赖被验证的 dispose。

实际 Ink 的 Esc/迟到成功及失败回归 3 项全部失败，日志 everpeace-memory-command-baseline-20261009.log：成功会重新读取状态并打开窗口，失败路径未收到取消信号。只临时逆转本轮 App 修复以获取旧行为证据，然后恢复修复，没有重置或覆盖用户改动。

真实 SDK fake-fetch 子进程在 provider 已返回而 append 尚未结束时关闭 TUI，直接断言发现 dispose 提前成功，1 项失败，日志 everpeace-memory-services-baseline-20261009.log。补充启动及响应后设置读取故障，3 项全部失败，日志 everpeace-memory-read-fault-baseline-20261009.log：失败后实际请求分别达到两次，而预期为零次或一次。它们是离线 fake provider 和真实断言，不是付费模型或真实终端证据。

## 本轮实现

- [Memory runtime/store](../../src/memory/learned-memory.ts)：显式请求等待启动、绑定 generation 与取消信号，并在准入、响应后、持锁原子提交前及返回成功前复核。全局禁用拒绝新手动请求；聊天 capture 暂停仍允许新的明确偏好。清空、禁用、归档、删除、恢复前台或暂停 capture 使正在运行的手动请求失效。自动候选和长期条目的延迟写入也复核失效条件，不能在清空后回填。
- 手动提取复用 RequestExecutor/RequestAttemptLedger，可靠 usage 在终态/正文校验前记录，取消及 ModelStreamCleanupError 不丢可靠用量。预取消没有实际请求或 unknown 样本；已经原子提交后取消会拒绝成功，但保留已提交条目，不回滚并发内容。
- runtime 持有手动请求、异步变更和存储的完成结果。重复或 abort callback 重入的 dispose 共用同一 Promise；先关闭准入，再取消并等待。启动、手动设置读取、手动写入和变更存储故障关闭后续准入并在 dispose 保留；资源清理错误优先于存储错误和普通取消。
- [生产 TUI 服务](../../src/tui/app/dependencies.ts)：临时手动 runtime 关闭自动 capture，不抢共享后台队列。服务持有手动持久化及旧 runtime 清理，关闭会等待 provider 返回后的写入；原存储/资源故障保留到重复关闭，不被取消替代。
- [App](../../src/tui/app/app.tsx)：/memory remember 传递命令取消信号，Esc 返回同一 Session。迟到成功与失败都检查操作身份及取消，不能重新打开 Memory 或错误窗口。

[手动生命周期](../../tests/unit/memory/manual-lifecycle.test.ts) 覆盖关闭、失效动作、延迟写入、提交后取消、故障准入、重入与已开始 clear 的关闭等待；[实际 SDK fixture](../../tests/fixtures/tui-memory-lifecycle.ts) 以隔离进程测试正常取消及存储故障，并断言后台队列未被消费；[Ink](../../tests/unit/tui/app.test.tsx) 保留原 Session、请求次数与迟到两种结果的断言。既有恢复故障 case 现在额外要求 dispose 返回原 ModelStreamCleanupError，原持久状态及用量断言未删减。

双语 README、MEMORY、STATE_AND_UI、PROJECT_MAP、DECISIONS、PLAN 与归档索引已同步。没有新依赖、Session schema 或平行计量实现；上一轮持久 requestPending/usageComplete 恢复改动继续保留，完整证据已归档。

## 当前验证

最终重新发现 manifest 并串行运行：typecheck 通过 → 实际没有 lint script → test 1024 项、1021 通过、0 失败、0 cancelled、3 项平台跳过（55,673.8168 ms）→ build 通过。构建前检查生成目录 dist 的绝对路径及父目录均在本工作区。日志位于宿主临时目录：everpeace-memory-manual-{typecheck,test,build}-final-20261009.log。完整 suite 按原并发度 4 覆盖新增 31 项手动 Memory/生产依赖/Ink 检查和全部既有回归，不构成付费效果或真实 Windows Terminal 验收。

扩展 Memory、恢复与生产依赖回归 77/77 通过（everpeace-memory-manual-expanded-20261009.log）；App、生产 runtime 和辅助执行器 88/88 通过（everpeace-memory-app-positive-20261009.log）；新增存储失败情形后的生产依赖 5/5 通过（everpeace-memory-services-fault-positive-20261009.log）。定向集合与完整 suite 不相加，最终证据以上述完整门禁为准。

初次修复后定向 64 项中既有恢复 case 的 dispose 成功预期失败；将其加强为保留准确清理故障后 69/69 通过，日志 everpeace-memory-manual-focused-20261009.log 和 everpeace-memory-manual-integration-20261009.log 保留。没有通过删断言、放宽超时或旧验证替代最终检查。

git diff --check 和本轮含上一轮待提交内容的 20 份文件空白检查通过，11 份本轮文档的 443 个本地链接目标存在，双语展示版本仍与 package.json 一致。本轮所有修改继续留在工作区，staged 差异为空；上次交付的远端 CI 只验证原提交，本轮没有新增远端交易。

## 未完成范围与下一步

继续 PLAN 的逐项生产验收，尤其辅助与 Memory 的嵌套计量/准入边界、其余 Session/工具/SDK 路径及完整定位清单。当前自动通过不代表完整产品完成；最终 candidate 的 preflight/fixture proof、独立评分和可审阅付费计划仍待按最终代码重做，不提前调用真实模型。

Windows LSP 的 direct-socket denial probe 尚未通过，保持失败关闭，不削弱隔离或回退宿主。任意 detached 后代、其他原生平台，以及真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍需独立验收。不得用受控 fixture 或 Ink 单测替代真实终端证据。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 保持原样，不 stage、删除或纳入交付。本轮及上一轮新增四份 Memory 测试/fixture 与两份交接归档属于本地开发，全部相关改动仍未提交或推送。
