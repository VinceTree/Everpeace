# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。此前进程交付见 [归档](../archive/HANDOFF_READ_PROCESS_OWNERSHIP.md)，模型流关闭实现和原始验证见 [归档](../archive/HANDOFF_MODEL_STREAM_OWNERSHIP.md)。

## 本次交付与授权

用户再次明确要求提交、推送、更新版本，但不更新 Release。这是本次实现与文档交付的新授权，覆盖当前已完成改动；此前追加纯文档推送的审批拒绝不用于限制此次明确请求。展示版本从 0.3.19 同步为 0.3.20，package.json 与双语 README 一致。

交付前 main/origin/main 为 a8339f8287f00b6bbb7fad24968185cd5053dc38。本次提交聚焦模型流资源关闭和逐次请求计量，提交标题使用 [skip publish]；仅推送 main，不创建或推送 tag，不创建或更新 Release。本次实现提交的准确 ID 以本文件所在提交的 Git 记录为准。

已核对 [Release workflow](../../.github/workflows/release.yml)：main push 涉及 package.json 时运行，Publish version job 根据提交正文的 [skip publish] 跳过；[Test workflow](../../.github/workflows/test.yml) 独立执行 Windows/Linux 检查，不跳过 CI。推送前只读保存了 27 个 Release 的 ID、tag、更新时间；交付核对须比较该基线、远端 HEAD、当前 HEAD 的测试 CI 和 Release workflow 实际结果，不能引用旧 CI 替代。

没有调用付费模型。总目标仍是完整实现 DeepSeek 优先、Windows 优先的个人 Node/TypeScript 编码 CLI；此次交付属于进展，不能视为 [PLAN](../PLAN.md) 全部验收完成。付费测试仍需独立明确授权及 task/campaign 数值预算。

## 实现与失败证据

本次包含此前本地完成的模型流修复：统一 ResourceCleanupError；Agent 等待 iterator.return 确认 done 和活动 next；恢复流消费完毕后才关闭恢复控制器；生产 provider 独立等待 SDK 原始 body 的 cancel/read/reader lock。清理拒绝、缺失关闭和未确认 done 永久关闭当前所有者准入，优先于取消、期限、steering、重试和能力降级。可靠 terminal usage 仍保留，runner/exec/SDK 保持 cleanup_failed、退出码 1，并阻止 Goal 完成和成功 Memory，Session 保留固定未验证债务。详见上轮归档与 [RUNTIME](../architecture/RUNTIME.md)。

提交检查发现 [request settlement](../../tests/unit/agent/request-settlement.test.ts) 尚未完成：六项离线回归均失败，日志 everpeace-submit-settlement-baseline-20261009.log。缺陷包括恢复成功丢失原始 unknown 用量、恢复失败少计 attempt、失败 terminal 的已知用量丢失、ledger stop 不保存 Goal/Session 用量，以及压缩 fallback 在有界 Goal 停止前再次请求。

- [ReactAgent](../../src/agent/react-agent.ts) 在每个实际 coding attempt 结束后即时保存 Session/Goal 用量，不再只结算逻辑请求的最后结果。恢复、重试和 fallback 各有独立样本，未知用量保持未知。
- 每个实际请求前复查绑定的 Goal；未准入不产生 usage 样本。有界 Goal 用量未知时立即停止后续请求。账本触发停止仍保存已发出 attempt 的样本，资源错误继续优先。
- summary 每次 attempt 结束后立即结算 Goal，Session 保留既有 context_compacted 最终增量和上下文替换；其他失败样本另存 usage，失败时保存全部样本，不新增 schema、不重复计量。
- [agent-loop](../../src/agent/agent-loop.ts) 将自动压缩 prepareStep 中的 LoopStoppedError 返回为 stopped 和对应原因，不误包装为压缩错误。
- 用量存储失败保留 PersistenceError，不被同时 steering、fallback 或网络重试替代。新增生产 Session 压缩增量和该并发情形的回归。

双语 README、RUNTIME、AGENT_LOOP、DECISIONS 和 PLAN 已同步。没有新增依赖、公共参数、第二套 runner 或持久化协议。

## 当前验证证据

相关 Agent、stream、provider、runner、exec、公开 SDK 检查 132/132 通过，日志 everpeace-submit-settlement-focused-20261009.log。补充压缩、持久化、循环和 Session 恢复检查 47/47 通过，日志 everpeace-submit-settlement-expanded-20261009.log。这些集合存在重叠，不相加作为总测试数量。

首次 typecheck 发现原先新测试的 CreateSessionInput 缺少必需的 titlePending；按真实接口补充 false 后从头执行门禁，未放宽类型或删除断言。首次类型日志 everpeace-submit-0320-typecheck-20261009.log 保留。

最终串行门禁：typecheck 通过 → 当前 manifest 没有 lint script → test 935 项、932 通过、0 失败、0 cancelled、3 项平台跳过（52,332.3488 ms）→ build 通过。宿主临时目录日志 everpeace-submit-0320-{typecheck,test,build}-final-20261009.log。完整 suite 包含本地真实进程、HTTP/stdio 协议和 SDK fixture；不构成付费模型效果或真实终端验收。

本地 Windows 证据绑定当前源码与展示版本；新远端 CI 必须按本次推送的实际 HEAD 核对。git diff --check、32 份交付文件空白检查、45 份文档的 966 个本地链接路径检查通过，包含新增归档，未使用旧结果代替。

## 未完成范围与用户原有内容

PLAN 的完整生产验收、最终 candidate 的 preflight/fixture proof、独立评分和付费计划仍须继续。Windows LSP 的 direct-socket probe 当前未通过，保持失败关闭；不削弱隔离、不采用宿主回退。任意 detached 后代、其他原生平台，以及真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 尚需独立证据。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 保持原样，不纳入本次提交。当前新 provider、资源错误、测试、SDK fixture 与两份交接归档属于本次交付。

## 交付后核对

main 已推送 05ee4c2eb0d3216b3396d8f2d4c448fae846be84，标题为 fix: settle model requests and await stream cleanup [skip publish]。Windows/Linux [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37828696799) completed/success；[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37828696487) completed/skipped。远端 HEAD 与本地提交一致，27 个 Release 的 ID、tag 和更新时间未改变，未创建 v0.3.20 tag。用户原有未跟踪内容保留，交付后 tracked 工作区干净。后续手动压缩与辅助请求所有权工作另见当前交接，不属于此历史验证。
