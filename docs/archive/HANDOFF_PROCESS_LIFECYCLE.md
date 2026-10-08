# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。第六阶段 Composer 生命周期的 [交接](HANDOFF_COMPOSER_LIFECYCLE.md) 和 [计划](PLAN_COMPOSER_LIFECYCLE.md) 已归档。

## 当前目标与交付范围

用户总目标仍是完整实现 Agent 定位、补齐功能后开始付费测试；[PLAN](../PLAN.md) 保存完整验收清单，局部修复不代表产品全部完成。本次用户明确要求提交、推送、更新版本，但不更新 Release。

交付基线为 main 的 986f43623d72018d0de5a9cbf3eba1faf1c2878a，开始时与 origin/main 同步。展示版本从 0.3.16 更新到 0.3.17，同步 package.json 和双语 README。提交使用 [skip publish]；Release workflow 只跳过发布 job，独立 Test CI 保持启用，不创建或推送 tag。推送前 GitHub 共 27 个 Release，已记录其 ID、tag 和更新时间用于核对。本次未调用付费模型。

实现提交 d31e954afc0a9b0bb438b0329f3209d0e3292b86 已推送 main。[Release job](https://github.com/VinceTree/Everpeace/actions/runs/37808346403) 实际 completed/skipped；推送后 27 个 Release 的 ID、tag、更新时间与基线完全一致，远端无 v0.3.17 tag。[Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37808346484) 已启动 Windows/Linux jobs，记录时仍在运行；本记录不把 pending CI 当作通过。

## 本轮实现

- [共享进程生命周期](../../src/tools/process-completion.ts) 让 buffered native launcher、宿主 Bash、评测准备/验证、外部 harness、checkout worker、dsh 和工作区快照等待 child close 与唯一进程树终止请求；移除以固定 500ms 结算的路径。保留清理错误，隔离关闭后输出，observer 异常不放弃进程所有权。
- Windows 等待 taskkill /T /F，Unix 终止 detached process group；取消与超时复用一次请求。预取消验证不启动进程，attempted 为 false。
- 评测以 cleanupFailed 保留清理失败，取消不能覆盖该错误。suite/campaign 停止后续任务并将 skipped 标为 cleanup_failed；统计完整性为 false。并发快照命令全部结算才返回，准备器清理失败时保留目录。
- 补充 [launcher 生命周期回归](../../tests/unit/codex/process-lifecycle.test.ts)、[宿主/评测生命周期回归](../../tests/unit/tools/process-completion.test.ts)、真实 Node 父子进程退出 fixture，以及 suite/campaign 停止传播回归。

## 验证证据

早期 launcher 四项受控回归在修复前全部失败；宿主 Bash/评测三项新增回归亦在接入前失败。前一开发阶段 Windows/WSL 真实 Node fixture 验证了父子进程退出，WSL 使用独立纯 Node 编译，不能作为真正 native sandbox 或任意脱离进程组后代的隔离证明；后续共享模块的完整 Linux 证据以本次远端 CI 为准。

首个实现提交的 Linux CI 在真实进程 fixture 失败：signal 0 成功被断言为仍存活，但 Linux 已退出的僵尸 PID 在被回收前也可被该调用观察。回归现仅在 Linux 读取 /proc/PID/stat：PID 已消失或明确为 Z/X 才通过，任何存活状态仍失败；没有增加延时或跳过测试，也没有改动生产终止逻辑。修正后 WSL Linux 的两文件 13 项、12 通过、0 失败、1 项 Windows-only 跳过；WSL 网络模式回退 None，不能算网络隔离验收。后续 dc54978 的 [Windows/Linux 全套 CI](https://github.com/VinceTree/Everpeace/actions/runs/37808490956) 均已通过，旧断言存在时序敏感性；修正提交仍须以自身 CI 为准。

修正后的首次本地完整测试在既有 benchmark 取消回归失败：固定 1 秒取消与 fixture 自行退出竞争，严格清理报告 taskkill 128。测试现从 verify 阶段调度取消，fixture 保持运行直到被终止，并断言 verification.attempted；不再依赖快照耗时或自行退出时机，生产代码仍保留终止失败。该轮 880 项、876 通过、1 失败、3 跳过，已按首败停止，没有继续构建；日志 everpeace-delivery-linux-fix-test-20261009.log。

本次定向测试 78 项、77 通过、0 失败、1 项平台跳过。最终修正后再次串行执行：typecheck 通过 → lint script 缺项 → test 880 项、877 通过、0 失败、3 项平台跳过（50,865.7895 ms）→ build 通过，日志 everpeace-delivery-race-fix-{typecheck,test,build}-20261009.log。此前首轮完整门禁亦通过。git diff --check、28 份交付文件空白检查和 361 个本地文档链接路径检查通过。日志保存在宿主临时目录 everpeace-delivery-focused-20261009.log 及 everpeace-delivery-final-{typecheck,test,build}-20261009.log。

## 尚未完成的产品验收

- BackgroundJobManager 到 CodingTaskRunner、Goal/Memory 的清理失败传播仍需继续审计；当前未修改这些组件。真正 native backend 的后代所有权、脱离进程组的后代及 legacy process-cancel 调用方仍需独立验证。
- 固定 Windows LSP backend 的网络隔离仍 unavailable，不允许宿主回退。
- 请求/预算/验证、文件/规则、Session/Memory、公开 exec/SDK、Web/MCP/Skills 仍需按 PLAN 复核；真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍 pending。
- 最终候选的 preflight/fixture proof 与可审阅的付费 campaign 准备仍待完成；付费运行需要明确授权及 task/campaign 数值预算。

## 用户原有内容

原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 全部保留，未修改或纳入提交。
