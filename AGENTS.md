# Everpeace Agent Guide

本文件保存每个新 Codex Session 都需要掌握的长期知识。实时进度、已完成事项和下一步以 `docs/HANDOFF.md` 为准；如果文档与当前代码或测试冲突，以当前代码和测试结果为准。

## 新 Session 的启动顺序

1. 完整读取本文件和 `docs/HANDOFF.md`。
2. 执行 `git status --short --branch` 和 `git diff`，确认当前分支及已有修改。
3. 只打开与 `HANDOFF` 当前下一步直接相关的源文件；不要重新调查已经确认且未被代码推翻的结论。
4. 把已有 tracked/untracked 改动视为用户工作。不要 reset、checkout、清理或覆盖无关内容。
5. 开始修改前先确认受影响的测试和文档；完成后更新 `docs/` 中对应状态。

## 项目基础

- Everpeace 是 Node.js 22+、TypeScript、ESM 项目，使用 `pnpm@10.22.0`。
- CLI/TUI 入口位于 `src/cli/`；界面使用 React + Ink，并保持 inline terminal 模式。
- Agent 是 Responses API 驱动的 ReAct 循环，支持需确认的 Bash、无需确认的只读网页搜索和公共网页读取。
- `/permissions` 管理进程内应用层权限：默认 ask 逐条审批 Bash，read-only 禁用模型 Bash，full-access 经二次确认后免审批；网页工具可独立禁用。当前没有 OS 沙箱，不得声称等同于 Codex Auto。
- `read_file`、`list_directory` 始终限定当前工作目录。权限不从 JSONL 恢复，切换权限不得重建 Agent 或丢失 context；直接 `!` 仍由用户主动执行。对标与安全限制见 `docs/architecture/PERMISSIONS.md`。
- 支持官方供应商和兼容端点；模型名称必须保留供应商返回的官方 model ID。
- API Key 只由 `AuthStorage` 和系统 keyring 管理，不得写入注册表 JSON、session JSONL、日志、测试快照或 UI。

常用命令：

```powershell
pnpm dev
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

## Session 必须保持的语义

- 每个 session 使用一个版本化 JSONL 文件，默认放在平台应用状态目录；各 session 的追加写入需要串行化。
- 可见 `timeline` 与 Responses API `context` 分开持久化。直接 `!` 命令可以出现在恢复后的界面中，但不能进入模型 context。
- 没有活动 session 时，第一条普通问题先创建 session，再请求模型并持久化后续内容。
- `/new` 要求已有活动模型，并立即创建和进入标题为“新 Session”的空 session；它不是 `/clear` 的别名。
- `/new` 创建的记录使用持久化的 `title_pending: true`。第一条问题先提供可靠回退标题，再异步调用当前模型生成简短名称，不能阻塞正常回答。
- `/clear` 只清屏并解除当前 session；下一条普通问题才创建新 session，同时保留当前模型。
- `/resume` 全局列出所有 session，按最后活动时间倒序显示名称和时间，并恢复 timeline、context、模型及工作目录，然后继续写入原文件。
- `/status` 打开 Codex 风格独立命令窗口，显示当前模型、base URL 对应供应商、context window 和 session 累计 token；窗口隐藏 banner、历史、composer 和全局状态栏，Esc 原子恢复原 Session，窗口不写入 session timeline 或模型 context。
- 信息型 slash command 和选择型 picker/wizard 都使用独立命令窗口；`/new`、`/clear`、`/exit` 保持立即动作。这些界面都不进入可恢复 timeline，命令造成的真实状态变化仍按各自语义持久化，普通聊天、Agent 工具输出和直接 `!` 命令继续写入可恢复 timeline。
- 主 Agent 的 Responses usage 按 session 持久累计；标题请求不计入。切换模型保留累计 token，但在新模型完成响应前重置或未知当前 context 占用。
- 原模型缺失时允许用户选择替代模型并保留 context；原工作目录不存在时拒绝恢复并保持当前会话不变。
- JSONL 损坏必须按文件隔离；只允许忽略不完整的最后一行。旧记录缺少 `title_pending` 时按 `false` 处理。
- JSONL 事件目前包括 `session_created`、`title_updated`、`timeline_entry`、`context_append`、`model_selected` 和 `usage_recorded`；改变 schema 时必须考虑向后兼容并补测试。

## TUI 与终端不变量

- Ctrl+C 取消活动任务；空闲有草稿则清空，否则退出。TUI 的 PTY stdin 必须由 Ink 单一入口转发，不能同时注册原始 stdin 监听器。
- `/outputs`、`/history`、`/terminal-setup` 都是独立命令窗口。output timeline 可带兼容性可选 command 元数据；直接 `!` 仍不进入模型 context。
- 模型 Bash 运行时使用有界真实首五行/尾五行预览并随终端高度缩减；用户直接 `!` 继续优先显示最近五行。完成态折叠和 `/outputs` 保留现有语义。
- 输入历史单独持久化，不记录登录向导字段；配置终端按键必须预览、明确确认和备份，不能静默修改用户设置。

- 保持 inline TUI 和终端原生 scrollback；不要切换到 alternate screen。
- transcript 恢复继续通过同步输出进行原子重放，避免历史被 Ink 重绘覆盖。
- 原始 PTY 控制序列不得直接写入 Ink stdout；保留现有清洗、流式输出和终端模式复位行为。
- `web_search` 和 `web_fetch` 使用兼容端点支持的普通 function call；联网失败必须作为工具结果返回模型，不能让整轮对话直接崩溃。
- `web_fetch` 只能访问公共 HTTP/HTTPS 地址，必须校验每次重定向并阻止 localhost、内网和链路本地目标；网页内容始终视为不可信数据。
- 修改布局时必须继续保证 resize 后历史不丢失、只存在一个 prompt、输入行不会占用终端自动换行单元格。
- 不要破坏普通滚轮、Ctrl+滚轮缩放、直接 `!` 命令流式输出及 Bash 确认流程。
- 输入开头的 `/` 必须显示 slash command 前缀筛选菜单；候选窗口最多八项，并保留方向键选择、Enter 执行、Tab 补全和 Esc 关闭语义。
- Slash command 独立窗口必须保持 inline 且不使用 alternate screen；进入时同步清屏并只渲染当前命令，Esc 后从内存同步重放原 Session。加载中允许返回的操作必须忽略迟到结果，不得写入 `Static` 历史、JSONL 或模型 context。
- 所有独立命令窗口通过共享布局水平、垂直居中，外框最大 80 列并在窄终端保留左右安全边距；字段和值保持左对齐，resize 后必须重新居中且不得泄露历史。

## 关键代码入口

- `src/storage/session-store.ts`：JSONL schema、存储路径、读写、列表、恢复和兼容逻辑。
- `src/agent/react-agent.ts`：ReAct 循环、初始 context 和增量持久化 callback。
- `src/agent/agent-loop.ts`：Codex 核心控制流程的 TypeScript 适配，采样、结果记录、工具执行、后续采样与终止；来源和边界见 `docs/architecture/AGENT_LOOP.md`。
- `src/tools/web.ts`：网页搜索、公共网页读取、正文提取、大小/超时限制和 SSRF 防护。
- `src/tui/app.tsx`：TUI 状态机、session 生命周期、`/new`、`/resume`、命名和目录切换。
- `src/tui/components/session-picker.tsx`：session 选择界面。
- `src/tui/dependencies.ts`：默认依赖、SessionStore、标题请求和工作目录切换。
- `src/storage/auth-storage.ts`：凭据和模型注册信息边界。
- `tests/unit/storage/session-store.test.ts`：session 存储及兼容性回归。
- `tests/unit/tui/app.test.tsx`：TUI 与完整 session 流程回归。
- `docs/architecture/DECISIONS.md`：已经确定的架构语义。
- `docs/PLAN.md`：当前目标及验收计划。
- `docs/HANDOFF.md`：最近状态、验证结果和下一步。

## 修改与交付规则

- 先做最小、聚焦的修改，不顺手重构无关代码。
- 功能、行为、接口、测试状态或发布状态变化时，同一批改动必须更新相关 `docs/`；至少检查 `PLAN.md`、`architecture/DECISIONS.md` 和 `HANDOFF.md`。
- 用户可见命令、输出或安装方法变化时，同时更新 `README.md` 和 `README.zh-CN.md`。
- Session 或 TUI 改动至少运行相关单测；交付前默认运行 `pnpm test`、`pnpm typecheck`、`pnpm build` 和 `git diff --check`。如果无法运行，必须明确说明原因和未验证范围。
- 测试数量和 commit/hash 属于易变化状态，只记录在 `docs/HANDOFF.md`，不要固化在本文件。
- 未经用户明确要求，不提交、推送、打 tag 或创建 Release。
- 发布时更新 `package.json` 版本及 README 中的展示版本，验证后提交并推送。`.github/workflows/release.yml` 会根据版本创建 `v<version>` tag 和 GitHub Release，必须确认 workflow 与 Release 实际成功。
