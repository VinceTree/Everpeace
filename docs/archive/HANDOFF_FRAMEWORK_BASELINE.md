# 当前交接

更新日期：2026-10-08。新 Session 先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 选择专题。上一轮 Plan 修订、批准等待与显式执行的 [交接](HANDOFF_PLAN_EXECUTION.md) 和 [计划](PLAN_PLAN_EXECUTION.md) 已归档；历史交付和 CI 只作为当时证据。

## 当前基线与范围

- 本轮开始 main HEAD：`59fb106989ded0a533e1350823fe6d6443e9a92d`；开始时 package.json 和双语 README 为 `0.3.11`；随后用户授权交付，已同步为 `0.3.12`，依赖声明未变。
- 用户授权实施全项目渐进优化的第一阶段：补齐类型门禁、建立可执行依赖边界、统一架构记录。后续模块只确定顺序，不在本阶段提取协调模块或新增产品能力。
- 保持单 Agent、Responses、Windows/DeepSeek 优先和离线验收。公共 CLI/SDK 参数、Session schema、权限、文件观察、宿主验证结算及操作流程不变；无真实模型评测或 Release 操作。

## 本轮实现

- [常规类型配置](../../tsconfig.json) 显式包含全部源码和测试 TS/TSX；[构建配置](../../tsconfig.build.json) 包含源码 TSX 并排除测试，保留严格选项和 ES2022。
- [TUI App 回归](../../tests/unit/tui/app.test.tsx) 修正 AgentTurnResult 替身返回值、可选参数、timeline 联合类型及完整 Memory 数据；辅助查找改用 ES2022 支持的反向循环。Prompt 回调返回 void，Skill metadata 使用真实 repo scope。原有断言保留，恢复后的最后一条 timeline 另增加类型收窄断言；生产接口未放宽。
- [架构回归](../../tests/unit/architecture/dependency-boundaries.test.ts) 用已安装 TypeScript 解析 API 扫描 runtime、Agent、workflow、exec、SDK，禁止 React、Ink、@inkjs/ui 与 TUI 依赖。覆盖普通／类型导入、重导出、字面量动态导入和路径边界；TUI/CLI 入口、正常核心依赖及注释／字符串允许。虚拟案例不写磁盘，快照和本地编译器子进程在 finally 中清理。
- [项目地图](../architecture/PROJECT_MAP.md#整体分层与状态归属) 与 [架构决策](../architecture/DECISIONS.md#全项目分层与验证基线) 记录五层职责、状态归属和依赖方向：应用协调决定准入与会话归属，runner 决定验证和完成。Session 持久事实与 UI 投影分开，批准、文件观察和活动进程保持原生命周期。
- 概览、项目地图与决策同步公开 everpeace/sdk 的 runTask、非交互 resume/Plan 事实；开发指南说明完整 TSX 类型检查、依赖回归及首败停止门禁。没有新增依赖、lint 工具、平行知识库或空模块目录。

## 本轮验证证据

Windows Node v22.19.0／pnpm@10.22.0。架构定向回归先通过，最终完整测试包含新增架构检查及其全部允许／禁止案例共 35 项，均通过；TUI、Plan、Session 与公开 SDK 回归也通过。

实际 tsc --listFilesOnly 对照 git ls-files：受版本控制的源码／测试共 198 份 TS、25 份源码 TSX、12 份测试 TSX，常规类型检查无遗漏；构建源码无遗漏、测试文件为零。新增架构测试也被常规配置显式纳入。严格选项与 ES2022 未改，未使用 any 或忽略错误消除测试契约差异。

最终在已获准的宿主 Windows 环境串行执行实际门禁：pnpm typecheck 通过；当前 package scripts 无 lint，明确记为缺项；pnpm test 共 824 项，821 通过、0 失败、3 个原有跳过，耗时 51,584.9967 ms；pnpm build 通过。没有新增跳过或移除原有断言，日志位于宿主临时目录 everpeace-framework-final-test-20261008.log。本轮结果是本地离线证据，不引用历史 CI 或声称新 CI 已运行。

git diff --check、新文件尾部空白检查和 12 份文档的 396 个本地链接／标题检查通过；新归档相对路径已按所在目录调整。中英文 README 的既有 SDK 说明与文档入口保持一致，本阶段没有用户命令、输出或安装方式变化。

用户授权交付后 package.json 与双语 README 同步为 `0.3.12`，并在宿主环境重新串行执行门禁：typecheck 通过，无 lint script；test 824 项，821 通过、0 失败、3 个原有跳过，耗时 54,391.0418 ms；build 通过。日志为宿主临时目录 everpeace-framework-delivery-test-20261008.log。Release 基线只读核对共 27 项，记录 ID、tag 与更新时间；提交使用 `[skip publish]`，远端结果将在第二阶段交接中补录。

第一阶段提交 `348d872b91b8073378e7fef6fffa1bea856c31b5` 已推送 main。[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37765498726) 与 Publish version job 实际 skipped；推送前后 27 条 Release 的 ID、tag 和更新时间完全一致，远端 `v0.3.12` tag 不存在。[Test workflow](https://github.com/VinceTree/Everpeace/actions/runs/37765498802) 已启动，后续结果单独核对，不以本地通过代替 CI。

## 独立验收与后续

真实 Windows Terminal 手工验收仍 pending：Plan 修订输入、取消、resize／scrollback、恢复与单 prompt。离线自动回归不代替真实终端，不证明真实模型成功率或成本收益；live 评测需另行授权和数值预算。Windows LSP backend 的网络隔离门禁仍 unavailable，启动失败不回退宿主。

后续顺序见 [PLAN](../PLAN.md)：任务与会话协调 → Agent 引擎 → 工具与进程 → 存储与恢复 → 终端交互。下一模块开始前先细化具体方案和回归，不把路线图当作立即实施授权。TypeScript 解析 API 标为 unstable，未来升级编译器时复核该回归。

## 用户原有内容

开始时 tracked 差异为空；已有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，没有清理或纳入本轮变化。用户随后授权更新展示版本、提交、推送并开始第二阶段；所有交付提交带 `[skip publish]`，只推送 main，不创建或推送 tag，不创建或更新 Release。交付门禁和远端核对完成后补录证据。
