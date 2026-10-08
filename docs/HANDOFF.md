# 当前交接

更新日期：2026-10-08。先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择专题。第四阶段后台任务的 [交接](archive/HANDOFF_BACKGROUND_JOB_LIFECYCLE.md) 和 [计划](archive/PLAN_BACKGROUND_JOB_LIFECYCLE.md) 已归档；更早证据见 [归档索引](archive/README.md)。

## 当前基线与范围

- 第五阶段开始 main HEAD：`6484320a03dfffa4e21755b2cff0de03a7b6903b`，与 origin/main 同步；package.json 与双语 README 为 `0.3.14`。
- 用户要求开始第五阶段，随后明确授权更新版本、提交并推送，禁止更新 Release。首轮只修复 Session 搜索结果与内部缓存共享可变恢复状态的问题；继续使用现有 SessionStore、JSONL、LRU 与恢复路径。
- 公共 CLI/SDK 参数、Session schema、匹配规则、分页、缓存大小和用户操作流程不变。Session 持有持久事实，搜索缓存持有内部投影，调用方拥有独立返回快照；搜索和预览不授予权限、文件观察或验证成功。
- 本次交付已将 package.json 与双语 README 更新为 `0.3.15`，提交均带 `[skip publish]`，只推送 main，不打 tag 或创建／更新 Release，不调用真实模型。已有 GitHub 凭据授权仍仅限在内存中用于 Release／CI 只读核对。

## 第五阶段首轮实现

[SessionStore.search](../src/storage/session-store.ts) 原来直接返回缓存中的 summary 引用。修改返回标题会改变后续匹配；修改其嵌套 Goal、workflow、TaskProgress、Memory policy 或 lineage 会污染后续搜索显示，却没有对应持久事件。

返回 summary 现在通过 structuredClone 深度隔离，覆盖冷读和缓存命中；match 与 preview 原本已按值生成，继续沿用。复制发生在返回结果边界，不冻结调用方对象，不关闭缓存，不重新扫描日志，也不建立另一套存储或恢复实现。

[SessionStore 回归](../tests/unit/storage/session-store.test.ts) 覆盖标题／模型修改后再次匹配，以及父子 Session 的嵌套模型设置、Goal、验证命令／债务、清单、Memory policy 和 lineage 隔离；计数器确认 warm hit 不增加日志读取。重启后的 list／load 与搜索快照一致，父 usage 的 unknown 不被后续样本掩盖，fork 子 usage 仍重置为既有语义。

[Picker 回归](../tests/unit/tui/session-picker.test.tsx) 使用真实 SessionStore 与 Ink 组件，允许选择回调修改自己取得的快照，再次键入查询和 Enter 仍取得保存的标题；未改变 TUI 生产组件或命令流程。

## 验证证据

两项新增存储语义回归在修复前均失败：原标题查询丢失结果，嵌套恢复状态被改写。首次新 fixture 漏填模型设置的 maxOutputTokens，按真实接口补齐并通过严格类型检查后再取得上述基线。日志为宿主临时目录 everpeace-search-isolation-baseline-20261008.log。

修复后完整 SessionStore 28 项通过；加入真实 picker 后定向 30 项全部通过、0 失败，耗时 2,016.9368 ms。日志为宿主临时目录 everpeace-search-isolation-picker-20261008.log。

扩大 Session／流式重放／历史／附件、Agent 重建、status、picker／App、Memory 和 SDK 定向回归：187 项、186 通过、0 失败、1 个既有平台跳过，耗时 17,780.8056 ms。日志为宿主临时目录 everpeace-search-isolation-recovery-20261008.log。最终类型门禁首败来自新 picker 回归显式传入可选 signal 的 undefined；按 exactOptionalPropertyTypes 在缺省时省略字段修正，没有扩大生产接口。

修正后重新在宿主 Node 环境串行执行：pnpm typecheck 通过 → scripts 缺少 lint，明确缺项 → pnpm test 857 项、854 通过、0 失败、3 个既有跳过，耗时 62,692.7772 ms → pnpm build 通过，构建产物已重新生成。日志为宿主临时目录 everpeace-search-isolation-final-test-20261008.log。git diff --check、14 份修改／新增文件空白以及 13 份文档的 473 个本地链接／标题检查通过。原有断言保留，公共接口与 Session schema 未变；双语 README、状态契约、决策、项目地图与开发指南已同步。

## 授权交付

版本更新后重新在宿主 Node 环境串行执行：pnpm typecheck 通过 → lint 脚本缺项 → pnpm test 857 项、854 通过、0 失败、3 个既有跳过，耗时 61,548.1775 ms → pnpm build 通过，构建产物已重新生成。日志为宿主临时目录 everpeace-search-isolation-delivery-test-20261008.log。git diff --check、15 份修改／新增文件空白及 13 份文档的 473 个本地链接／标题检查通过；package.json 与双语 README 版本一致。

第五阶段实现与版本更新已提交并推送 main：`ca93704e328c8cac454fedd63a3db4dc8df65826`，标题为 `fix: isolate session search snapshots [skip publish]`。远端 main 精确匹配该提交；推送前后 27 条 Release 的 ID、tag 与 updated_at 逐项一致，远端 v0.3.15 tag 不存在。[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37788803971) 与 Publish version job 均实际 skipped；没有创建或更新 Release。

[Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37788803972) 对上述实现提交的 Windows／Linux jobs 均 success，包含 typecheck、完整 test、build 与差异检查。Windows 857 项、853 通过、0 失败、4 跳过，耗时 198,367.7301 ms；Linux 857 项、854 通过、0 失败、3 跳过，耗时 100,948.783777 ms。Windows hosted runner 跳过原生 sandbox 真实初始化等既有平台项目，证据边界见 [开发指南](DEVELOPMENT.md#独立测试-ci-与证据范围)。收尾只更新交接和计划，不改变已验收的实现、测试或 package.json。

## 独立验收与后续

本轮证据仅验证搜索返回对象、缓存和恢复事实的隔离，不代表完成所有存储优化。下一轮再细化 Session 重放／状态投影、usage、历史附件或 Memory 中的一个具体问题，随后进入终端交互；第四阶段原生进程取消的 500ms fallback 仍作为独立事项，不混入存储修复。

真实 Windows Terminal 手工验收仍 pending：Ctrl+C、后台进程树、Plan 修订输入、resize／scrollback、恢复与单 prompt。Windows LSP backend 网络隔离门禁仍 unavailable，失败不回退宿主；live 评测需要独立授权和数值预算。离线与双平台 CI 证据不替代真实终端验收。

## 用户原有内容

第五阶段开始时没有 tracked 修改。原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，未修改或纳入本轮内容。
