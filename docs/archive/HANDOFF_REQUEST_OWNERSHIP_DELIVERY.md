# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。上次逐次请求计量的实现、验证和实际交付见 [归档](../archive/HANDOFF_REQUEST_SETTLEMENT_DELIVERY.md)。

## 本次交付与授权

用户明确要求提交、推送、更新版本，但不要更新 Release。此次交付覆盖当前手动压缩、请求关闭与辅助准入实现及文档；展示版本从 0.3.20 更新为 0.3.21，package.json 与双语 README 一致。交付前 main/origin/main 为 05ee4c2eb0d3216b3396d8f2d4c448fae846be84；本次准确提交 ID 以本文件所在提交的 Git 记录为准。

已核对 [Release workflow](../../.github/workflows/release.yml)：main push 涉及 package.json 时触发，但提交正文包含 [skip publish] 会跳过 Publish version job；[Test workflow](../../.github/workflows/test.yml) 独立执行 Windows/Linux 检查。本次仅提交和推送 main，不创建或推送 tag，不创建或更新 Release，不使用 [skip ci]。推送前保存了 27 个 Release 的 ID、tag 和更新时间，未发现 v0.3.21 tag；交付后须比较该基线、远端 HEAD 及本次 HEAD 的实际 CI，不能引用旧 CI 替代。最终核对结果在本轮交付答复记录。

没有调用付费模型。总目标仍是完整实现 DeepSeek 优先、Windows 优先的个人 Node/TypeScript 编码 CLI；上一轮和本轮都属于进展，不能视为 [PLAN](../PLAN.md) 全部验收完成。后续开发不自动重复版本/提交/推送；付费测试另需明确授权及 task/campaign 数值预算。

## 本次实现与失败证据

手动压缩旧实现没有绑定 Goal、缺少互斥与关闭等待。原始生产回归 9 项全部断言失败，日志 everpeace-manual-compaction-baseline-final-20261009.log；辅助生产 SDK 路径和 Goal 缺口回归另有 6 项中的 2 项失败，日志 everpeace-auxiliary-goal-baseline-final-20261009.log。初次辅助 fixture 的 Windows import 路径启动失败不作为语义证据；修正为模块 URL 后才取得上述失败结果。

- [ReactAgent](../../src/agent/react-agent.ts) 的手动 native/DeepSeek 压缩绑定 active/已受限 Goal，预取消不发请求，预算和 unknown 在 fallback 或第二次压缩之前停止；Session 的 context_compacted 与 usage 样本保持兼容并只计一次。
- 手动压缩期间拒绝 turn、task reset、设置变更和第二次压缩。Agent 为 turn/压缩持有取消控制器和完成 Promise；dispose 先关闭准入，取消并等待请求、持久化及后台清理。重复关闭共享结果，资源与存储错误不被取消替代。
- [AuxiliaryRequestExecutor](../../src/agent/auxiliary-request-executor.ts) 复用原 RequestExecutor。独立标题、Skill、Memory、doctor 操作各有准入账本；累计显示保留 unknown 并继续增加后续已知用量。后台 Memory job 的提取/合并按 job signal 共享账本，用量缺口后禁止继续合并，job 保存为 failed，不自动重试。资源故障关闭整个辅助所有者。
- 辅助服务关闭取消并等待所有已准入请求和计量，登记所有权早于 provider callback；已可靠返回的 usage 即使迟到取消也保留，结果不报告成功。[GoalRuntime](../../src/goal/runtime.ts) 自身也保持 usage 缺口，后续可靠样本及重建不能清除。
- 提交复核补出 Memory 重排队缺口：网络、不完整、空白响应会让同一 job 换用新 controller/账本；可靠失败响应的 Memory 自身用量也少记。新增 5 项回归全部失败，日志 everpeace-submit-0321-memory-retry-baseline-final-20261009.log。Memory job 现在自身复用 RequestExecutor/ledger，错误路径有缺口即保存 failed，可靠响应 usage 在校验前保存，仍允许可计量的普通重试。最初无效 JSON case 被原解析器容忍，超时不作为缺陷证据，最终负向用真实空白响应重新证明。
- [TUI](../../src/tui/app/app.tsx) 为手动压缩的 usage/budget 停止显示英文说明，Esc 返回原 Session。取消发生在 context 已持久化后仍保持落盘与内存一致，不误报成功或重复计量。

双语 README、RUNTIME、STATE_AND_UI、MEMORY、DECISIONS 和 PLAN 已同步；没有新增依赖、持久化 schema 或平行 runner。旧测试按“无 signal”判断第二次请求的假设已改为实际请求次数及组合信号取消断言，没有删除取消检查。

## 当前验证证据

最终串行门禁：typecheck 通过 → 实际 manifest 没有 lint script → test 964 项、961 通过、0 失败、0 cancelled、3 项平台跳过（53,748.2717 ms）→ build 通过。宿主临时目录日志 everpeace-submit-0321-{typecheck,test,build}-final5-20261009.log。此证据绑定本次源码和展示版本；完整 suite 含真实进程及协议 fixture，但不构成付费模型效果或真实 Windows Terminal 验收。

扩展离线所有权检查 132/132 通过，日志 everpeace-request-owner-focused-20261009.log；包括生产 Agent/Session/Goal、Memory jobs、真实 SDK fake-fetch fixture 和 Ink 回归，集合不与完整 suite 相加。

交付首次 typecheck 通过，实际 manifest 没有 lint script。首次完整 test 为 957 项、953 通过、1 失败、0 cancelled、3 项平台跳过；失败为新增 /compact 输入时序回归超时，日志 everpeace-submit-0321-test-final-20261009.log 保留，按首败停止未执行 build。等待宿主 idle composer 后 App 与第二次完整门禁通过，但补充 Memory 后第三次 suite 仍偶发 UI 超时，日志 everpeace-submit-0321-test-final3-20261009.log 保留，不将旧通过结果作为最终验证。最终将两种停止情形分别放入独立 fixture，确认实际草稿已接收后才 Enter，保留停止说明、一次调用、Esc 和原 Session 的所有断言，不放宽超时；App 74/74 通过，日志 everpeace-submit-0321-compact-ui-final-20261009.log。

Memory、辅助执行器、生产 Agent/手动压缩与实际 SDK 检查 44/44 通过，日志 everpeace-submit-0321-memory-retry-focused-final-20261009.log。首次正向测试在条目已写、job 尚未删除时过早断言，现等待 job 删除持久化完成，保留终态及用量断言。

第四次完整 suite 的新子案例仍在 Esc 返回处失败（不是停止说明或准入失败），日志 everpeace-submit-0321-test-final4-20261009.log。窗口画面可先于被替换组件的输入 effect；Ink 的 raw-mode 清理会重置待处理 Esc。最终测试在一次性输入前用 React act/同一树 rerender 完成 committed effects，临时 act 环境标记在 finally 恢复，不等待固定延时。App、ReactAgent、runner 与 Memory 按原并发度 4 共 167/167 通过，日志 everpeace-submit-0321-compact-ui-effects-20261009.log，未改变生产 UI 或删减原断言。

git diff --check、本次 28 份文件空白检查、46 份文档的 984 个本地链接路径检查通过，双语展示版本与 package.json 一致。远端本次 CI 须按本文件所在提交核对，实际交付结果在本轮最终答复记录；上轮 CI 成功已归档，不作为本次源码的验证。

## 未完成范围与用户原有内容

PLAN 完整生产验收、最终 candidate 的 preflight/fixture proof、独立评分和付费计划仍须继续。Windows LSP 的 direct-socket denial probe 当前未通过，保持失败关闭；不削弱隔离、不采用宿主回退。任意 detached 后代、其他原生平台，以及真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 尚需独立证据。自动测试和本地 fake provider 不构成真实模型效果或真实终端验收。

用户原有未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 保持原样，不纳入提交。本次新增辅助请求执行器、对应单测、生产压缩测试、SDK fixture 和逐次请求交付归档属于本次交付。

## 实际交付补证

实际交付提交为 45401588a16f3205bee413fe92a1fbb00294d9c0，main/origin/main 一致；提交标题 fix: track request ownership and preserve usage limits [skip publish]。展示版本 0.3.21 与 package.json、双语 README 一致。

[Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37837256980) 绑定上述 HEAD，run_attempt 2 completed/success，Windows/Linux 两项均 success。首次 Windows 的既有 Bash abort 回归因 15 秒 testTimeout 取消，0 断言失败、1 cancelled；未修改源码或放宽测试，只重跑失败的 Windows job，Linux 首次成功保持。此记录不把首轮取消当作成功。

[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37837257002) 与 Publish version job 均 completed/skipped。交付后 27 个 Release 的 ID、tag、updated_at 与推送前基线逐项一致，远端无 v0.3.21 tag。本轮交付答复前再次只读查询，远端 HEAD、两平台 CI、跳过的发布 job 和 Release 清单仍一致；没有追加 tag 或修改 Release。