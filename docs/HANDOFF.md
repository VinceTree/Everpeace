# 当前交接

2026-11-01：用户要求继续优化 harness 并做好定位，明确选择优先加强「编码闭环的可靠性与完成质量」，随后授权自动提交和推送。工作从干净候选开始，复用当前 checkout；本地分支 `codex/harness-goal-reliability` 基于 main `7f6efcf8c41f5444829a913ba30ea2e8a83d2bbb`。展示版本仍为 `0.6.0-rc.4`，不调用付费模型、不创建 Release；门禁通过后提交使用 `[skip publish]`，保留 CI。

PR #20 已完成交付，详情移入 [归档](archive/HANDOFF-2026-10-31-pr20.md)。旧 CI 和门禁不作为本轮修改的证据。

## 定位与本轮变化

定位明确为 DeepSeek 优先、Windows 优先，面向个人 Node/TypeScript 单包开发的 coding harness。CLI、exec、SDK 共用生产运行层，把模型、项目上下文、工具、隔离执行、Session 与宿主验证接成闭环。双语 README、产品概览、使用指南、运行时和决策同步这项定位。

先通过真实 ReactAgent + GoalRuntime 的合成 provider 调度复现四个失败：迟到完成覆盖用户暂停、覆盖预算停止、完成替换后的新目标，以及同一回合三次 blocked 调用错误终止目标。修复前四项全失败，修复后通过；无真实模型请求。

- 完成意图绑定 goal_id 和宿主 goal_turn_id，只有同一仍活动目标可结算；暂停／恢复、替换、运行中用户追加需求和下一编码回合使旧意图失效。停止状态不接受模型重新覆盖。追加需求后必须有新的完成请求，旧意图不能沿用。
- GoalRuntime 按真实 coding turn 分配身份，每轮最多一份阻塞报告，稳定原因只以 SHA-256 摘要加入 Goal 元数据。不同原因或中间未报告阻塞会重置计数；第三个连续报告回合才 blocked。JSONL 重开保留回合依据；旧记录无身份则重新计数，blocked 恢复后重新审计。成功暂停／阻塞更新停止当前工具循环。
- 每个 coding step 刷新当前完整目标与状态，工具重试使用同一 step 快照；原生与 summary 压缩也携带当前 Goal，Plan 不引入执行 Goal 指令。目标按 JSON 任务数据提供，宿主提示要求逐项对照原要求与当前证据，不把通过代码检查等同于完成整个目标。
- Session 只增加可选 Goal 元数据字段，原始阻塞描述不复制到 Goal 记录；既有工具调用参数仍按原 Session 规则保存。未更改依赖、锁、产品版本、权限、验证 suite 或修复轮数。

## 验证证据

证据目录 `.cache/harness-goal-reliability/`。Goal 生命周期与 JSONL 专项已通过，生产压缩／runner／资源清理定向回归通过。第一轮完整门禁在 test 停止，1387 项中有一项旧故障注入因新增的回合前持久化而提前失败：fixture 把所有 Goal 写入都设为失败，尚未触及它要覆盖的请求后用量持久化阶段。已将该注入明确放到首个请求之后，保留一次请求、一次失败写入和零工具执行的原断言；另增回合持久化故障在零请求／零工具前停止的覆盖。四文件定向回归 60/60 通过，首轮失败和收据保留为 `test-initial-failure.log`、`gates-initial-failure.json`。

最终候选在 Node 22.19.0、pnpm 10.30.3 下重新发现脚本，串行 typecheck → lint → test → build 全部通过；1391 项测试中 1388 pass、3 个既有平台 skip、零 fail/cancelled。四项分别约 1.665、1.168、336.416、1.900 秒，test 含 pretest，Node suite 约 329 秒。对应 `{typecheck,lint,test,build}.log`、`gates.json`，903 份核心输入在验证前后摘要一致，绑定 SHA-256 `10bb07760eba2e8829ff1190932230bdb87d1148a5de84ef8669e9a1cb2714f8`，收据 `identity.json`。

另通过 167 份公开文档路径／链接、953 项双语文案及插值、workflow 固定身份、源码原生补丁核对与 CLI/SDK/PTY 安装烟测 7/7（零跳过）。对应 `{docs-verify,ui-verify,ci-verify,install-verify,install-smoke}.log`。完整门禁后只补文档验证收据，不再修改源码或测试；提交推送使用 `[skip publish]`，不触发只允许显式 workflow_dispatch 的 Release。

## 后续与限制

中间候选完整测试运行期间，独立合成 provider 复现追加需求后旧完成意图仍会提交，证据 `steering-baseline.log`。已补 accepted steering 清除旧意图，回归同时验证未重新请求则保持 active、重新审计请求后才可 complete；定向 11/11 通过。中间运行另存 `*-intermediate.log`，不作为最终源码证据，最终候选已重新执行上述四项门禁。

本轮先落实目标忠实性与 Goal 状态边界。下一步沿共享 runner 的最终异常收尾、模型终态及恢复验证债务检查，发现缺口先补可复现证据。宿主比较的是规范化阻塞描述的摘要，不能自动证明外部阻塞真实性或模型语义审计完整性。模型是否正确理解目标及真实编码成功率仍须独立真实评测，当前没有新付费授权或收益结论。

门禁使用任务所属的临时保持运行 helper，避免已知现代待机中断；不改永久电源设置，收尾通过删除 `.cache/harness-goal-reliability/keep-awake.active` 使其退出，实际进程记录留在忽略的证据目录。
