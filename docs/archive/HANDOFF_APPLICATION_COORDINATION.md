# 当前交接

更新日期：2026-10-08。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 选择专题。第一阶段整体框架与验证基线的 [交接](HANDOFF_FRAMEWORK_BASELINE.md) 和 [计划](PLAN_FRAMEWORK_BASELINE.md) 已归档；更早 Plan 交付见 [归档](HANDOFF_PLAN_EXECUTION.md)。

## 当前基线与授权

- 第二阶段开始 main HEAD：`348d872b91b8073378e7fef6fffa1bea856c31b5`；package.json 与双语 README 为 `0.3.12`。
- 第二阶段实现已提交并推送 main：`364066cbd9f7886f0d3f9d8d93176f4d2d29dd4e`，提交标题为 `refactor: isolate application coordination [skip publish]`。
- CI 冷启动测试修正已推送 main：`a1a035a0da564d86de698b3c05fee4f51b62b3ab`，下述最终 CI 对此实现与测试内容验收。
- 用户明确授权交付第一阶段、更新展示版本、提交推送并开始第二阶段，禁止更新 Release。所有交付提交使用 `[skip publish]`，只推送 main，不创建或推送 tag。用户另明确允许已有 GitHub 凭据仅在内存中用于 Release 和 CI 只读核对，不输出或保存。
- 本轮按状态所有者提取任务与会话协调：不改变公共 CLI/SDK 参数、Session schema 或用户操作；不继续实施 Agent 引擎等后续模块。单 Agent、Responses、Windows/DeepSeek 优先和离线验收保持。

## 第一阶段交付

展示版本已同步更新，依赖声明及 lockfile 未变。交付前在宿主环境重新串行执行 typecheck → 记录缺少 lint → test → build，全部存在项通过；测试 824 项，821 通过、0 失败、3 个原有跳过，耗时 54,391.0418 ms。日志为宿主临时目录 everpeace-framework-delivery-test-20261008.log。

提交 `348d872b91b8073378e7fef6fffa1bea856c31b5` 已推送 main。[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37765498726) 与 Publish version job 实际 skipped；推送前后 27 条 Release 的 ID、tag 和更新时间完全一致，远端 `v0.3.12` tag 不存在。[Test workflow](https://github.com/VinceTree/Everpeace/actions/runs/37765498802) 的 Linux job 通过，Windows job 在 App 测试进程耗尽约 2 GB 堆后失败，exit 134，不能记作断言通过。

## 第二阶段实现

- [ApplicationCoordinator](../../src/runtime/application-coordinator.ts) 拥有当前 Session／Agent 身份、模式、模型任务准入／取消、Plan 批准和命令操作身份，不依赖 React、Ink 或 TUI；TUI 每次挂载持有一个实例，React 状态只作展示投影。
- 取消保留任务占位直到 runner 清理；同一任务句柄才能释放，旧完成不能释放新任务。成功会话替换或 Agent 替换使旧身份及批准失效，初次惰性创建只附着当前任务；宿主会话操作失败不替换身份。
- 批准复制完整标题／正文，消费与执行准入同步完成。取消、重复和迟到结果不能复活批准，讨论／退出模式使其失效；runner 仍决定验证、Goal 和 Memory 结算，fork_pending_resume 保持原持久债务语义。
- [TUI App](../../src/tui/app/app.tsx) 委托上述状态，保留存储／目录 I/O、审批、直接 PTY、guidance、历史与重放。修正清空期间迟到的初次创建不得重新绑定旧 Session，旧 Plan 清理仍释放入口但不把旧错误／批准投影到新会话；清理期间尚未处理的 guidance 返回草稿等待重交。双语 README 同步说明。
- 项目地图、运行时与状态契约、TUI 结构和架构决策同步归属；既有 public factory、runner、Session 实现与公共入口不另建一套。

## 第二阶段验证

[协调状态回归](../../tests/unit/runtime/application-coordinator.test.ts) 10 项通过；TUI、Plan、Session、runner、SDK、生产闭环定向共 116 项通过。随后新增清空期间迟到创建／Plan 清理两项 TUI 回归通过；严格类型检查通过，原有断言未移除或放宽。日志为宿主临时目录 everpeace-coordination-targeted-test-20261008.log。

扩展草稿返回断言时，测试误等非空草稿不会显示的空输入 placeholder；改为等待实际 Agent 重建、guidance 入队和草稿返回，再以 Ctrl+C 清空后验证空闲 prompt。相关 5 项回归重测通过，没有跳过或放宽语义断言。

针对第一阶段 Windows CI 的 App 进程 OOM，以相同 Node 22.23.3、CI 环境变量和 512 MB 堆复核：第一阶段独立临时快照 68 项通过，第二阶段 70 项通过，未复现 CI 失败。发现测试库保留卸载后的渲染器及输出帧，App 夹具增加 afterEach 清理和帧释放，清理前保留所有断言；再次以相同 Node／环境和 512 MB 堆运行 70 项通过。该处理限制测试间累积，不将未复现的 CI 根因声称为已定位；后续两次 Windows CI 均完成 App 回归且未再 OOM。

最终宿主串行门禁：pnpm typecheck 通过 → scripts 缺少 lint，明确缺项 → pnpm test 836 项、833 通过、0 失败、3 个原有跳过，耗时 49,331.751 ms → pnpm build 通过。测试日志为宿主临时目录 everpeace-coordination-delivery-test-20261008.log。git diff --check、新增文件空白及 13 份相关文档的 476 个本地链接／标题通过。第二阶段证据为离线机制回归，不能代替真实终端或真实模型评测。

第二阶段首次 [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37770025378) 对协调实现提交运行，Linux job success；Windows 完成全部 App 回归且未再 OOM，但既有 stdio 初始化恢复测试失败，健康第二代超过 fixture 的 2 秒冷启动期限，重试后返回第三代。调整测试连接期限为 10 秒、恢复观察 20 秒、总上限 45 秒，首代仍明确不回应初始化，所有恰好两代、旧进程先退出、binding 失效及不重放断言保留，生产策略未改。

冷启动预算修正后，Node 22.23.3／CI 环境的两项真实 stdio 回归通过；再次宿主串行执行 typecheck → 缺少 lint → test → build，所有存在项通过，完整测试 836 项、833 通过、0 失败、3 个原有跳过，耗时 49,589.7811 ms。日志为宿主临时目录 everpeace-coordination-recovery-final-test-20261008.log。差异与 14 份相关文档的 480 个本地链接／标题通过。

最终 [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37771371373) 对 `a1a035a0da564d86de698b3c05fee4f51b62b3ab` 的 Windows／Linux jobs 均 success，包含 typecheck、完整 test、build 和差异检查。Windows 836 项，832 通过、0 失败、4 跳过，耗时 190,360.998 ms；Linux 836 项，833 通过、0 失败、3 跳过，耗时 69,808.26747 ms。Windows hosted runner 额外跳过原生 sandbox 真实初始化，证据边界见 [开发指南](../DEVELOPMENT.md#独立测试-ci-与证据范围)。末尾收尾只更新交接和计划，不改变已验收的实现与测试。

第二阶段未改 package.json，Release workflow 没有产生新的 run；最终再次只读核对 27 条 Release 的 ID、tag 和更新时间与展示版本更新前相同，远端 `v0.3.12` tag 仍不存在。

## 独立验收与后续

真实 Windows Terminal 手工验收仍 pending：Plan 修订输入、取消、resize／scrollback、恢复及单 prompt。Windows LSP backend 的网络隔离门禁仍 unavailable，失败不回退宿主；live 评测需独立授权和数值预算。本轮没有模型请求或 Release 操作。

后续顺序见 [PLAN](../PLAN.md)：Agent 引擎 → 工具与进程 → 存储与恢复 → 终端交互，开始下一模块前再细化一个具体问题。TypeScript 解析 API 标为 unstable，升级编译器时须复核依赖检查。

## 用户原有内容

开始交付时 tracked 修改均为上一轮第一阶段内容；交付后只剩用户未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`，全部保留且不纳入提交。
