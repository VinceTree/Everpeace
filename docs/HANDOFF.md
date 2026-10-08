# 当前交接

更新日期：2026-10-08。先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择专题。第三阶段工具目录的 [交接](archive/HANDOFF_STEP_TOOL_CATALOG.md) 和 [计划](archive/PLAN_STEP_TOOL_CATALOG.md) 已归档；更早证据见 [归档索引](archive/README.md)。

## 当前基线与范围

- 第四阶段开始 main HEAD：`9e65c4ea413d00de76d1bed03b255d6fe9356938`，与 origin/main 同步；package.json 与双语 README 为 `0.3.13`。
- 用户要求开始第四阶段，随后明确授权更新版本、提交并推送，禁止更新 Release。首轮聚焦工具与进程中的后台任务准入和完整结算，继续使用现有 BackgroundJobManager、shell、原生 sandbox 和 runner。
- 公共 CLI/SDK 参数、Session schema、工具定义、权限与文件观察边界不变。双语 README 同步可查询启动失败和清理／销毁期间拒绝启动的行为。
- 本次交付已将 package.json 与双语 README 更新为 `0.3.14`，使用 `[skip publish]` 提交标记，只推送 main，不打 tag 或创建／更新 Release，不调用真实模型。已有 GitHub 凭据授权仍仅限在内存中用于 Release／CI 只读核对。

## 第四阶段首轮实现

- [BackgroundJobManager](../src/tools/background-jobs.ts) 在调用执行器前登记运行占位及真实完成 promise。预先取消不启动 worker；同步抛错和异步失败统一为可查询的失败 job，释放父信号监听并发出一次完成通知，不自动重放。
- 结果、终态和完成时间一起发布；完成观察者异常不改变结算。运行及取消清理期间保留有效预览，终态后忽略迟到 callback；poll 快照不共享内部结果或数组。
- stop、waitAll 与 stopAll 等待已登记任务的完成 promise；等待中的取消先收束 worker，空列表也尊重已取消信号。stopAll 期间的新启动返回 BACKGROUND_CLEANUP，重叠清理全部完成后恢复；dispose 立即永久关闭启动，重复调用共用清理 promise，后续 start 返回 BACKGROUND_DISPOSED。
- Agent 沿用当前 generation／完成通知／durable record；runner 沿用后台等待和任务准入。没有第二套进程、通知、runner 或存储实现，工具／运行时契约、项目地图、决策与开发指南同步状态归属。

## 验证证据

修改前新增 7 项管理器语义回归，全部复现现有缺口，原有 5 项通过；日志为宿主临时目录 everpeace-background-baseline-20261008.log。实现后 12 项全通过，再补启动期间重入 dispose 回归及空列表预取消断言。

[管理器回归](../tests/unit/tools/background-jobs.test.ts) 新增 8 项，覆盖同步抛错及父信号解绑、预取消、重入限额、启动期间销毁、原子终态、快照隔离、重叠清理与迟到输出。新增 [Agent 回归](../tests/unit/agent/react-agent.test.ts) 验证同步失败可 poll、按序配对持久化、一次失败通知及不重放；新增 [runner 回归](../tests/unit/workflow/task-runner.test.ts) 使用真实 ReactAgent 和受控 worker，验证取消后仍占用入口且不开始宿主验证，worker 完成后才返回取消。

严格类型检查通过。Agent 集成初次定向失败来自新断言误以为完成通知是 JSON；按既有文本格式绑定 job ID 与 failed 状态修正，不改变生产输出或放宽原有断言。修正后后台、Agent、loop、runner、生产入口、Plan、SDK、Bash 和原生启动定向 134 项，133 通过、0 失败、1 个原有 Unix 平台跳过，耗时 5,253.3247 ms。日志为宿主临时目录 everpeace-background-lifecycle-targeted-final-20261008.log。

实现完成后在宿主 Node 环境串行执行：pnpm typecheck 通过 → scripts 缺少 lint，明确缺项 → pnpm test 854 项、851 通过、0 失败、3 个既有跳过，耗时 54,365.0849 ms → pnpm build 通过。日志为宿主临时目录 everpeace-background-lifecycle-final-test-20261008.log。git diff --check、16 份修改／新增文件空白及 14 份文档的 536 个本地链接／标题检查通过。全部门禁覆盖现有权限、文件观察、Plan／TUI／Session／SDK、资源与 runner 回归。

## 授权交付

版本更新后重新在宿主 Node 环境串行执行：pnpm typecheck 通过 → lint 脚本缺项 → pnpm test 854 项、851 通过、0 失败、3 个既有跳过，耗时 53,249.6519 ms → pnpm build 通过。日志为宿主临时目录 everpeace-background-lifecycle-delivery-test-20261008.log，构建产物已重新生成。git diff --check、17 份修改／新增文件空白及 14 份文档的 536 个本地链接／标题检查通过，package.json 与双语 README 版本一致。

第四阶段实现与版本更新已提交并推送 main：`eabe173432149785aaeaca9f7b2a5b5b144ef3d2`，标题为 `fix: enforce background job lifecycle [skip publish]`。远端 main 精确匹配该提交；推送前后 27 条 Release 的 ID、tag 和 updated_at 逐项一致，远端 v0.3.14 tag 不存在。[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37784586991) 与 Publish version job 均实际 skipped；没有创建或更新 Release。

[Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37784587059) 对上述实现提交的 Windows／Linux jobs 均 success，包含 typecheck、完整 test、build 与差异检查。Windows 854 项、850 通过、0 失败、4 跳过，耗时 125,704.0268 ms；Linux 854 项、851 通过、0 失败、3 跳过，耗时 67,862.952919 ms。Windows hosted runner 跳过原生 sandbox 真实初始化等既有平台项目，证据边界见 [开发指南](DEVELOPMENT.md#独立测试-ci-与证据范围)。收尾只更新交接和计划，不改变已验收的实现、测试或 package.json。

## 独立验收与后续

本轮新增证据验证管理器和受控 worker 的 Promise 完成边界。底层 runBash／runCodexProcess 取消路径仍保留既有 500ms fallback，进程树停止／失败的实际结算应在下一轮单独复核。原生 sandbox、真实 Windows Terminal 和真实模型质量不由受控 Promise 测试证明。

真实 Windows Terminal 手工验收仍 pending：Ctrl+C、后台进程树、Plan 修订输入、resize／scrollback、恢复与单 prompt。Windows LSP backend 网络隔离门禁仍 unavailable，失败不回退宿主；live 评测需要独立授权与数值预算。

后续按 [PLAN](PLAN.md) 细化工具／进程的下一项具体问题，再推进存储与恢复、终端交互；第三阶段其余请求／上下文职责保留为独立后续事项。不因交接待办自动启动新模块。TypeScript unstable 解析 API 在升级编译器时仍须复核。

## 用户原有内容

第四阶段开始时没有 tracked 修改。原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，未修改或纳入本轮内容。
