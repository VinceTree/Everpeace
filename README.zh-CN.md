# Everpeace

终端 transcript 对齐 Codex 的 resize/reflow 行数上限：同步重放按终端保留尾部，VS Code 为 1,000 行、Windows Terminal 为 9,001 行、WezTerm 为 3,500 行、Alacritty 为 10,000 行，其他终端为 1,000 行。Ink 不提供最终布局测量，因此按源文本和当前终端宽度估算行数。Session JSONL、模型上下文、输入导航和 `/outputs` 继续保留完整数据。


[English](./README.md) | **简体中文**

Everpeace 是一个 DeepSeek 优先、Windows 优先、带 inline TUI 的个人开发 CLI，同时支持 OpenAI 和自定义 OpenAI-compatible Responses 端点。所选模型可以使用 Codex sandbox 中的 shell、检查并修改工作区、执行项目完整验证、搜索网页、调用已配置的 MCP tool，并加载本机 Codex Skill；你也可以用 `!<command>` 直接运行本地命令。

模型 API Key 不从环境变量读取，也不会写入项目或配置 JSON。Everpeace 使用操作系统凭据库保存 Key，并在本地模型注册表中只保存模型名、base URL 和凭据引用。用户自行配置的 MCP server 可按 Codex MCP 配置通过环境变量名引用 bearer token 或 header；两类凭据边界彼此独立。

## 需求

- Node.js 22+
- pnpm
- macOS/Linux 上的 Bash；Windows 模型命令在 Codex sandbox 内使用系统 PowerShell
- DeepSeek、OpenAI 或兼容服务的 API Key
- 能够通过 HTTPS 访问 Bing 或 DuckDuckGo，以及 Agent 需要读取的公共网页

## 开发运行

PowerShell：

```powershell
pnpm install
pnpm dev
```

macOS/Linux：

```bash
pnpm install
pnpm dev
```

启动后输入 `/login`。TUI 登录向导会依次选择服务地址、掩码输入 API Key，并从 `/models` 加载模型：

- DeepSeek 官方 API：`https://api.deepseek.com`
- OpenAI 官方 API：`https://api.openai.com/v1`
- 自定义 OpenAI-compatible base URL

API Key 不会显示在终端。模型列表加载成功后选择一个服务端返回的原始模型 ID，该模型会被安全保存并立即用于当前会话；如需执行有界的模型生成检查，请使用 `/doctor --live`：

```text
/login · 模型登录
❯ DeepSeek

API Key ❯ ********

选择一个模型：
❯ deepseek-flash
```

旧式管理子命令仍然可用：

```powershell
pnpm dev -- login
pnpm dev -- models
pnpm dev -- logout
```

macOS/Linux 上如果 `bash` 不在 `PATH` 中，可以显式配置：

```powershell
$env:EVERPEACE_BASH_PATH="/custom/path/to/bash"
```

## 使用

```text
✦ Everpeace Agent (v0.3.1) · 天下长平，以规司矩

╭──────────────────────────────────────────────────────────╮
│ model:     deepseek-flash   /model to change             │
│ directory: C:\projects\Everpeace                         │
╰──────────────────────────────────────────────────────────╯

› 列出当前项目文件

• 我将查看当前目录。

! ls -la
是否执行？ y
...

› !git status
...

› TypeScript 最新版本改了什么？

• 搜索网页：TypeScript 最新版本
• 读取网页：https://www.typescriptlang.org/...
...
```

对于依赖当前信息或冷门资料的问题，模型可以先调用 `web_search`，再使用 `web_fetch` 读取有价值的来源。搜索和网页读取不需要 Bash 确认；function call 及结果会保留在可恢复的模型上下文中，TUI transcript 则显示简短的工具动作。模型会被要求在最终回答中列出实际采用的来源 URL。

TUI 自身界面现统一使用英文。任务运行时会显示按供应商识别的状态，例如 `Waiting for DeepSeek (3s • ctrl+c to interrupt)`，进入工具调度阶段后切换为 `Working`；只有供应商真正发出 reasoning 阶段事件时，才显示独立计时的 `Thinking`。支持 Responses 流式端点时，模型文字和工具进度会即时显示；只有端点在发出任何事件前明确拒绝 streaming 时才切换到 buffered，流式中断或不完整响应会从最后一个已持久化上下文有界重试，不会执行半截工具调用。兼容的 buffered 端点仍显示阶段、审批和命令预览。模型回复支持 GitHub Flavored Markdown，包括标题、列表、强调、链接、表格、行内代码和 fenced code；代码块及 Bash/PowerShell 命令使用语言感知的终端高亮，超大内容会安全退回纯文本。

命令与对话正文使用不同层级展示：运行中显示 `Running`，完成的模型命令显示 `Ran`，用户直接命令显示 `You ran`，并附带状态色、shell、耗时和保留输出。模型 `diff` 代码块及命令输出中的标准 unified diff 会显示新旧行号、青色文件/hunk 标题、绿色新增和红色删除；真彩终端使用随明暗背景调整的底色，低色彩及 `NO_COLOR` 环境仍保留结构标记。恢复旧 Session 时，已知旧中文系统/工具提示只在显示层翻译，不改写 JSONL，也不翻译用户或模型正文。

输入区域会直接跟随终端的当前可用宽度，并预留最后一列防止 Windows Terminal 自动换行；启动时的 model/directory 信息框与 Codex 一样把内容区限制为 56 格（含内边距和边框共 60 列），每行预先裁剪，在窄终端中只缩短、不换行。输入区只有显式换行才会增高，过长输入会在当前行内水平裁剪，不会因 Ctrl + 滚轮缩放而自动折行。

TUI 使用原生 inline 模式，普通滚轮可以浏览已完成的 Everpeace 会话；Ctrl + 滚轮改变字号后，会采用 Codex 的 75ms 尾随延迟进行同步、基于源状态的重绘，完整恢复启动信息与会话，并且不会暴露清屏后的中间空帧。

第一次普通提问会创建本地 JSONL session。Everpeace 会保存对话记录和继续聊天所需的模型上下文，同时在后台单独调用当前模型，根据第一次提问生成简短名称。带信息或选择界面的 slash command 会打开独立临时窗口，隐藏 banner、历史、输入框和全局状态栏。命令窗口水平、垂直居中，最大宽度 80 列，并在窄终端自动缩小、保留安全边距。按 `Esc` 后原子重放并返回同一个 session，窗口内容不会加入历史。直接 `!` 命令的输出仍属于可恢复记录。`/new` 会立即创建并进入一个空 session，第一次提问后再替换临时名称。`/resume` 会按名称和最后活动时间列出本机全部 session，恢复原模型、原工作目录及上下文，并继续追加到同一个文件。Windows 下 session 默认保存在 `%APPDATA%\Everpeace\sessions`。

Everpeace 还会维护独立的 learned 经验记忆。workflow 验证完成并真实空闲五分钟后，当前模型可在后台提取最多三条带证据候选并整理无冲突经验；持久队列可跨 Agent 重建和进程重启恢复，前台工作会暂停后台请求。只有用户明确表达长期偏好时才写入用户级记忆。记忆位于平台应用状态目录（Windows 为 `%APPDATA%\Everpeace\memory`），不会写入仓库。每个逻辑 Agent step 都会根据当前问题和实际读取文件刷新带 revision 的快照，网络重试复用该快照；主 prompt 只注入不可信短索引，只读 `memory_lookup` 可按 ID 查看脱敏证据。输入在裁剪前脱敏，输出在保存前再次脱敏，无法可靠判断的冲突保留待审；当前用户指令和实际仓库证据始终优先。

`/status` 会打开居中的独立命令窗口，显示当前模型、实际 Responses 协议、压缩策略、推理档位、接口地址、工作目录、Session ID、context 占用，以及累计输入、输出、推理、缓存命中和缓存写入 token。主 coding 与辅助模型用量分开显示；辅助请求包括标题、Skill、Memory 与 live doctor。缓存读取与写入独立统计；命中率只使用供应商确实返回缓存数据的样本，数据不完整时标为 partial。DeepSeek 使用自动前缀缓存，不发送 OpenAI 缓存字段；官方 OpenAI 型号可使用 Session 级缓存 key 和原生压缩。主 coding 的 Usage 与请求设置随 Session 持久化。

输入快捷键与 Codex composer 保持一致：`Enter` 提交，`Shift+Enter`、`Alt+Enter` 或 `Ctrl+J` 换行，`Home`/`End` 与 `Ctrl+A`/`Ctrl+E` 移动到当前行首/行尾，`Ctrl+U`/`Ctrl+K` 删除到当前行首/行尾，`Ctrl+W` 删除前一个词，`Ctrl+Y` 恢复最近删除的内容。方向键、`Ctrl+B/F/P/N` 和 `Alt+B/F` 也可移动光标。

在输入区开头输入 `/` 会在下方打开斜杠命令菜单。菜单会随输入进行不区分大小写的前缀筛选，每次最多显示八个命令，并可滚动访问其余匹配项。使用 `↑`/`↓` 或 `Ctrl+P/N` 选择，`Enter` 直接执行选中命令，`Tab` 只补全不执行，`Esc` 关闭菜单但保留输入。

TUI 会在启动、退出及 `!` 命令结束时关闭终端焦点事件上报，切换窗口不会再把 `[I`、`[O` 写入输入框。

TUI 命令：

- `/login`：登录并立即启用一个模型。
- `/model`：切换已注册模型，切换后重置对话上下文。
- `/models`：查看所有模型和凭据状态。
- `/status`：查看供应商协议、压缩方式、推理档位、context 占用及独立 token/cache 统计。
- `/diff`：查看当前工作区的有界 Git 状态和 diff。
- `/verify [command]`：运行自动发现的完整工作区检查集合，并绑定取消与文件 revision；显式命令只记录为补充证据。
- `/undo`：在文件仍未被用户改动时撤销最新 Agent 回合；不会覆盖用户修改。
- `/permissions`：选择只读、逐条审批、工作区写入或完全访问模式，分别控制公共网页和模型 shell 联网，并保存用户/项目命令策略。
- `/mcp`：重新加载 Codex MCP 配置、连接已启用服务器并查看 tool/resource/prompt 状态。
- `/skills`：创建、安装、查看并显式调用本地 Skills。
- `/memory`：查看 learned 经验和独立的 Memory 模型用量、全局启用或关闭读取与自动学习、切换当前聊天是否读取或记录 memory、归档或清理条目、使用 `/memory view` 查看最近一次实际注入快照，或使用 `/memory remember <偏好>` 保存长期用户偏好。聊天策略会随 Session 恢复。
- `/plan`：进入严格只读规划模式，回答结构化策略问题，并在批准计划后执行。执行器会拒绝该 step 未提供的工具，包括编辑和 Goal 写操作。
- `/goal <目标> [--tokens N]`：创建、查看、暂停、恢复并自动持续执行当前 Session 目标。收到 usage 后达到预算或无法可靠计量时，会停止后续工具、模型请求和自动验证修复，并显示原因；正在进行的单次请求可能超过剩余额度。
- `/compact`：压缩模型 context，同时保留完整可见 transcript。官方 OpenAI 使用原生 Responses 压缩；DeepSeek 和保守的兼容端点使用最多 8K token 的摘要，并保留最近两个完整交互单元及未闭合工具链。自动压缩会预留输出预算与安全余量；确认 context 超限后最多恢复一次，且不会重放工具。
- `/reasoning off|low|high|max`：设置下一项任务捕获的推理档位，默认 `high`；官方 DeepSeek 会原样接收 `max`。
- `/doctor [--live]`：检查 Node、平台、实际 shell、sandbox 后端/profile、网络模式、Git/ripgrep、可选 TypeScript LSP 配置，并实际执行一次 sandbox 探针。默认只做本地检查；只有 `--live` 会发送一次有界模型请求。
- `/outputs`：分页浏览保留输出、已高亮的命令及 unified diff。
- `/history`：浏览或明确确认后清空全局输入历史，不删除 Session。
- `/terminal-setup`：预览并可选配置稳定版 Windows Terminal 的 Shift+Enter；确认后先备份设置，再新增全局按键绑定。
- `/new`：立即创建并进入一个新的本地 session。
- `/resume`：查看、恢复或批量永久删除本机 JSONL session。
- `/resume` 后上下键浏览该会话保存的用户提问及带来源记录的直接命令，向下越过最新一条回到空输入。召回的斜杠命令在编辑前不打开候选菜单；`/history` 仍显示全局输入历史。
- `/logout`：多选删除模型与对应系统凭据。
- `/clear`：结束当前对话并清屏；下一次提问创建新 session，同时保留当前模型。
- `/help`、`/exit`：显示帮助或退出。
- `!<command>`：直接运行当前系统的命令行（Windows 使用 PowerShell，macOS/Linux 使用 Bash），不再次确认；PTY 排版结果会流式写入 TUI 历史，不再暂停或整页刷新交互界面。

MCP 复用 Codex 配置，不另建 Everpeace 凭据文件。使用 `pnpm exec codex mcp add ...` 或其他已安装 Codex CLI 配置服务器，再运行 `/mcp`。当前支持 stdio 和 Streamable HTTP tools、resources 与 prompts，以及静态/环境 header 和 bearer-token 环境变量。资源和 prompt 会以 `mcp__server__read_resource` 等 function tool 暴露，并继续使用独立 MCP 审批；尚未暴露 Codex OAuth 凭据复用、header helper、elicitation 和 tasks。

Skills 从工作区到仓库根的 `.agents/skills`、项目 `.codex/skills`、`$CODEX_HOME/skills`、`~/.agents/skills` 和平台管理员根发现。输入 `$skill-name` 可在当前轮显式激活；否则模型可按 catalog description 匹配并调用 `read_skill`。默认只预载 metadata，命中后才读取完整说明与引用文件。

`/skills` 是包含三条流程的交互式管理器：

- **创建**：选择项目或用户作用域，描述工作流，由当前模型生成单个 `SKILL.md`；之后可让 AI 校验并改进、手动编辑完整文件，或确认保存。
- **从 URL 安装**：输入公开 HTTPS GitHub 仓库/文件夹、Git 仓库根、直接 `SKILL.md` 或 ZIP URL。Everpeace 先下载到临时暂存区并校验所有发现的包；同一来源包含多个 Skill 时先选择一个，再预览完整 `SKILL.md`、来源和文件数量，最后选择作用域并明确确认后安装。Git 来源先执行不生成工作区文件的克隆，在有界仓库树中定位候选；同名镜像包优先保留规范 `skills/<name>` 目录，再只检出已校验的候选目录。因此，仓库内 `SKILL.md` 文件数可以多于不同的可安装 Skill 数，而不会提前触发候选数量限制。
- **查看已安装 Skill**：先在可扫描目录中查看名称、作用域、可用/冲突状态和两行描述，再打开完整说明；选择 **Use in next prompt** 后把 `$skill-name` 回填到主输入框。

项目安装写入仓库根 `.agents/skills`，用户安装写入 `$CODEX_HOME/skills`（通常为 `~/.codex/skills`）。已有名称不会被覆盖；发现根中存在同名 Skill 时会标记冲突，并在解决前禁止自动或显式激活。URL 安装仅支持公开来源，不接受 URL 内嵌凭据；每次重定向都检查本机/私网地址，并限制下载、解压、条目和单文件大小，拒绝路径穿越及符号链接，通过临时目录完成安装。私有仓库、认证下载、更新和删除暂不属于当前流程。详见 [Codex 能力映射](docs/architecture/CODEX_CAPABILITIES.md)。

行为说明：

- 核心循环已适配 Codex 的采样、工具执行、后续采样流程，提供逐工具结果保存、可取消的请求重试、严格的流完成判断和单次 context-limit 恢复。这不是完整 Codex runtime，详见 [源码对应与移植范围](docs/architecture/AGENT_LOOP.md)。

- 权限档位把 sandbox 范围与审批分开：`read-only` 对模型 shell、网页和 MCP 逐项审批，并使用 Codex `:read-only`；`ask` 逐项审批，shell 获批后使用 `:workspace`；`workspace-write` 在 `:workspace` 内免逐条 shell 审批，已开启的公共网页工具也免逐次确认，MCP 仍单独审批；`full-access` 二次明确确认后选择 `:danger-full-access` 并跳过工具审批。
- 模型可以用 `read_file` 按行分页查看工作区内不超过 16 MiB 的 UTF-8 文件并取得基于原始字节的全文件 SHA-256。参数化 ripgrep 的 `search_files`/`glob_files` 返回有界结果快照的进程内续读引用（默认每页 100 项，最多 200 项）；`list_directory` 列出最多 500 个目录项。拒绝目录外路径和符号链接越界。超大模型工具结果保持有效 JSON，并提供仅当前进程可用的 `read_tool_output` 续读。文件正文会进入模型 context 和 Session 文件，请避免读取机密。
- 将 `EVERPEACE_TYPESCRIPT_LSP` 指向已存在的本地 language server 后，会暴露只读 `code_navigation`，支持 definition、references、implementation 和 hover；可选参数用 `EVERPEACE_TYPESCRIPT_LSP_ARGS` 的 JSON 字符串数组提供。程序不会静默安装 server；请求串行且有界，并拒绝 server 发起的 edit 或 command。
- 用户权限保存于平台配置目录，重启后仍会恢复；`/permissions` 也可把项目策略写入 `.everpeace/permissions.json`。项目策略只允许收紧用户策略、关闭模型 shell 网络或公共网页，不能提升权限。shell 网络开关由原生后端执行，不改变 web 或 MCP 权限。切换权限不丢失 context，恢复 JSONL 不会恢复完全访问授权。
- 模型 shell 通过固定的 `@openai/codex@0.155.1` 原生 OS sandbox 启动，运行时无法启动则失败关闭。Windows 模型命令使用 PowerShell，因为 Git Bash/MSYS 无法在 restricted token 内初始化；macOS/Linux 使用 Bash。模型 shell 默认 120 秒超时，超时会以结构化结果返回；直接 `!` 不进入模型 sandbox，生命周期仍由用户控制。详见 [对标与安全限制](docs/architecture/PERMISSIONS.md)。
- 每次模型 shell 启动前都会捕获不可变的有效策略，显式遵守后端 managed requirements，并过滤继承的凭据及启动注入变量。workspace/ask 模式使用原生子 profile：`.git`、`.codex`、`.agents` 和由宿主预先创建的 `.everpeace` 控制目录保持只读，模型也不能读取 Everpeace 的全局状态目录。命令输出不能触发 payload 自动重放；full-access 与直接 `!` 保留各自已说明的权限。对比依据与后续路线见 [Sandbox 对比与优化计划](docs/architecture/SANDBOX.md)。
- 模型编辑尽量使用限定在工作区内的 `apply_patch` 工具：update/delete 必须匹配宿主通过 `read_file` 记录的版本，preview hash 与权限 revision 绑定实际写入，create 使用排他创建，回滚不会覆盖用户随后写入的内容。预览与执行默认保护 `.git`、`.codex`、`.agents`、`.everpeace`，明确选择 full-access 后才能通过编辑器修改；始终拒绝 Windows ADS。持久化的模型 Bash 规则会检查每个顶层命令段；含糊的命令替换和嵌套解释器必须审批，明确 deny 继续失败关闭。审批等待期间权限变化会使该审批失效。直接 `!` 不受影响。
- 普通 coding 回合使用单 Agent 的个人开发工作流。每个逻辑 step 都会重新读取工作区根目录到已访问目标目录的 `AGENTS.md` chain，以及 `package.json` 中声明的 scripts，作为低于当前用户与开发者指令的项目背景。新发现或已变化的嵌套规则会把结构化编辑推迟到下一次模型边界，当前规则在 context 压缩后仍然生效。patch 成功后先做快速检查；Node/TypeScript 最终验证会重新读取 manifest，并按 `typecheck → lint → test → build` 顺序运行所有已声明脚本，首个失败后停止。没有发现检查命令时会标记为未验证，而不是通过。
- 宿主最多并发执行四个明确安全的只读工具，并仍按模型顺序保存结果。该调度与供应商的 parallel-tool 提示相互独立；写入、shell、MCP、审批、取消和资源冲突仍是串行屏障。模型请求由同一份含真实输出预留的快照生成和测量，命令输出使用增量有界缓冲，流式正文按 40ms 合并刷新，以减少长任务中的宿主开销。
- Git 状态使用 NUL 分隔的结构化结果解析，并把变更文件指纹与任务开始时的既有脏状态比较，因此模型 shell 对已有脏文件的再次修改、未跟踪文件和中文路径也会进入同一验证闭环。追踪超限、非 Git 项目的 shell 改动、审批拒绝或修复次数耗尽时都不能报告为已验证。`workspace_status`、`workspace_diff` 仍为只读工具；`/undo` 继续只覆盖未被再次修改的结构化编辑。
- 模型回复结束与工作流验证完成采用不同状态。宿主会显示观察到的路径和完整检查结果，只有真正验证通过的 coding 回合才能进入成功经验提炼；活动 Goal 的完成请求会等宿主接受最终验证后才落盘。Session JSONL 只保存兼容的结果元数据，不保存检查输出、错误正文、文件内容或撤销检查点。
- 模型最多可在相同 sandbox 和权限策略中运行两个非交互后台命令，提供有界的运行中预览，并可查询或停止；默认上限十分钟，由当前 coding task 持有。取消、权限收紧、预算停止、异常、最终验证或销毁 Agent 都会终止并等待进程树。后台任务只存在当前进程，不随 Session 恢复。
- 维护者可使用 `pnpm benchmark:campaign -- --config <campaign.json> --prove-fixtures|--live` 离线证明十项固定 Node fixture，或执行带完整记录的内部对比；详见 [benchmark 文档](docs/BENCHMARKING.md)。固定 dsh adapter 会核对完整源码 revision，并通过专用 profile 在上游请求边界计量。Live 模式需要另行授权、已注册模型，以及每任务和 campaign 数值 token 预算，不会自动发起真实请求。
- 普通聊天中，`read-only` 和 `ask` 会在每个网页请求前审批；`workspace-write` 与 `full-access` 跳过该确认。Plan 模式把已开启的公共网页访问视为只读调研并跳过逐次确认，关闭网页工具时仍会拒绝请求。搜索词会先发送给 Bing，失败时回退到 DuckDuckGo；打开搜索结果时会向对应网站发送请求。
- 网页读取只允许公共 HTTP/HTTPS 地址，会逐次检查重定向、阻止本机和内网地址，并限制超时与响应大小；返回内容始终作为不可信数据处理。
- 搜索可用性和结果质量取决于外部搜索服务及当前网络。联网失败会作为工具结果返回模型，由模型说明限制或尝试其他来源。
- `!<command>` 是用户直接输入的本机终端命令，不会再次确认，也不会加入模型上下文。
- 模型名称在 login 时直接来自所选端点的 `/models` 接口。
- 重复 login 相同 `base_url + model_name` 会更新 Key，不会生成重复注册项。
- 远程自定义 base URL 必须使用 HTTPS；只有本机地址可使用 HTTP。
- 系统凭据库不可用时会直接失败，不会降级为明文存储。
- Linux 使用持久化的 Secret Service；如果不可用，不会回退到仅存于内存的 kernel keyring。
- 每次模型 shell 调用都使用独立 Codex sandbox 进程，`cd` 和临时环境变量不会在调用间保留；`full-access` 按设计保留当前用户权限。
- TUI 需要交互式终端；重定向或管道环境下会直接给出错误提示。

模型工作期间输入框不会消失，会显示 `Add guidance while working`。此时提交的补充信息会立即写入 transcript，并在下一个安全检查点应用：采样通常会被中止，已经运行的工具先保存结果，再用当前上下文继续执行修正后的计划；`Ctrl+C` 仍会立即取消当前轮次，已提交的纠正会保留在 session context 供下一轮使用。耗时少于一分钟显示秒，超过一分钟显示分钟和秒，超过一小时显示小时、分钟和秒。

## 项目结构

```text
src/
├─ cli/          # CLI 入口以及 login/models/logout/run 命令
├─ agent/        # ReAct 循环和会话状态
├─ codex/        # 固定 Codex CLI 启动器
├─ mcp/          # 读取 Codex 配置的 MCP client runtime
├─ providers/    # DeepSeek、OpenAI 及兼容端点适配
├─ skills/       # Codex 主机 Skill 发现与渐进读取
├─ storage/      # 系统凭据与模型注册表
├─ tui/          # Ink 页面、状态机、登录向导和交互组件
└─ tools/        # Agent 工具定义和执行器

tests/unit/      # 与 src 领域对应的单元测试
```

## 构建与安装

请使用 pnpm 从本仓库安装，以应用随源码保存的 Windows node-pty 修复补丁。GitHub Release 分发源码；作为 npm 依赖安装不会自动继承本项目的 pnpm 补丁。

```powershell
pnpm build
pnpm link --global
everpeace login
everpeace models
everpeace
everpeace logout
```

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```
- Ctrl+C 中断正在运行的模型任务、审批等待或命令，不退出程序；空闲时有草稿则清空，输入为空则退出。
- 在首行/末行使用上下键浏览历史并恢复草稿，斜杠菜单选择优先。终端支持时 Shift+Enter 换行；多行括号粘贴不会自动提交。Windows Terminal 无法区分 Shift+Enter 与 Enter 时，可运行 `/terminal-setup`。
- 输入历史跨重启共享，最多 1,000 条 / 4 MiB，保存于 sessions 目录旁的 `input-history.json`。登录向导密钥不记录，但手动输入在提问或命令中的机密不会自动脱敏；清空输入历史不会删除 Session 记录。
- 模型请求的 shell 命令运行时通过有界预览展示最前五行和最后五行及省略数量，终端高度不足时对称缩减；用户直接 `!` 仍优先展示最新五行，完成后的长输出继续折叠。`/outputs` 查看保留内容，每条 UI 记录最多 10,000 行 / 2 MiB，已截断内容不可恢复。模型 shell 分别保留最多 1 MiB 的 stdout/stderr，不提供交互 stdin；用户直接 `!` 命令仍支持交互输入。
