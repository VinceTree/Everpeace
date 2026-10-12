# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。上一轮共享进程清理及授权交付记录见 [归档](../archive/HANDOFF_PROCESS_LIFECYCLE.md)。

## 当前目标与工作区

总目标仍是完整实现 DeepSeek 优先、Windows 优先的个人 Node/TypeScript 编码 CLI，补齐功能后开始有预算的付费测试。目标保持 active；[PLAN](../PLAN.md) 保存完整定位验收矩阵，不能用当前局部修复宣布全部完成。上一轮属于 progress：改变了实现并取得跨平台验证与交付证据。

实现基线为 main 的 4f2083c58ea694cd53f56257a4f4314ec7aaa06e，与 origin/main 同步；本次交付开始时已存在下面记录的清理故障结算改动。用户再次明确要求提交、推送、更新版本，但不更新 Release。展示版本从 0.3.17 更新到 0.3.18，同步 package.json 和双语 README。提交使用 [skip publish]，保留独立测试 CI，不创建或推送 tag。推送前已记录 GitHub 27 个 Release 的 ID、tag 和更新时间，用于推送后比对。未请求付费模型。

## 当前实现与故障证据

审计发现 BackgroundJobManager 的 waitAll/stopAll 仅返回快照，cleanupFailed 可被 cancelled 终态和输出淘汰遮蔽；CodingTaskRunner 的异常收尾吞掉 cleanup rejection，宿主 verification 可把清理失败当普通修复失败。production shell bridge 的 finally 还会在资源故障后启动快照，快照异常可替换原故障。

新增三项核心回归在修改前全部语义失败，日志 everpeace-task-cleanup-baseline-20261009.log。现已实现：

- [后台管理器](../../src/tools/background-jobs.ts) 永久保留 cleanupFailed/ProcessCleanupError，终态为 failed。等待和取消先等全部 worker，再报告资源故障；取消、输出淘汰和重复 dispose 不能清掉故障，新的 worker 准入关闭。
- [Agent](../../src/agent/react-agent.ts) 阻止故障所有者的后续工具、请求、beginTask 及成功 Goal/Memory 操作。当前工具错误保留 cleanup_failed，剩余已落盘调用按顺序补齐 skipped/process_cleanup_failed 结果。普通命令失败仍可作为模型反馈，不变成资源故障。
- [生产 shell bridge](../../src/runtime/production.ts) 在清理失败后跳过快照，保留原故障并记录固定的未验证债务。生产 handle 的重复 dispose 共用同一等待／拒绝 promise；Agent 的其他进程内输出资源仍在 finally 释放。
- [runner](../../src/workflow/task-runner.ts) 异常路径先收束全部后台，再拒绝待完成 Goal 和成功 Memory；清理错误优先于普通取消，并阻止同一 runner 重用。
- [workflow](../../src/workflow/runtime.ts) 保存 blocked/unverified、tracking_limited 与 pending_verification，以及固定的 process-ownership 原因；清理错误正文不进入 workflow 元数据。快速／最终／手工验证清理失败不进入自动修复，同一 runtime 的手工验证、undo 和新任务被拒绝。新 runtime 恢复债务后空改动仍为 unverified。

[生产结算回归](../../tests/unit/workflow/cleanup-settlement.test.ts) 使用实际 Agent、生产 IO bridge、GoalRuntime、CodingTaskRunner 和 CodingWorkflowRuntime，证明故障不完成 Goal、不捕获成功 Memory、不启动后续验证；同时验证调用配对、取消错误优先级、重新准入、workflow 债务和无改动恢复。另有生产 factory 的实际 streaming/Session/disposal 回归。

## 本轮验证

相关定向回归 148 项全部通过，日志 everpeace-task-cleanup-focused-final-20261009.log。完善测试 fixture 时曾发现非 Git 目录不能触发期望的最终验证、factory 测试缺少必需 streaming provider 与活动 Session；补齐真实契约后通过，没有扩大生产接口或跳过断言。

更新展示版本后重新执行最终宿主串行门禁：typecheck 通过 → lint script 缺项 → test 889 项、886 通过、0 失败、3 项平台跳过（51,731.7006 ms）→ build 通过。最新日志使用宿主临时目录 everpeace-delivery-0318-{typecheck,test,build}-20261009.log，替代之前开发阶段的完整门禁记录。package.json 与双语 README 的展示版本一致，git diff --check、23 份交付文件的空白检查与 219 个本地文档链接路径检查通过。提交后的实际远端验证结果见下节。

## 授权交付结果

实现提交 7d7ed009d025b5ee9742aa91e608b07bec712197 已推送 main，标题为 fix: block task success after process cleanup failure [skip publish]。[Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37813764514) 已 completed/success，Windows/Linux jobs 均 success；证据针对这个实现提交，后续纯交接记录提交由独立 Test workflow 正常检查。

[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37813764358) 已 completed/skipped，Publish version job 实际 skipped。推送后 27 个 Release 的 ID、tag、更新时间与基线完全一致，远端没有 v0.3.18 tag。本次更新版本／提交／推送交易已完成，后续开发不自动重复；完整产品目标仍保持 active。

## 下一步与完整目标的未完成项

- 继续审计 legacy process-cancel 调用方，以及真正 native backend 的后代所有权、脱离进程组进程与 Windows 原生资源证据。本轮证明任务层错误传播，不证明任意后代均被 OS 收束。
- 固定 Windows LSP backend 的网络隔离仍 unavailable，需解决该能力缺口；不允许宿主回退。
- 按 PLAN 逐项复核 provider/预算、项目规则与编辑、Session/Memory、公开 exec/SDK、Web/MCP/Skills 的当前实现及生产证据。
- 真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍 pending。
- 最终 candidate identity 的 preflight/fixture proof 和可审阅的付费 campaign 仍需准备。付费运行必须另有明确授权及 task/campaign 数值预算。

## 用户原有内容

未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 全部保留，未修改。当前新增测试及归档属于本轮实现，不与用户目录混淆。
