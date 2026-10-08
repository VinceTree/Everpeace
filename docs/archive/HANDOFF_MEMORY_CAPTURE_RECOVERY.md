# Memory 持久请求恢复交接（历史）

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。手动压缩、请求所有权与已完成交付的历史见 [归档](../archive/HANDOFF_REQUEST_OWNERSHIP_DELIVERY.md)。

## 当前基线与授权

main/origin/main 均为 45401588a16f3205bee413fe92a1fbb00294d9c0，展示版本 0.3.21，package.json 和双语 README 一致。上次用户要求的升版、提交和推送已完成；该 HEAD 的 Windows/Linux Test CI 成功，Release workflow/job skipped，27 个现有 Release 与推送前基线一致，无 v0.3.21 tag，链接与实际复核见归档。这些 CI 不验证本轮未提交修改。

本轮继续完整实现定位目标，完成 Memory 的持久请求状态与恢复边界。本轮不重复升版、提交、推送或发布，不调用付费模型；live 仍需明确授权和 task/campaign 数值预算。总目标保持 active，不能把这个切片当作 [PLAN](../PLAN.md) 九项完整验收完成。上一轮的交付核对取得准确远端/CI/Release 证据，本轮据此转回本地开发。

## 本轮实现与失败证据

原 Memory runtime 仅在内存里保存 job 的 RequestAttemptLedger。任何过期 running 租约都会直接重新排队，进程重建后可在旧请求用量未知时重新发送。新增恢复负向回归最初 7 项、1 通过、6 失败，日志 everpeace-memory-recovery-baseline-20261009.log；包括真实进程在 provider 请求中被终止时，持久文件缺少 pending 标记的直接断言。可靠 extracted 恢复的正向案例原本通过。

- [LearnedMemoryRuntime](../../src/memory/learned-memory.ts) 在现有 capture-jobs.json 添加可选 requestPending/usageComplete；新 queued job 初始化 false/true。提取和合并请求开始前原子保存 pending，再执行共享 RequestExecutor；每次实际 attempt 的用量记录后持久化结算，才处理响应或启动下一请求。可靠 usage 即使随后取消、资源故障或存储错误也保留，不重复累计。
- 过期 running job 只有明确 false/true 才重新排队。旧 running、pending、unknown 和错误类型的标记保存为 failed。旧 queued 若已有重试、错误或 extracted 证据但缺少可靠结算，也不能继续；确实未开始的旧队列与可靠结果仍可恢复。恢复保留失败用量缺口，不重建历史 token 总数。
- 请求标记、提取结果、失败更新和任务移除匹配原 running 租约，旧所有者不能修改接管后的 job。live 租约不被其他实例抢占；删除 job 不会由迟到请求重新创建。
- 起始/结算状态写入失败停止自动重试。若失败状态还能写入，同步保存已确定的请求结算，零次请求仍是零用量；持续存储失败保留旧持久标记并显示 failed。资源清理错误优先于同时发生的存储错误，取消在写入期间仍等待收束。

[新恢复回归](../../tests/unit/memory/capture-recovery.test.ts) 和 [真实进程 fixture](../../tests/fixtures/memory-capture-crash.ts) 都使用隔离临时目录与 fake provider。真实子进程分别在提取、合并时发出 IPC 请求开始事件，父进程先检查已经写入的 pending 标记，再终止并等待 close；仅修改 lease 时间模拟到期，保留计量状态，重建后断言不重发。不是付费模型、真实终端或一小时自然等待的证据。

持续存储失败的首个观察超时未作为最终缺陷证明；改为观察两次确定的存储拒绝并等待 dispose 后，直接断言实际 running 与预期 failed 不同，1/1 失败，日志 everpeace-memory-persistent-storage-baseline-final-20261009.log。旧 queued retry/cancellation/extracted 的补充负向检查 10 项、6 通过、4 失败（含父项）；直接证明重发或误删任务，日志 everpeace-memory-legacy-retry-baseline-final-20261009.log。

扩展检查发现起始标记已写而 provider 尚未准入时，重新扫队列可能误把用量显示为 unknown；失败状态写入现在同时保存已确定的结算，保留零请求断言。严格类型预检查发现两处 boolean 收窄/可选字段问题，已改用账本 snapshot 的明确 boolean，没有放宽类型配置。中间日志保留，不用旧通过替代最终检查。

双语 README、MEMORY、PROJECT_MAP、DECISIONS 和 PLAN 已同步；没有新依赖、Session schema 或平行计量实现。

## 当前验证

本轮最终串行门禁：typecheck 通过 → 实际 manifest 没有 lint script → test 993 项、990 通过、0 失败、0 cancelled、3 项平台跳过（54,114.4218 ms）→ build 通过。宿主临时目录日志 everpeace-memory-recovery-{typecheck,test,build}-final-20261009.log。完整 suite 以原并发度 4 执行，包含本轮全部 29 项新恢复检查以及既有真实进程、协议和 Ink 回归；不构成付费模型或真实 Windows Terminal 验收。实际源码、测试及展示版本绑定该证据，上一交付 CI 只验证原提交。

初步定向 51/51 已通过（everpeace-memory-recovery-expanded-fixed-20261009.log），此后类型修正和旧队列补充均由上述最终完整 suite 覆盖，不把定向数量与完整 suite 相加。中途一轮新 checkpoint case 没有到达预期故障注入，原日志 everpeace-memory-recovery-expanded-final-20261009.log 保留；增加实际持久状态诊断，没有删除断言或放宽超时，单项和扩展检查随后通过，最终以本轮完整 suite 为准。

git diff --check 与本轮 12 份文件空白检查通过，9 份本轮文档的 367 个本地链接目标存在，双语展示版本仍与 package.json 一致。交付归档包含真实远端 HEAD、准确 CI attempt 与 Release 基线复核，本轮没有新增远端交易。

## 未完成范围与下一步

继续 PLAN 的逐项生产验收，尤其 Memory 的手动请求、关闭/故障与恢复，以及其余 Session/工具/SDK 路径；自动通过不构成完整产品完成。最终 candidate 的 preflight/fixture proof、独立评分与可审阅付费计划仍待按最终代码重做，不提前调用真实模型。

Windows LSP 的 direct-socket denial probe 尚未通过，保持失败关闭，不削弱隔离或回退宿主。任意 detached 后代、其他原生平台，以及真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍需独立验收。不得用受控 fixture 或 Ink 单测替代真实终端证据。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 保持原样。本轮新增两份 Memory 测试/fixture 与交付归档，全部本轮改动仍留在工作区，不 stage、提交或推送。
