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
- Agent 是 Responses API 驱动的 ReAct 循环，支持按权限 profile 审批模型 shell、网页搜索、公共网页读取和 MCP tools，并按需加载 Codex 主机 Skills。
- `/permissions` 管理进程内审批策略：`read-only` 允许工作区读取但对模型 shell/web/MCP 逐条审批，`ask` 对三者逐条审批，默认 `workspace-write` 免逐条 shell 和已开启公共 web 审批但 MCP 仍需审批，`full-access` 经二次确认后免工具审批；Plan 模式把已开启的公共 web 请求视为只读调研并免逐次 web 确认，关闭网页工具仍拒绝请求。网页工具可独立禁用。模型 shell 分别进入固定 `@openai/codex` CLI 的 `:read-only`、`:workspace` 或 `:danger-full-access` profile，失败时不得回退宿主直跑；直接 `!` 不进 sandbox。仍不得声称等同于 Codex Auto 或完整 Codex runtime。
- MCP 从 `codex mcp` 配置加载 stdio/Streamable HTTP tools；`/mcp` 刷新状态。Skills 扫描项目/用户/admin/system 根，显式 `$name` 只作用当前轮，隐式匹配通过 `read_skill` 渐进读取；同名冲突不得进入 catalog 或按名称读取。`/skills` 提供 AI 创建单文件 Skill、手动编辑、公开 HTTPS URL 暂存/预览/确认安装、已安装内容查看及 `$name` 回填；Git 来源先 no-checkout clone 并检查有界 tree，同名镜像清单优先保留规范 `skills/<name>` 目录，100 个候选限制在名称去重后执行，只 sparse checkout 已校验的候选目录。项目目标为仓库根 `.agents/skills`，用户目标为 `$CODEX_HOME/skills`，不得覆盖既有名称。完整支持范围和限制见 `docs/architecture/CODEX_CAPABILITIES.md`。
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
- `/new` 要求已有活动模型，并立即创建和进入标题为“New Session”的空 session；它不是 `/clear` 的别名。旧记录中的“新 Session”只在界面显示时翻译，不改写 JSONL。
- `/new` 创建的记录使用持久化的 `title_pending: true`。第一条问题先提供可靠回退标题，再异步调用当前模型生成简短名称，不能阻塞正常回答。
- `/clear` 只清屏并解除当前 session；下一条普通问题才创建新 session，同时保留当前模型。
- `/resume` 全局列出所有 session，按最后活动时间倒序显示名称和时间，并恢复 timeline、context、模型及工作目录，然后继续写入原文件。
- `/status` 打开 Codex 风格独立命令窗口，显示当前模型、base URL 对应供应商、context window 和 session 累计 token；窗口隐藏 banner、历史、composer 和全局状态栏，Esc 原子恢复原 Session，窗口不写入 session timeline 或模型 context。
- 信息型 slash command 和选择型 picker/wizard 都使用独立命令窗口；`/mcp` 使用可取消的 transient 加载/信息窗口，`/skills` 使用可取消的多步管理向导；`/new`、`/clear`、`/exit` 保持立即动作。这些界面都不进入可恢复 timeline，命令造成的真实状态变化仍按各自语义持久化，普通聊天、Agent 工具输出和直接 `!` 命令继续写入可恢复 timeline。
- 主 Agent 的 Responses usage 按 session 持久累计；标题请求不计入。切换模型保留累计 token，但在新模型完成响应前重置或未知当前 context 占用。
- 原模型缺失时允许用户选择替代模型并保留 context；原工作目录不存在时拒绝恢复并保持当前会话不变。
- JSONL 损坏必须按文件隔离；只允许忽略不完整的最后一行。旧记录缺少 `title_pending` 时按 `false` 处理。
- JSONL 事件目前包括 `session_created`、`title_updated`、`timeline_entry`、`context_append`、`model_selected`、`usage_recorded` 和 `goal_updated`；改变 schema 时必须考虑向后兼容并补测试。`goal_updated` 保存 Session 绑定的 `/goal` 快照，旧文件没有该事件时按无目标兼容读取。

## TUI 与终端不变量

- Ctrl+C 取消活动任务；空闲有草稿则清空，否则退出。TUI 的 PTY stdin 必须由 Ink 单一入口转发，不能同时注册原始 stdin 监听器。
- 模型轮次运行期间保留 guidance composer；真实 Agent 支持时补充消息立即进入 transcript，并在采样/工具结果安全检查点应用，未启动调用补齐 `steered` output；Ctrl+C 时持久化已提交的待处理 guidance。无 steering 接口的替身继续 FIFO 排队。直接 `!` 的交互式 PTY 运行期间继续独占 stdin。
- `/outputs`、`/history`、`/terminal-setup` 都是独立命令窗口。output timeline 可带兼容性可选 command 元数据；直接 `!` 仍不进入模型 context。
- Responses SSE 可用时模型文字、审批、工具状态和重试实时展示，不可用时回退 buffered 阶段显示。模型 Bash 运行时使用有界真实首五行/尾五行预览并随终端高度缩减；用户直接 `!` 继续优先显示最近五行。完成态折叠和 `/outputs` 保留现有语义。
- TUI 宿主界面使用英文；模型等待状态包含 provider、耗时和 Ctrl+C 提示。assistant Markdown、代码围栏、shell 命令和严格识别的 unified diff 使用分层高亮；超大或未知内容必须安全退回纯文本，旧 JSONL 只做显示层翻译。
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
- `src/codex/cli.ts`、`src/tools/bash.ts`：固定 Codex CLI 解析、sandbox profile 启动、失败关闭和模型 shell 输出。
- `src/mcp/runtime.ts`：Codex MCP 配置读取、stdio/Streamable HTTP 连接、工具目录和调用。
- `src/skills/catalog.ts`：主机 Skill roots、frontmatter、同名冲突、catalog、显式激活和资源读取。
- `src/skills/manager.ts`、`src/tui/components/wizards/skill-wizard.tsx`：Skill 创建、公开 URL 安全暂存/安装、作用域选择、预览确认和管理界面。
- `src/tui/app/app.tsx`：TUI 状态机、session 生命周期、`/new`、`/resume`、命名和目录切换。
- `src/tui/components/navigation/session-picker.tsx`：session 选择界面。
- `src/tui/app/dependencies.ts`：默认依赖、SessionStore、标题请求和工作目录切换。
- `docs/architecture/TUI_STRUCTURE.md`：TUI 源码目录职责和依赖方向。
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
- Git commit message 必须聚焦本次实际改动，使用功能新增、功能优化、缺陷修复、测试补充或文档更新等具体表述。commit message 中禁止出现任何产品名称（包括但不限于 Codex、Pi、OMP），也禁止出现 `release`、`version`、“发布”、“版本”等措辞；即使提交伴随发版或版本号调整，也必须按实际功能变化命名，例如 `feat: add bounded command output previews`。
- 未经用户明确要求，不提交、推送、打 tag 或创建 Release。
- 发布时更新 `package.json` 版本及 README 中的展示版本，验证后提交并推送。`.github/workflows/release.yml` 会根据版本创建 `v<version>` tag 和 GitHub Release，必须确认 workflow 与 Release 实际成功。
