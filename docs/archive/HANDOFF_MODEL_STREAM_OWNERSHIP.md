# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。上一轮进程 ownership 修复、交付与 CI 结果完整保留在 [归档](../archive/HANDOFF_READ_PROCESS_OWNERSHIP.md)。

## 总目标、授权与当前状态

总目标仍是完整实现 DeepSeek 优先、Windows 优先的个人 Node/TypeScript 编码 CLI，补齐功能后开始有预算的付费测试。[PLAN](../PLAN.md) 保存完整验收矩阵，任何单轮局部修复不代表目标完成；目标保持 active。

上一轮只读复核交付状态，没有推进功能实现，分类为 no progress。本轮重新核对当前 Git 状态，以流式请求、关闭、恢复与计量的生产缺陷推进，不重复提交或缩小总目标。

当前版本仍为 0.3.19，main/origin/main 基线为 a8339f8287f00b6bbb7fad24968185cd5053dc38。该实现已推送，Windows/Linux [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37819342770) completed/success；[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37819342938) completed/skipped，27 个 Release 与交付前的 ID/tag/更新时间完全一致。这些是基线交付证据，不替代本轮未提交流式改动的验证。

用户的提交／推送／展示版本更新但不更新 Release 交易已完成，本轮目标续跑不重复交易、不创建或推送 tag。先前两份追加 CI 交接文档的额外提交／推送被自动审批拒绝，理由为原授权已用于首笔交付；追加批准问题尚无回答，不绕过拒绝。本轮实现、测试、文档均保留本地，不调用付费模型；live 仍需独立授权和 task/campaign 数值预算。

## 本轮失败证据与实现

原 Agent 在消费 SSE 的 finally 中忽略 iterator.return 错误，也不确认返回的 done；恢复流返回 promise 而未 await，导致 finally 在消费结束前取消恢复控制器。即使外层等待 iterator，实际 SDK 在 abort 后还可能不等待底层 body 取消，忽略取消拒绝。

修复前 [Agent 流回归](../../tests/unit/agent/stream-lifecycle.test.ts) 8 项中 7 项语义失败、1 项既有等待控制通过，日志 everpeace-stream-lifecycle-baseline-20261009.log；[真实 SDK body 回归](../../tests/unit/providers/stream-lifecycle.test.ts) 两项均语义失败，日志 everpeace-provider-stream-baseline-20261009.log。它们证明普通终态或取消可掩盖清理故障，以及 body cancellation 尚未完成时就报告关闭。

- [资源错误](../../src/util/resource-cleanup-error.ts) 是进程／模型流的共用 fatal 边界；原 ProcessCleanupError 保留原名称和前缀，新增 ModelStreamCleanupError 保存 normalized usage。不能按 cause 中的网络／timeout/context 文本重试。
- [Agent](../../src/agent/react-agent.ts) 在终态后取消 transport，等待 iterator.return 确认 done 和活动 next。自然 EOF 不多余 return；缺失关闭操作、done 未确认、拒绝都永久关闭当前所有者准入。清理错误优先于取消、steering、usage/budget stop 和能力 fallback。
- 恢复流 await 消费和清理后才取消恢复控制器，恢复清理故障不被原始中断替代。runTurn 收尾、Goal/Memory 结算、dispose 和新任务准入都保留资源故障。
- [生产 provider](../../src/providers/response-stream.ts) 接管 SDK raw HTTP Response 的 body reader，继续复用 SDK SSE decoder。独立等待 reader.cancel、活动 read 和 reader lock 释放；外部取消同步传给解码控制器。已经 errored 的 body 重抛同一 transport error 不误分类为关闭失败，真正 cancel 拒绝仍 fatal。不修改 SDK、node_modules 或复制 decoder。
- [RequestExecutor](../../src/agent/request-executor.ts) 将故障 attempt 记 failed，保留 terminal 的可靠计量；缺 usage 则 unknown。计量完整不代表资源安全；账本 reset 不能消除故障 executor 的准入拒绝。
- [runner](../../src/workflow/task-runner.ts) 与 [workflow](../../src/workflow/runtime.ts) 复用现有清理、Goal/Memory 拒绝和未验证债务通道。固定 request-ownership 原因进入 workflow，错误正文不进入元数据。exec/公开 SDK 保持 cleanup_failed、runtime_error、退出码 1，不能被同时取消或期限覆盖。

已同步双语 README 的用户可见行为与 [RUNTIME](../architecture/RUNTIME.md)、[AGENT_LOOP](../architecture/AGENT_LOOP.md)、[DECISIONS](../architecture/DECISIONS.md)、[PLAN](../PLAN.md)。没有新增 Session schema、平行 runner 或新的公共参数。

## 本轮验证与边界

流、计量、生产 runner/exec 和公开 SDK 定向检查 64/64 通过，日志 everpeace-stream-sdk-focused-20261009.log。实际生产 Agent 请求完成 Goal 后再发生流清理失败的案例证明 Goal 仍 active、已知六个 tokens 保留、无验证／成功 Memory、无法再启动；Session 恢复与空工作仍保持 unverified。公开 runTask 在隔离用户目录中使用真实 SDK 和受控 fetch body，证明可靠用量和固定债务；已有 SDK Plan fixture 仍通过本地 HTTP 协议。这些均不代表真实付费模型质量。

首次 typecheck 发现新增 mock 参数缺少类型注解，已按真实 LearnedTurnOutcome 修正，没有 any 或放宽接口。首次完整 test 发现原 idle fixture 的 next 永不结算、return 却报告 done，导致八项 cancelled；已将 fixture 改为在实际 request signal abort 时结束 next，增加 nextSettled 断言，保留原 idle／transport／iterator 三项断言。新独立 idle 回归还证明 return 已 done、next 尚未结束时任务确实等待，不能用超时或放宽生产 ownership 制造通过。

最后复核补充了 cancel promise 拒绝值为 undefined 的情况：拒绝本身即为失败，不能因没有错误正文而报告关闭成功，reader lock 仍须释放。该分支有真实 SDK body 回归覆盖。

最终按当前 manifest 串行执行：typecheck 通过 → lint script 缺项 → test 927 项、924 通过、0 失败、0 cancelled、3 项平台跳过（51,862.2507 ms）→ build 通过。宿主临时目录日志为 everpeace-stream-final-{typecheck,test,build}-20261009.log。git diff --check、本轮 28 份文件空白检查与 43 份文档的 947 个本地链接路径检查通过。当前只有本机 Windows 证据；新改动未推送，没有其独立 Linux CI 证据。

## 完整目标仍未完成项与下一动作

- 按 PLAN 逐项复核 provider/用途配置／预算、规则与文件编辑、验证与修复、Session/Memory、公开 exec/SDK、Web/MCP/Skills 的完整生产证据。流关闭修复只是其中一部分。
- Windows LSP 的直接网络 probe 仍允许连接，当前导航失败关闭。BFE/MpsSvc、防火墙 profile、offline rule 与 payload SID 的只读匹配证据见归档；未修改系统防火墙／账号，也不采用宿主回退。
- 真正 native backend 的任意 detached 后代、其他平台以及直接用户 PTY 的退出仍需更广验收，既有受控 Windows fixture 不证明普遍保证。
- 真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍 pending，自动测试不代替终端操作证据。
- 最终 candidate identity 的无凭据 preflight、fixture proof、独立评分和可审阅付费 campaign 仍须准备。实际付费请求须另有明确授权和数值预算。

## 用户原有内容

未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 保持原样，未修改或纳入交付。本轮新 provider、资源错误、stream 测试／SDK fixture 与归档属于目标实现，均仍在本地。
