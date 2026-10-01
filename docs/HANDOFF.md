# 当前交接

更新日期：2026-10-01。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选专题；本文件只保存当前状态，不再累计全部历史。旧记录完整保留在 [历史交接](archive/HANDOFF_HISTORY.md)。

## 当前基线

- 产品：DeepSeek 优先、Windows 优先的单 Agent 个人开发 CLI；Node/TypeScript 单包、Responses、inline TUI。
- 开始本次文档整理时：`main` 与 `origin/main` 一致，HEAD 为 `cc2fa54c0fdda5c4e81c0ee6a1cf7e36e3d98852`，package 展示版本 `0.3.1`。本轮交付将展示版本提升为 `0.3.2`；这是起点与交付状态记录，不代替下一次实际 `git status`。
- 上次交付使用 `[skip publish]`；不创建 tag 或 GitHub Release，测试 CI 独立运行。本次整理文档并按用户授权更新展示版本、提交和推送；继续使用 `[skip publish]`，不得创建 tag 或 GitHub Release，也没有付费模型调用。

## 本次完成：开发知识库

- 根 `AGENTS.md` 改为长期规则 + 按任务阅读入口；`docs/README.md` 是唯一知识库索引，`dosc/README.md` 仅导航。
- 增加产品概览、项目地图、运行时、工具、状态与 UI、开发指南；每个机制链接实际源码与回归测试。
- 原有权限、sandbox、MCP/Skills、Memory、Agent Loop、TUI 分层和 benchmark 深入文档继续复用。
- 当前计划和交接与历史分离，旧 PLAN/HANDOFF 归档保留；修正旧说明中的原生压缩限定、并发开关及过时编辑保护描述。
- 中英文 README 增加开发知识库入口。后续先读相关专题，再按需阅读修改点，避免重复全仓调查。

## 已实现的核心状态

| 领域 | 当前事实 | 机制入口 |
| --- | --- | --- |
| 编码闭环 | TUI/benchmark 共用 CodingTaskRunner；任务拥有后台进程；最终验证、三轮诊断、取消复查、Goal/Memory 统一结算 | [RUNTIME](architecture/RUNTIME.md) |
| 请求与预算 | coding、重试/恢复、fallback、summary 和辅助请求在 attempt 边界计量；unknown sticky；流超时先关闭再重试 | [RUNTIME](architecture/RUNTIME.md) |
| 文件与规则 | 原始字节版本绑定；BOM/CRLF、审批/回滚冲突；根到目标规则刷新和未送达规则拦截 | [TOOLS](architecture/TOOLS.md) |
| 搜索与导航 | 有界搜索结果分页及续读；显式本地 LSP 提供定义/引用/实现/hover | [TOOLS](architecture/TOOLS.md) |
| 状态与终端 | timeline/context 分离、恢复验证债务、inline 独立窗口、实时 guidance 和取消 | [STATE_AND_UI](architecture/STATE_AND_UI.md) |
| 性能与评测 | 四 worker 有序持久化和背压、阶段 trace；内部 campaign、生产 adapter、dsh profile 和独立评分 | [BENCHMARKING](BENCHMARKING.md) |

十项 Chalk/Commander/Day.js fixtures 的 pristine pass → designated seed failure → reference pass 已在前次工作中离线证明；本次文档整理没有重复运行 fixture proof。源码 pin、锁文件与材料见 [任务 catalog](benchmark/DEEPSEEK_NODE_TASKS.json)。离线 proof 不调用模型，但克隆源码和安装依赖仍可能需要网络。

## 已知限制与下一步

1. **先核对 dsh 外部执行证据**：固定 checkout 的依赖/build 及生成的 headless profile 仍需真实启动验收；仅存在 adapter 和模拟测试不能证明上游可执行。流程见 [评测指南](BENCHMARKING.md)。
2. **真实比较待授权**：九次 smoke，再九十次正式比较；需要另行授权及原始 model ID、task/campaign 数值 token 预算。本次不授权付费。没有相对 dsh 的成功率、耗时或 token 优势结论。
3. **真实 Windows Terminal 待验收**：失败 → 修复 → 全部检查通过、Ctrl+C 无残留后台 writer、Session 恢复、命令窗口重放与 resize。自动测试不代替真实模型终端证据。
4. **LSP 隔离尚未接通**：当前查询协议只读，但配置的 executable 直接由宿主 `spawn`，未走模型 shell 的原生执行边界；只能配置可信本地程序。后续接入 sandbox 是实现待办，不是本轮修复。
5. **平台与统计边界**：GitHub Actions Windows 上的一项真实 native sandbox 用例显式跳过；跨平台策略测试不等于平台隔离验收。辅助 usage 当前按 TUI dependency 实例累计，不是完整的 Session 历史账本。
6. 后续能力按 [PLAN](PLAN.md) 评估同项目历史检索、`@file` 等；不自动开展多 Agent、公开 SDK/ACP 或插件架构重写。

## 验证证据

本次在现有工作区使用 Windows Node 工具链重新执行：

- `pnpm test`：418 项，416 通过、2 跳过、0 失败/取消；同样包含用户未跟踪测试，不能充当全新 checkout 的计数。
- `pnpm typecheck`、`pnpm build`：均通过。
- 本轮 tracked 文档 `git diff --check -- AGENTS.md README.md README.zh-CN.md docs` 通过；新增文档另行检查空白与本地链接。当前与归档共 24 份 Markdown 已扫描，无失效本地路径链接。
- 全工作区 `git diff --check` 仍只报告原有 `.gitignore`、`LICENSE` CRLF 差异，未修改这两个文件。
- 本轮未改运行时代码、测试、依赖或 workflow，未新跑 clean-checkout CI、live API、fixture proof 或真实 Windows Terminal。

前次交付记录：Windows Node 22 下 `pnpm test` 共 418 项，416 通过、2 项跳过、0 失败；`pnpm typecheck`、`pnpm build` 通过。该本地数量包含未跟踪测试，不能直接当作 clean-checkout CI 数量。前次完整差异检查只报告用户已有 `.gitignore`、`LICENSE` CRLF 行尾，排除二者后通过。

## 用户已有差异

本轮开始前 `.gitignore`、`LICENSE` 有未暂存 CRLF 差异；未跟踪 `.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`tests/unit/codex/`、`{}`。这些内容均不属于本轮文档整理，不清理、不覆盖、不自动纳入提交。

交接只是快照；下一轮仍要查看实时 Git 状态。新增文档在未提交前也属于需保留的工作区内容。
