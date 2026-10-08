# 当前交接

更新日期：2026-10-08。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 选择专题。第二阶段任务与会话协调的 [交接](HANDOFF_APPLICATION_COORDINATION.md) 和 [计划](PLAN_APPLICATION_COORDINATION.md) 已归档；更早验证见 [归档索引](README.md)。

## 当前基线与范围

- 第三阶段开始 main HEAD：`1139804fd7f50b6031004fea9b005bd4e61286e3`，与 origin/main 同步；本次交付按用户授权将 package.json 与双语 README 从 `0.3.12` 同步更新为 `0.3.13`，依赖声明与 lockfile 不变。
- 用户本次要求开始第三阶段。首轮仅整理 Agent 引擎的逻辑 step 工具目录，逐项推进，不一次拆分整个 ReactAgent。
- 共享 production factory、Responses、单 Agent、Windows／DeepSeek 优先和离线验收保持；公共 CLI/SDK 参数、Session schema、工具定义及用户操作不变。
- 用户明确授权提交、推送、更新版本，禁止更新 Release。本次使用 `[skip publish]`，只推送 main，不创建或推送 tag；不调用真实模型。此前交付记录见第二阶段归档，已有 GitHub 凭据授权仍仅限在内存中用于 Release／CI 只读核对。

## 第三阶段首轮实现

- 新增 [StepToolCatalog](../../src/agent/step-tool-catalog.ts)，拥有当前逻辑 step 的广告工具定义、名称准入、MCP binding 和并发资格。保持既有 Plan／coding 工具集合和顺序，按可用宿主能力选择工具；外部定义和 metadata 深复制并冻结。
- [ReactAgent](../../src/agent/react-agent.ts) 不再分别保存工具数组、名称 Set 和 MCP Map。请求参数、稳定前缀、context inspection、dispatch 与 loop 的并发准入共用目录；所有独立 step 来源准备成功后构建，普通 retry 复用，follow-up／steering 刷新，turn 收尾释放。
- MCP metadata 只为当前广告工具保留 binding；MCP annotations 或内置工具形状的 MCP 名称不能取得本地读取的并发资格。返回的能力对象独立，不让调用方修改目录内事实；LSP 保持串行。
- 工具实际路由、实时权限、审批、取消／预算、文件观察、durable record 和 runner 验证结算保持原职责；目录不授权操作、不执行工具、不保存权限、不从 Session 恢复。
- 运行时、Agent loop、项目地图、架构决策、开发指南和计划同步上述边界，第二阶段证据归档到现有知识库；没有新增平行知识库或空模块目录。

## 验证证据

严格类型检查通过。首次检查暴露 MCP 定义缺少 Record 索引签名，沿用原有对象复制方式构建定义解决，没有扩大生产接口、使用 any 或忽略错误。

新增 [目录回归](../../tests/unit/agent/step-tool-catalog.test.ts) 6 项，覆盖 Plan 排除执行能力、可选工具准入、嵌套定义隔离、binding 隔离和保守并发。强化既有 MCP hints 回归以实际启用宿主并发；新增 [loop 集成回归](../../tests/unit/agent/loop-boundaries.test.ts) 2 项，覆盖真实本地读取并发与 MCP 屏障、按模型顺序落盘、准备失败不得采样和跨 turn 清除准入。原有断言保留。

Agent、workflow context、context inspection／pruning、production factory、Plan 生产闭环和 SDK 定向共 122 项通过，0 失败、0 跳过，耗时 6,522.2306 ms。日志：宿主临时目录 everpeace-step-catalog-targeted-20261008.log。

实现完成后在宿主 Node 环境串行执行：pnpm typecheck 通过 → scripts 缺少 lint，明确缺项 → pnpm test 844 项、841 通过、0 失败、3 个既有跳过，耗时 59,330.4523 ms → pnpm build 通过。日志：宿主临时目录 everpeace-agent-catalog-final-test-20261008.log；构建已生成新工具目录的 JS 与声明文件。git diff --check、14 份修改／新增文件空白和 14 份相关文档的 468 个本地链接／标题检查通过，双语 README 的知识库入口保持一致。测试包含现有依赖边界、Plan／TUI／Session／SDK 与生产 runner 回归。

## 本次交付结果

更新展示版本后重新在宿主串行执行 typecheck → 记录缺少 lint → test → build，所有存在项通过。测试 844 项、841 通过、0 失败、3 个既有跳过，耗时 59,678.5638 ms；日志为宿主临时目录 everpeace-agent-catalog-delivery-test-20261008.log。17 份修改／新增文件空白与 14 份文档的 468 个本地链接／标题检查通过。

第三阶段实现与展示版本已提交并推送 main：`f355b96ab2af7ca2784dabbbe41e3a9a02120ba1`，标题为 `refactor: unify step tool admission [skip publish]`。推送前后只读核对 27 条 Release 的 ID、tag 和更新时间完全一致，远端 `v0.3.13` tag 不存在。[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37777947178) 与 Publish version job 均实际 skipped；没有创建或更新 Release。

[Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37777947141) 对上述实现提交的 Windows／Linux jobs 均 success，包含 typecheck、完整 test、build 与差异检查。Windows 844 项、840 通过、0 失败、4 跳过，耗时 198,045.9137 ms；Linux 844 项、841 通过、0 失败、3 跳过，耗时 98,721.445625 ms。Windows hosted runner 额外跳过原生 sandbox 真实初始化，证据边界见 [开发指南](../DEVELOPMENT.md#独立测试-ci-与证据范围)。基线文档提交的 [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37772227355) 也已 success。收尾只更新交接和计划，不改变已验收的实现与测试。

## 独立验收与后续

真实 Windows Terminal 手工验收仍 pending：Plan 修订输入、取消、resize／scrollback、恢复及单 prompt。Windows LSP backend 网络隔离门禁仍 unavailable，失败不回退宿主；live 评测需要独立授权和数值预算。自动回归不能代替这些验收。

后续按 [PLAN](../PLAN.md) 从 Agent 请求投影／上下文中选择一个具体问题；随后依次推进工具与进程、存储与恢复、终端交互。不因交接待办自动启动下一模块。TypeScript unstable 解析 API 在升级编译器时仍须复核。

## 用户原有内容

第三阶段开始时没有 tracked 修改。原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，未修改或纳入本轮内容。

## 交付收尾补记

第三阶段文档收尾已推送 main：`9e65c4ea413d00de76d1bed03b255d6fe9356938`，标题为 `docs: record step catalog validation [skip publish]`；对应 [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37779559564) 的 Windows／Linux jobs 均 success。收尾未改实现、测试或 package.json，未产生新的 Release workflow。
