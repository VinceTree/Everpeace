# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。已交付基线见 [请求所有权交接](../archive/HANDOFF_REQUEST_OWNERSHIP_DELIVERY.md)，此前 Memory 修复见 [恢复](../archive/HANDOFF_MEMORY_CAPTURE_RECOVERY.md)、[手动生命周期](../archive/HANDOFF_MEMORY_MANUAL_LIFECYCLE.md) 与 [共享计量](../archive/HANDOFF_MEMORY_SHARED_ACCOUNTING.md) 归档。

## 当前基线与授权

已交付 main/origin/main 基线为 45401588a16f3205bee413fe92a1fbb00294d9c0，展示版本 0.3.21，package.json 和双语 README 一致。用户要求的升版、提交和推送已完成，提交带 [skip publish]；该准确 HEAD 的 Windows/Linux Test CI 成功，Release workflow/job skipped，27 个现有 Release 与交付前基线一致，无 v0.3.21 tag。远端与 Release 证据见交付归档，不将旧 CI 当作当前未提交源码的验证。

本轮继续完整定位目标，修复 Memory 的整项任务空闲范围、无新材料时恢复旧队列、重启重新计时与异步任务开始的关闭竞态。没有再次升版、提交、推送或发布，没有调用付费模型。live 仍需明确授权及 task/campaign 数值预算。总目标保持 active，当前切片不是 [PLAN](../PLAN.md) 九项完整验收完成。本 goal turn 有负向证据、源码修复、生产回归与最终完整门禁，是 progress，不是等待或无进展。

## 缺陷与失败证据

原 Memory 仅收到单轮开始和学习 outcome。可靠后台响应因前台取消后重新排队，处理队列仍重新 arm timer，导致 Plan 审批未结束时再次请求；failed/unverified/stopped finishTurn 直接 skipped 后返回，旧队列不恢复；Plan 没有 pending learned turn，也缺少结束通知。runtime 重建把已经过期的持久 notBefore 当作当前实例已经空闲，立即发送提取请求。

[空闲生命周期回归](../../tests/unit/runtime/memory-idle-lifecycle.test.ts) 的目标阶段负向 5 项全部断言失败、无 cancelled：三种 skipped outcome 的旧队列实际请求零次而预期一次，Plan approve/cancel 在审批等待期间实际两次而预期仅此前一次。日志 everpeace-memory-idle-lifecycle-baseline-final-20261009.log。最初 baseline 未提供 requestUserInput，使 Plan fixture 没进入 review，不能用于证明该缺陷；提供完整 Plan interaction 后才取得上述实际调用计数。后续运行到任务完整返回时发现 fixture 尚未创建 Session，补齐真实 Session 后 Plan approve/cancel 完整恢复控制通过。正向 fixture 使用实际生产 factory/runner 和 Session，不依靠缺失宿主持久化来通过。

重启的 queued 与已可靠结算且租约过期 running 各一项负向断言失败、无 cancelled：没有计满当前实例五分钟，provider 已被调用一次而预期零次。日志 everpeace-memory-idle-restart-baseline-20261009.log。另一项生产负向证明 Agent 在异步 Memory pause 等待期间已关闭，却让 beginTask 成功返回，日志 everpeace-memory-idle-task-disposal-baseline-20261009.log；修复后拒绝 disposed 且没有迟到 TaskProgress 写入。

扩展生产 fixture 一度把两个不同 lesson 放在相同 applyWhen 下，现有冲突审查正确只晋升一条；改成不同适用条件后验证两项学习都完成。这是 fixture 期望修正，不是存储缺陷。早期定向失败/取消结果不作为当前验证，最终门禁覆盖全部修正后的测试。

## 本轮实现

- [Memory runtime](../../src/memory/learned-memory.ts) 分别持有 taskActive 和 turnActive。开始前台时同步提升 generation、关闭 timer 准入并取消请求，等待启动及持久变更；单轮结束只能释放轮次状态，不能解除完整任务暂停。timer、处理循环、持锁认领与实际请求提交均检查该状态。
- [ReactAgent](../../src/agent/react-agent.ts) 将 Memory beginTask/endTask 接到已有 [CodingTaskRunner](../../src/workflow/task-runner.ts) 钩子，覆盖 Plan review、host verification、repair 和 Goal continuation。没有 pending learned turn 时仍通知 endTurn。Agent dispose 仅清任务元数据，不能先恢复 Memory；异步 beginTask 的 Memory pause 返回后重新检查 Agent 可用性，关闭不留下迟到进度。
- 最终任务退出时，不论本次是否有新学习材料，可靠旧队列都重新计满空闲期；runtime 重建也先按既有持久恢复规则识别 failed/unknown，再为可恢复 queued job 重新计时。captureFuture 关闭的临时 runtime 不通过该恢复路径消费队列。foreground startup 仍读取持久用量缺口，暂停不能隐藏 unknown。

本轮新增 14 项测试。完整生产例使用隔离 Git 项目、实际文件 read/观察版本/apply_patch、实际 host suite 顺序、Goal 连续轮次和受控时钟，断言宿主验证、已 verified 但 task 尚未退出以及 continuation 三阶段均没有后台请求，最后一毫秒前仍不准入。另覆盖真实 runner 的 no_changes、失败、取消、step_limit、Plan approve/cancel 和重启后正常消费的正向控制。provider 与验证命令输出均为离线 fixture，不是真实模型或 Windows Terminal 验收。

双语 README、MEMORY、RUNTIME、STATE_AND_UI、PROJECT_MAP、DECISIONS、PLAN 和归档索引同步。没有新依赖、版本变更、Session schema、平行 runner 或计量实现。此前未提交的 Memory 请求恢复、手动生命周期和共享 scope 修复继续保留，历史验证各自归档。

## 当前验证

最后一处关闭竞态修复后重新发现 manifest 并串行运行：typecheck 通过 → 实际没有 lint script → test 1052 项、1049 通过、0 失败、0 cancelled、3 项平台跳过（61,930.9471 ms）→ build 通过。构建前确认 dist 的绝对路径及父目录在本工作区。最新日志位于宿主临时目录：everpeace-memory-idle-{typecheck,test,build}-verified-20261009.log；没有用上一组同日 final 日志替代最终源码的验证。

最后的 Memory/Agent/runner/production 定向 173/173 通过（everpeace-memory-idle-focused-final-20261009.log）；随后补充异步任务关闭的独立正向 1/1（everpeace-memory-idle-task-disposal-fixed-20261009.log），二者并集及此前所有回归由上述最新完整门禁覆盖，不相加声称总量。最后补充回归已进入完整 suite。

git diff --check、当前全部 31 份自有改动的空白检查和 14 份文档的本地链接检查通过，双语展示版本仍与 package.json 一致。staged 差异为空，所有相关开发改动继续留在本地；本轮无新远端交易，旧 CI 仅验证已交付提交。

## 未完成范围与下一步

继续 PLAN 九项完整生产验收，下一步复核 production factory/辅助所有者关闭期间的准入、其他前台操作与后台 Memory 的空闲关系，再核对 Session/公开 exec、SDK 的剩余要求。当前只完成上述任务范围的具体缺陷，不宣称所有前台表面或资源生命周期已验收。最终 candidate 的 preflight/fixture proof、独立评分与可审阅付费计划待按最终代码重做，不提前调用真实模型。

Windows LSP direct-socket denial probe 尚未通过，保持失败关闭，不削弱隔离或回退宿主。任意 detached 后代、其他原生平台，以及真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复和单 prompt 仍需独立验收；不能用受控 fixture 或 Ink 单测替代。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 保持原样，不 stage、删除或纳入交付。本轮及此前新增七份 Memory 测试/fixture 和四份交接归档属于本地开发，全部相关改动仍未提交或推送。
