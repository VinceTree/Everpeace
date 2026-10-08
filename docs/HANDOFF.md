# 当前交接

更新日期：2026-10-08。先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择专题。第五阶段 Session 搜索快照的 [交接](archive/HANDOFF_SESSION_SEARCH_SNAPSHOTS.md) 和 [计划](archive/PLAN_SESSION_SEARCH_SNAPSHOTS.md) 已归档；更早证据见 [归档索引](archive/README.md)。

## 当前基线与范围

- 第六阶段开始 main HEAD：`a4e0cca5cfa256ab5993ce25d88582ef3179c864`，与 origin/main 同步；package.json 与双语 README 为 `0.3.15`。
- 用户要求开始第六阶段，随后明确授权更新版本、提交并推送，禁止更新 Release。本轮只处理 Composer 提交与草稿的生命周期：React 更新前重复提交，以及旧完成回调清空新草稿。不同时整理全部终端状态或此前模块。
- 生产修改仅在 [Prompt](../src/tui/composer/prompt.tsx)；保持现有 App、ApplicationCoordinator、Agent、runner、附件读取和 Session 恢复。公共 CLI/SDK 参数、Session schema、快捷键、权限和取消／清理路径不变。
- 本次交付将 package.json 与双语 README 更新为 `0.3.16`，提交使用 `[skip publish]`，只推送 main，不打 tag 或创建／更新 Release，未调用真实模型。GitHub 凭据仅在内存中用于 CI／Release 只读核对；推送前已有 27 条 Release，远端 v0.3.16 tag 不存在。

## 第六阶段首轮实现

Prompt 原来依靠异步提交后的 React submitting 状态停用输入，连续 Enter 或提交回调同步重入可在渲染前再次调用宿主。接收成功又无条件清空共享 editorRef 和历史导航，旧输入框的 Promise 会覆盖后来挂载或宿主恢复的新草稿。

现在调用宿主前同步占用当前输入，普通按键和粘贴都检查这份占用。完成回调核对挂载身份、提交身份与提交时的 ComposerState 对象，只有原挂载的未替换草稿可以清空；卸载立即使旧回调失效，resize／普通重渲染保留身份。false、同步抛错和 Promise 拒绝继续保留草稿并释放当前输入，等待用户明确重交，不自动重试。

挂载内提交占用只保护输入适配；模型任务准入、Session／Agent 身份、附件取消和资源清理仍由已有宿主路径承担。没有增加第二套任务状态机、存储或持久事件。

[提交回归](../tests/unit/tui/prompt-submission.test.tsx) 用实际 Ink 输入与受控 Promise 覆盖连续 Enter、输入／粘贴、resize、一次接收、重挂载、新草稿／光标／killBuffer／历史导航、卸载后迟到接收、宿主同步替换草稿、回调重入和失败重交。[App 回归](../tests/unit/tui/app.test.tsx) 使用真实临时文件附件解析，确认只启动一次，进入 guidance 后正常编辑，resize 和任务结束保留草稿，空闲 Ctrl+C 清草稿，命令窗口 Esc 重放同一历史并保持单 prompt。

## 验证证据

新增提交生命周期回归在修复前 9 项中有 5 项语义失败：连续 Enter 与重入均重复调用，旧挂载回调和宿主替换草稿均被清空。日志为宿主临时目录 everpeace-prompt-submission-baseline-20261008.log。原有断言保留，没有扩大生产接口、使用 any 或忽略类型错误。

修复后输入框／历史／编辑器定向 18 项全部通过，耗时 1,928.4375 ms；日志为 everpeace-prompt-submission-focused-20261008.log。加入真实附件 App 路径以及 Plan、command surface 和协调回归后，8 份测试文件 106 项全部通过、0 失败、0 跳过，耗时 14,471.6496 ms；日志为 everpeace-prompt-submission-integration-20261008.log。

最终在宿主 Node 环境串行执行：pnpm typecheck 通过 → package scripts 缺少 lint，明确缺项 → pnpm test 867 项、864 通过、0 失败、3 个既有平台跳过，耗时 54,318.4853 ms → pnpm build 通过，Prompt JS 与声明产物已重新生成。完整测试日志为宿主临时目录 everpeace-prompt-submission-final-test-20261008.log。

首轮本地实现的 git diff --check、15 份修改／新增文件空白，以及 14 份文档的 492 个本地链接／标题检查通过；双语 README 展示版本与 package.json 一致。当时修改未暂存、未运行远端 CI；后续授权交付证据见下节。

## 授权交付

更新展示版本后重新串行验证：typecheck 通过 → lint 脚本缺项 → pnpm test 867 项、864 通过、0 失败、3 个既有平台跳过，耗时 56,177.5415 ms → build 通过。本机启动器最初无输出退出，改用实际 pnpm Node 入口并重定向日志，确认命令正文与退出码；不把无输出调用当作验证证据。宿主临时目录日志为 everpeace-composer-delivery-typecheck-20261008.log、everpeace-composer-delivery-test-20261008.log 和 everpeace-composer-delivery-build-20261008.log。git diff --check 通过；package.json 与双语 README 均为 `0.3.16`。

首轮修复已提交并推送 main：`1e762bb880adc4a72f89cccf786e61f572230ba6`，标题为 `fix: guard composer submissions and preserve drafts [skip publish]`。[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37801243422) 与 Publish version job 均实际 skipped；推送前后 27 条 Release 的 ID、tag 与 updated_at 一致，远端 v0.3.16 tag 不存在。仅纳入 Composer 修复、回归、相关文档与展示版本，原有无关未跟踪内容保留。

[首轮 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37801243361) 的 Windows／Linux 均因新增 Prompt 回归的输入时序失败：画面刷新早于 passive input effect 恢复，下一次输入丢失；false／reject 的固定延时也不能保证重交就绪。失败均在新测试，无生产代码修改。测试改为观察独立 stdin 的 readable 订阅停用／恢复，再结算受控 Promise 和发送下一次单次输入；重复 Enter／粘贴仍同步连续发送，保留所有原断言，不增大超时或自动重试输入。

修正后输入回归 14 项通过；再次串行 typecheck 通过 → lint 缺项 → test 867 项、864 通过、0 失败、3 个既有跳过，耗时 55,239.9873 ms → build 通过。宿主临时日志前缀为 everpeace-composer-input-ready-，包含 focused、typecheck、test、build 的 20261008.log。git diff --check 通过；12 份修改文档的 466 个本地链接路径有效，双语 README 展示版本与 package.json 一致。

测试修正已提交并推送：`67940c3dc0fa2dbc5aed4eff397ad49e5f3f9320`，标题为 `test: await composer input subscriptions [skip publish]`。[修正后 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37802133169) 的 Windows／Linux jobs 均 success，包含 typecheck、完整 test、build 和差异检查。Linux 867 项、864 通过、0 失败、3 跳过，耗时 94,140.785129 ms；Windows 867 项、863 通过、0 失败、4 跳过，耗时 165,418.2297 ms。Windows hosted runner 的额外原生 sandbox 跳过仍遵循开发指南的证据边界。该补充提交没有触发 Release workflow；收尾仅更新交接和计划，提交继续带 `[skip publish]`，不改变已验收的实现、测试或展示版本。

## 独立验收与后续

本轮证据只覆盖输入提交与草稿归属，不能视为完成全部终端优化。下一轮先细化审批／命令输入所有权、取消或重放中的一个具体问题；模型任务准入和资源清理继续保留既有所有者。

真实 Windows Terminal 手工验收仍 pending：连续 Enter／附件提交、Ctrl+C、Plan 修订输入、resize／scrollback、命令 Esc 重放、恢复与单 prompt；离线 fake provider、Ink 与 CI 不代替实际终端体验。运行方式及步骤见 [开发指南](DEVELOPMENT.md#离线-windows-terminal-手工验收)。

第四阶段原生进程取消的 500ms fallback、第三阶段请求／上下文职责及第五阶段其余存储优化保持独立事项。Windows LSP backend 网络隔离仍 unavailable，失败不回退宿主；live 评测需要独立授权与数值预算。

## 用户原有内容

第六阶段开始时没有 tracked 修改。原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，未修改或纳入本轮内容。
