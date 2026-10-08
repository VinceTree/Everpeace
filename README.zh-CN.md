# Everpeace

终端 transcript 对齐 Codex 的 resize/reflow 行数上限：同步重放按终端保留尾部，VS Code 为 1,000 行、Windows Terminal 为 9,001 行、WezTerm 为 3,500 行、Alacritty 为 10,000 行，其他终端为 1,000 行。Ink 不提供最终布局测量，因此按源文本和当前终端宽度估算行数。Session JSONL、模型上下文、输入导航和 `/outputs` 继续保留完整数据。


[English](./README.md) | **简体中文**

Everpeace 是一个 DeepSeek 优先、Windows 优先的个人开发 CLI，提供 inline TUI 和非交互 `exec` 命令，同时支持 OpenAI 和自定义 OpenAI-compatible Responses 端点。所选模型可以使用 Codex sandbox 中的 shell、检查并修改工作区、执行项目完整验证、搜索网页、调用已配置的 MCP tool，并加载本机 Codex Skill；在 TUI 中，你也可以用 `!<command>` 直接运行本地命令。

模型 API Key 不从环境变量读取，也不会写入项目或配置 JSON。Everpeace 使用操作系统凭据库保存 Key，并在本地模型注册表中只保存模型名、base URL 和凭据引用。用户自行配置的 MCP server 可按 Codex MCP 配置通过环境变量名引用 bearer token 或 header；两类凭据边界彼此独立。

摘要压缩会以结构化交接保留你的目标与纠正、决定、文件改动、检查证据、未完成工作和下一步，并保留最近两个完整交互。`/context` 将它标为模型生成的交接摘要。Agent 每一步都收到当前宿主工作流状态，包括待验证状态和修复轮数限制。已知的文件、编辑和命令失败提供原因与修正提示；命令超时仍保留部分输出，便于 Agent 先检查可能产生的副作用再继续。这些机制已有离线回归覆盖，真实模型质量与 token 节省仍未实测。

面对不熟悉的工作区，Agent 可在 coding 或 Plan 中按需调用 `project_map`，查看结构、包声明、脚本及文档／测试／配置位置。它遵守 ignore 规则并明确报告扫描上限；基于文件名的入口仍只是候选。编辑前仍须读取目标文件。`apply_patch` 默认精确替换；只有显式选择 `line_whitespace` 且精确未命中时，才容忍唯一完整行块的行首／行尾空格或 Tab 差异。审批预览和结果显示实际方式与命中行号。

## 需求

- Node.js 22+
- pnpm
- macOS/Linux 上的 Bash；Windows 模型命令在 Codex sandbox 内使用系统 PowerShell
- DeepSeek、OpenAI 或兼容服务的 API Key
- 能够通过 HTTPS 访问 Bing 或 DuckDuckGo，以及 Agent 需要读取的公共网页

`pnpm install` 会安装 Everpeace 固定的 `@vscode/ripgrep@1.18.0` 及与当前平台匹配的二进制，不要求也不会使用系统 `rg`。请勿关闭 optional dependencies；如果对应平台包缺失，工作区搜索、`@` 文件选择器和 `/doctor` 会明确报告随包 ripgrep 不可用并提示重新安装。该版本提供 Windows x64/arm64/ia32、macOS x64/arm64，以及 Linux x64/arm64/arm/ia32/ppc64/riscv64/s390x 平台包；其他操作系统与架构组合没有随包搜索二进制。

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

## 非交互执行

`everpeace exec` 不挂载 Ink，仍使用与 TUI 相同的生产 Agent、Session 持久化、权限、sandbox 工具、验证/修复闭环、历史附件和清理流程：

```text
everpeace exec [prompt] [-C <directory>] [--model <id-or-name>]
               [--resume <session-id>]
               [--plan] [--json] [--token-budget <n>]
               [--permission-mode <mode>] [--timeout-ms <n>] [--max-steps <n>]
```

提示词只能来自一个位置参数或非 TTY stdin；同时提供两者属于参数错误，交互终端中两者都缺失会立即退出。管道输入最多 8 MiB。开发环境可通过 `pnpm dev -- exec ...` 使用同一接口。`-C` 默认为当前目录。模型先按注册 ID 匹配，再按唯一模型名匹配；省略 `--model` 时必须恰好只有一个凭据可用的模型。`everpeace exec --help` 会在加载模型注册表、系统凭据库、MCP 或 TUI 之前返回。

通过启动阶段的每项任务都会创建正常 Session，并使用确定性的 `Exec: ...` 标题，之后可以在 TUI 中查看或恢复。`--resume <session-id>` 则把同工作区的已有 Session 分支为独立子副本并用新提示词继续：它会恢复源 Session 保存的 context、workflow、TaskProgress 与模型（`--resume` 与 `--model` 不能同时使用）。子 Session 在续跑任务结算为 `verified` 或 `no_changes` 后清除 `fork_pending_resume` 标记。`--plan` 执行只读规划：检查工作区后把提交的实现计划作为 assistant 正文输出，不编辑文件、也不会自动批准执行。`--permission-mode <read-only|ask|workspace-write>` 为单次运行覆盖已保存的权限层级；exec 永远不能选择 `full-access`，已保存的 web/shell 网络/命令规则收紧仍然生效。命令会读取现有 learned Memory，但关闭本次捕获。不能自动批准：权限确认或结构化问题会作为配对工具结果持久化，以 `interaction_required` 报告，并在完成清理后停止。`--token-budget` 覆盖 coding、压缩、重试和修复；`--timeout-ms` 与 `--max-steps` 同样覆盖整个任务，不会在修复轮之间重置。

不带 `--json` 时，stdout 只输出最终 assistant 文本，进度与宿主验证摘要写入 stderr。exec 输出层初始化后，`--json` 输出 UTF-8 JSONL，每行包含 `schema_version: 1`、ISO `timestamp` 和下表白名单字段。事件类型为 `session_started`、`assistant_message`、`tool_started`、`tool_finished`、`workflow_updated`、`interaction_required`，以及任务清理后唯一的 `run_finished`。顶层参数语法或模块启动错误会在 JSONL 开始前写入 stderr 并以 2 退出。所有文本先移除终端控制序列并脱敏；不导出 reasoning 正文或原始 provider response，usage 可包含汇总 reasoning/cache 计数。

助手正文脱敏后完整保留，包括超过 64 KiB 的回答；JSONL 用有界块写成一条完整记录，其他事件不会插入其中。其余事件连同 JSON 转义和换行最多 64 KiB，预览缩短时标注 `truncated: true`。待写编码缓冲最多 1 MiB；写入等待消费端，30 秒没有写入进展会取消任务并清理，任一输出管道关闭也会停止。若取消或输出故障打断正在写入的 JSONL 记录，流可能以不完整末行结束且无法补写终态；消费端必须结合进程退出码和完整记录判断结果。

| JSONL `type` | 白名单 payload |
| --- | --- |
| `session_started` | `session_id`、`model_id`、`model_name`、`workspace`；`--resume` 分支运行时附带 `parent_session_id` |
| `assistant_message` | `text` |
| `tool_started` / `tool_finished` | `name`、`call_id`；完成事件可带 `status`（`completed`、`failed`、`cancelled` 或 `skipped`）和有界 `output` 预览 |
| `workflow_updated` | `phase`、`task_id`、`changed_paths`、`repair_attempts`、`max_repair_attempts`、`pending_verification`；可选 `result`、`result_reason` |
| `interaction_required` | `kind`（`approval` 或 `question`）、`tool`、可选 `prompt` |
| `run_finished` | 可选 `session_id`；`status`（`success`、`runtime_error`、`configuration_error`、`verification_failed`、`limit_reached`、`interaction_required` 或 `cancelled`）；`usage_complete`；可选 `stop_reason`、`workflow_result`，以及含 `input_tokens`、`output_tokens` 和可选 `reasoning_tokens`、`cached_input_tokens`、`cache_write_input_tokens` 的 `usage` |

同一非交互任务也作为小型 TypeScript SDK 提供。`import { runTask } from "everpeace/sdk"` 接受提示词加上述 exec 选项（含 `resume`、`plan`、`permissionMode`），通过 `onEvent` 流式交付相同事件并返回分类结果。凭据与 Session 默认来自系统 keyring 和默认存储，宿主可注入自己的 registry 或 session store；SDK 不挂载 Ink，也永远不自动批准交互确认。

退出码固定为：`0` 表示宿主结果为 `verified` 或 `no_changes`；`1` 表示运行/清理故障或输出管道失败、停滞；`2` 表示参数或启动配置错误；`3` 表示验证 `failed` 或 `unverified`；`4` 表示 token、usage、step 或 deadline 限制；`5` 表示需要交互；`130`/`143` 分别表示 SIGINT/SIGTERM。输出故障会在退出前等待任务和 writer 清理。

macOS/Linux 上如果 `bash` 不在 `PATH` 中，可以显式配置：

```powershell
$env:EVERPEACE_BASH_PATH="/custom/path/to/bash"
```

## 使用

```text
✦ Everpeace Agent (v0.3.10) · 天下长平，以规司矩

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

第一次普通提问会创建本地 JSONL session。Everpeace 会保存对话记录和继续聊天所需的模型上下文，同时在后台单独调用当前模型，根据第一次提问生成简短名称。带信息或选择界面的 slash command 会打开独立临时窗口，隐藏 banner、历史、输入框和全局状态栏。命令窗口水平、垂直居中，最大宽度 80 列，并在窄终端自动缩小、保留安全边距。按 `Esc` 后原子重放并返回同一个 session，窗口内容不会加入历史。直接 `!` 命令的输出仍属于可恢复记录。`/new` 会立即创建并进入一个空 session，第一次提问后再替换临时名称。`/resume [query]` 默认搜索当前工作区的标题及用户/assistant 消息，也可切换到全部工作区；本地预览匹配附近的对话，并恢复原模型、工作目录、Goal 与验证状态。Windows 下 session 默认保存在 `%APPDATA%\Everpeace\sessions`。

Everpeace 还会维护独立的 learned 经验记忆。workflow 验证完成并真实空闲五分钟后，当前模型可在后台提取最多三条带证据候选并整理无冲突经验；持久队列可跨 Agent 重建和进程重启恢复，前台工作会暂停后台请求。只有用户明确表达长期偏好时才写入用户级记忆。记忆位于平台应用状态目录（Windows 为 `%APPDATA%\Everpeace\memory`），不会写入仓库。每个逻辑 Agent step 都会根据当前问题和实际读取文件刷新带 revision 的快照，网络重试复用该快照；主 prompt 只注入不可信短索引，只读 `memory_lookup` 可按 ID 查看脱敏证据。输入在裁剪前脱敏，输出在保存前再次脱敏，无法可靠判断的冲突保留待审；当前用户指令和实际仓库证据始终优先。

`/status` 会打开居中的独立命令窗口，显示当前模型、实际 Responses 协议、压缩策略、推理档位、接口地址、工作目录、Session ID、context 占用，以及累计输入、输出、推理、缓存命中和缓存写入 token。主 coding 与辅助模型用量分开显示；辅助请求包括标题、Skill、Memory 与 live doctor。缓存读取与写入独立统计；命中率只使用供应商确实返回缓存数据的样本，数据不完整时标为 partial。DeepSeek 使用自动前缀缓存，不发送 OpenAI 缓存字段；官方 OpenAI 型号可使用 Session 级缓存 key 和原生压缩。主 coding 的 Usage 与请求设置随 Session 持久化。

输入快捷键与 Codex composer 保持一致：`Enter` 提交，`Shift+Enter`、`Alt+Enter` 或 `Ctrl+J` 换行，`Home`/`End` 与 `Ctrl+A`/`Ctrl+E` 移动到当前行首/行尾，`Ctrl+U`/`Ctrl+K` 删除到当前行首/行尾，`Ctrl+W` 删除前一个词，`Ctrl+Y` 恢复最近删除的内容。方向键、`Ctrl+B/F/P/N` 和 `Alt+B/F` 也可移动光标。

输入 `@` 会打开有界的工作区文件选择器。选择后插入 `@"src/example.ts"` 形式的显式引用，也可追加 `#L10-L40` 指定范围。提交时 Everpeace 重新读取每个引用，把带标签的摘录一次性加入模型 context，同时输入历史和标题生成仍使用原问题；行内代码和 fenced code 内的引用保持字面量。每条消息最多八个摘录，默认 200 行，显式范围最多 1,000 行，单个 32 KiB、合计 64 KiB。无效、缺失、二进制或超限引用会保留草稿并显示错误。附件不会授予后续编辑权限。

在输入区开头输入 `/` 会在下方打开斜杠命令菜单。菜单会随输入进行不区分大小写的前缀筛选，每次最多显示八个命令，并可滚动访问其余匹配项。使用 `↑`/`↓` 或 `Ctrl+P/N` 选择，`Enter` 直接执行选中命令，`Tab` 只补全不执行，`Esc` 关闭菜单但保留输入。

TUI 会在启动、退出及 `!` 命令结束时关闭终端焦点事件上报，切换窗口不会再把 `[I`、`[O` 写入输入框。

TUI 命令：

- `/login`：登录并立即启用一个模型。
- `/model`：切换已注册模型，切换后重置对话上下文。
- `/models`：查看所有模型和凭据状态。
- `/status`：查看供应商协议、压缩方式、推理档位、context 占用及独立 token/cache 统计。
- `/diff`：按 staged、unstaged、untracked 分组查看文件，并在分页高亮详情中明确显示二进制、符号链接、submodule 和截断状态。
- `/context`：只读查看最近一次已准入 coding 请求的模型、估算、来源、工具、附件、条目计数及脱敏预览，不触发模型请求。
- `/tasks`：查看当前 model-authored 执行清单和最新宿主 workflow 结果。清单完成仅表示进度，不能替代验证。
- `/verify [command]`：运行自动发现的完整工作区检查集合，并绑定取消与文件 revision；显式命令只记录为补充证据。
- `/undo`：在文件仍未被用户改动时撤销最新 Agent 回合；不会覆盖用户修改。
- `/permissions`：选择只读、逐条审批、工作区写入或完全访问模式，分别控制公共网页和模型 shell 联网，并保存用户/项目命令策略。
- `/mcp`：重新加载 Codex MCP 配置、连接已启用服务器并查看 tool/resource/prompt 状态。
- `/skills`：创建、安装、查看并显式调用本地 Skills。
- `/memory`：查看 learned 经验和独立的 Memory 模型用量、全局启用或关闭读取与自动学习、切换当前聊天是否读取或记录 memory、归档或清理条目、使用 `/memory view` 查看最近一次实际注入快照，或使用 `/memory remember <偏好>` 保存长期用户偏好。聊天策略会随 Session 恢复；开关只控制 learned Memory，与按需 Session 历史检索独立。
- `/plan`：进入严格只读规划模式，回答结构化策略问题，并在批准计划后执行。普通 coding 中模型需要澄清时也会使用同一阻塞式问题窗口；在 coding 问题中取消会停止整个活动任务。执行器会拒绝 Plan step 未提供的工具，包括编辑和 Goal 写操作。
- `/goal <目标> [--tokens N]`：创建、查看、暂停、恢复并自动持续执行当前 Session 目标。收到 usage 后达到预算或无法可靠计量时，会停止后续工具、模型请求和自动验证修复，并显示原因；正在进行的单次请求可能超过剩余额度。
- `/compact`：压缩模型 context，同时保留完整可见 transcript。官方 OpenAI 使用原生 Responses 压缩；DeepSeek 和保守的兼容端点使用最多 8K token 的摘要，并保留最近两个完整交互单元及未闭合工具链。自动压缩会预留输出预算与安全余量；确认 context 超限后最多恢复一次，且不会重放工具。
- `/reasoning off|low|high|max`：设置下一项任务捕获的推理档位，默认 `high`；官方 DeepSeek 会原样接收 `max`。
- `/doctor [--live]`：检查 Node、平台、实际 shell、sandbox 后端/profile、网络模式、Git/随包 ripgrep、可选 TypeScript LSP 配置，并实际执行一次 sandbox 探针。默认只做本地检查；只有 `--live` 会发送一次有界模型请求。
- `/outputs`：分页浏览保留输出、已高亮的命令及 unified diff。
- `/history`：浏览或明确确认后清空全局输入历史，不删除 Session。
- `/terminal-setup`：预览并可选配置稳定版 Windows Terminal 的 Shift+Enter；确认后先备份设置，再新增全局按键绑定。
- `/new`：立即创建并进入一个新的本地 session。
- `/fork [title]`：复制当前空闲本地 Session 已提交的末尾为独立子 Session 并进入；可选标题会替换默认分支标题，源模型必须仍然可用。
- `/resume [query]`：搜索当前或全部工作区的标题与用户/assistant 消息，本地预览后恢复，也可批量永久删除本机 JSONL session。
- `/resume` 后上下键浏览该会话保存的用户提问及带来源记录的直接命令，向下越过最新一条回到空输入。召回的斜杠命令在编辑前不打开候选菜单；`/history` 仍显示全局输入历史。
- `/logout`：多选删除模型与对应系统凭据。
- `/clear`：结束当前对话并清屏；下一次提问创建新 session，同时保留当前模型。
- `/help`、`/exit`：显示帮助或退出。
- `!<command>`：直接运行当前系统的命令行（Windows 使用 PowerShell，macOS/Linux 使用 Bash），不再次确认；PTY 排版结果会流式写入 TUI 历史，不再暂停或整页刷新交互界面。

MCP 复用 Codex 配置，不另建 Everpeace 凭据文件。使用 `pnpm exec codex mcp add ...` 或其他已安装 Codex CLI 配置服务器，再运行 `/mcp`。当前支持 stdio 和 Streamable HTTP tools、resources 与 prompts，以及静态/环境 header 和 bearer-token 环境变量。每个 server 独立维护 `connecting`/`reconnecting` 生命周期：瞬时断连会移除其工具，并以 500 ms–30 s 指数退避最多重试十次；永久配置或认证错误直接停止。连接连续 ready 30 秒才重置重试次数，五秒内无法确认旧连接关闭则停止自动恢复。中断中的工具调用不会重放；业务错误、单次调用超时和取消本身不会触发重连。

工具列表变更会完整分页，并与输出校验器一起原子发布；刷新失败保留上一份完整目录及校验规则。每个 Agent step 冻结连接和完整定义的绑定，包括 output schema、execution metadata 与审批 annotation；旧绑定不能再次执行，已经派发的调用仍按原定义验证结果。发现共用一个启动期限，最多 100 页、1,000 个工具和 2 MiB 定义。要求 task-based execution 的工具不向模型广告，`/mcp` 显示 unsupported。HTTP Session 失效（404）会为后续调用重连，不重放失败请求。

只有 resources、prompts 或 instructions 的 server 也可连接。`mcp__server__list_resources`、`list_resource_templates`、`list_prompts` 每次读取一页实时内容；将返回的 `next_cursor` 原样作为下一次 `cursor`。单页超过 1,000 项或 1 MiB 时明确失败，不返回会跳过遗漏条目的续点。`read_resource` 与 `get_prompt` 按需读取当前内容；MCP image/audio/resource-blob 内容块在模型历史中显示类型和大小说明，结构化业务数据及 metadata 保持原值。上述调用继续逐次使用独立 MCP 审批。`/mcp` 重载配置并重置恢复状态；OAuth 凭据复用、header helper、elicitation、sampling、tasks 和按工具持久审批尚未接入。

Skills 从工作区到仓库根的 `.agents/skills`、项目 `.codex/skills`、`$CODEX_HOME/skills`、`~/.agents/skills` 和平台管理员根发现。输入 `$skill-name` 可在当前轮显式激活；否则模型可按 catalog description 匹配并调用 `read_skill`。默认只预载 metadata，命中后才读取完整说明与引用文件。

`/skills` 是包含三条流程的交互式管理器：

- **创建**：选择项目或用户作用域，描述工作流，由当前模型生成单个 `SKILL.md`；之后可让 AI 校验并改进、手动编辑完整文件，或确认保存。
- **从 URL 安装**：输入公开 HTTPS GitHub 仓库/文件夹、Git 仓库根、直接 `SKILL.md` 或 ZIP URL。Everpeace 先下载到临时暂存区并校验所有发现的包；同一来源包含多个 Skill 时先选择一个，再预览完整 `SKILL.md`、来源和文件数量，最后选择作用域并明确确认后安装。Git 来源先执行不生成工作区文件的克隆，在有界仓库树中定位候选；同名镜像包优先保留规范 `skills/<name>` 目录，再只检出已校验的候选目录。因此，仓库内 `SKILL.md` 文件数可以多于不同的可安装 Skill 数，而不会提前触发候选数量限制。
- **查看已安装 Skill**：先在可扫描目录中查看名称、作用域、可用/冲突状态和两行描述，再打开完整说明；选择 **Use in next prompt** 后把 `$skill-name` 回填到主输入框。

项目安装写入仓库根 `.agents/skills`，用户安装写入 `$CODEX_HOME/skills`（通常为 `~/.codex/skills`）。已有名称不会被覆盖；发现根中存在同名 Skill 时会标记冲突，并在解决前禁止自动或显式激活。URL 安装仅支持公开来源，不接受 URL 内嵌凭据；每次重定向都检查本机/私网地址，并限制下载、解压、条目和单文件大小，拒绝路径穿越及符号链接，通过临时目录完成安装。私有仓库、认证下载、更新和删除暂不属于当前流程。详见 [Codex 能力映射](docs/architecture/CODEX_CAPABILITIES.md)。

模型可通过 `session_search`、`session_event_search` 和 `session_event_read` 按需找回当前及同工作区旧会话记录，包括压缩后不再进入有效 context 的内容。`session_relations(session_id?)` 返回完全相同工作区中的直接父/子分支，并把已删除或被替换的父 Session 标为不可用。结果标明 Session 来源和时间，只作为不可信历史资料，不能授予文件写入权或当前验证成功状态。普通 coding 和 Plan 均可只读使用；关闭 learned Memory 不会关闭历史检索。直接 `!` 输出、reasoning、加密条目、旧 developer 快照、Memory 结果及历史工具自身结果均不参与检索。

行为说明：

- 核心循环已适配 Codex 的采样、工具执行、后续采样流程，提供逐工具结果保存、可取消的请求重试、严格的流完成判断和单次 context-limit 恢复。这不是完整 Codex runtime，详见 [源码对应与移植范围](docs/architecture/AGENT_LOOP.md)。
- 达到自动压缩压力或进入单次 context-limit 恢复时，只要存在持久 Session 历史，Everpeace 会先尝试一次确定性裁剪。早期闭合工具结果必须能在固定历史边界唯一定位；超过 8,192 个 Unicode 码点的结果保留前 4,096、后 1,024 及 `session_event_read` 恢复引用，产物保持有效 JSON 且不超过 32 KiB。最近两个完整交互单元、未闭合工具链、用户/助手/developer/reasoning/opaque 项、Memory 和历史/续读工具结果不会被裁剪。`context_pruned` 会先落盘，再替换有效 context；原始历史与附件继续保留，累计 usage 不变，只有当前 `context_tokens` 估计变为 unknown。若重新估算后的完整请求已经足够小，就不发送摘要模型请求；否则继续普通 provider 压缩。低压力请求和普通网络重试不会裁剪。

- 权限档位把 sandbox 范围与审批分开：`read-only` 对模型 shell、网页和 MCP 逐项审批，并使用 Codex `:read-only`；`ask` 逐项审批，shell 获批后使用 `:workspace`；`workspace-write` 在 `:workspace` 内免逐条 shell 审批，已开启的公共网页工具也免逐次确认，MCP 仍单独审批；`full-access` 二次明确确认后选择 `:danger-full-access` 并跳过工具审批。
- 模型可以用 `read_file` 按行分页查看工作区内不超过 16 MiB 的 UTF-8 文件并取得基于原始字节的全文件 SHA-256。`search_files`/`glob_files` 通过绝对路径运行固定版本的随包 ripgrep，并始终传入参数化的 `--no-config`；系统 `PATH` 和用户 ripgrep 配置无法替换或影响它。搜索返回有界结果快照的进程内续读引用（默认每页 100 项，最多 200 项）。搜索续读最多保留 16 个搜索和 8 MiB 序列化 UTF-8 payload，超限时淘汰最旧引用；已完成行与未终止的 ripgrep 记录共同受单次 2 MiB 输入边界约束。`list_directory` 列出最多 500 个目录项。拒绝目录外路径和符号链接越界。超大模型工具结果保持有效 JSON，内联预览最多 32 KiB，并提供 opaque `read_tool_output` 引用。脱敏正文作为 Session 附件持久化，每项保留前 2 MiB、每会话保留最近 16 项，续读每页最多 24 KiB；引用可跨压缩和重启使用，可选 `session_id` 只允许同工作区。淘汰项及旧进程内正文明确不可用，`retention_truncated` 标示保留范围之外的内容。删除 Session 同时清理所属附件。文件正文会进入模型 context 和 Session 文件，请避免读取机密。
- 将 `EVERPEACE_TYPESCRIPT_LSP` 指向已存在的本地 language server 后，会暴露只读 `code_navigation`，支持 definition、references、implementation 和 hover；可选参数用 `EVERPEACE_TYPESCRIPT_LSP_ARGS` 的 JSON 字符串数组提供，额外只读源码根可用 `EVERPEACE_TYPESCRIPT_LSP_READ_ROOTS` 的 JSON 字符串数组声明。每次查询都在固定 Codex 原生只读 sandbox 中启动全新进程，过滤凭据、检查保护路径、验证 UTF-16 和文档 open/close 能力，并在有界协议处理后等待清理。宿主先连接探针目标作为正对照，再记录 sandbox 在该 TCP/IPv4 目标上的 `allowed`、`denied` 或 `inconclusive`；只有明确的 socket 权限拒绝才允许启动 language server，拒绝连接和超时不算隔离证据。当前固定 Windows 后端仍允许该探针，因此 Windows 原生 LSP 导航继续 unavailable，并保留 lexical search。程序不自动安装 server，也未启用共享进程池；原生平台 ambient read 和临时目录权限仍然存在。
- 用户权限保存于平台配置目录，重启后仍会恢复；`/permissions` 也可把项目策略写入 `.everpeace/permissions.json`。项目策略只允许收紧用户策略、关闭模型 shell 网络或公共网页，不能提升权限。shell 网络开关由原生后端执行，不改变 web 或 MCP 权限。切换权限不丢失 context，恢复 JSONL 不会恢复完全访问授权。
- 模型 shell 通过固定的 `@openai/codex@0.155.1` 原生 OS sandbox 启动，运行时无法启动则失败关闭。Windows 模型命令使用 PowerShell，因为 Git Bash/MSYS 无法在 restricted token 内初始化；macOS/Linux 使用 Bash。模型 shell 默认 120 秒超时，超时会以结构化结果返回；直接 `!` 不进入模型 sandbox，生命周期仍由用户控制。详见 [对标与安全限制](docs/architecture/PERMISSIONS.md)。
- 每次模型 shell 启动前都会捕获不可变的有效策略，显式遵守后端 managed requirements，并过滤继承的凭据及启动注入变量。workspace/ask 模式使用原生子 profile：`.git`、`.codex`、`.agents` 和由宿主预先创建的 `.everpeace` 控制目录保持只读，模型也不能读取 Everpeace 的全局状态目录。命令输出不能触发 payload 自动重放；full-access 与直接 `!` 保留各自已说明的权限。对比依据与后续路线见 [Sandbox 对比与优化计划](docs/architecture/SANDBOX.md)。
- 模型编辑尽量使用限定在工作区内的 `apply_patch` 工具：update/delete 必须匹配宿主通过 `read_file` 记录的版本，preview hash 与权限 revision 绑定实际写入，create 使用排他创建，回滚不会覆盖用户随后写入的内容。update 可使用精确且唯一的 `replace: { oldText, newText }`；缺少观察、旧版本、未匹配或多重匹配、hunk 不符和策略拒绝会返回稳定原因及修复建议。预览与执行默认保护 `.git`、`.codex`、`.agents`、`.everpeace`，明确选择 full-access 后才能通过编辑器修改；始终拒绝 Windows ADS。持久化的模型 Bash 规则会检查每个顶层命令段；含糊的命令替换和嵌套解释器必须审批，明确 deny 继续失败关闭。审批等待期间权限变化会使该审批失效。直接 `!` 不受影响。
- 普通 coding 回合使用单 Agent 的个人开发工作流。每个逻辑 step 都会重新读取工作区根目录到已访问目标目录的 `AGENTS.md` chain，以及 `package.json` 中声明的 scripts，作为低于当前用户与开发者指令的项目背景。新发现或已变化的嵌套规则会把结构化编辑推迟到下一次模型边界，当前规则在 context 压缩后仍然生效。patch 成功后先做快速检查；Node/TypeScript 最终验证会重新读取 manifest，并按 `typecheck → lint → test → build` 顺序运行所有已声明脚本，首个失败后停止。没有发现检查命令时会标记为未验证，而不是通过。
- coding 模型可整体替换最多 20 项的持久执行清单，状态为 pending、in progress 或 completed。当前清单跨 repair、Goal continuation、显式 Session resume 和 context 压缩保留，新用户任务先清空；状态栏和 `/tasks` 展示进度，宿主验证仍是唯一完成判据。
- 宿主最多并发执行四个明确安全的只读工具，并仍按模型顺序保存结果。该调度与供应商的 parallel-tool 提示相互独立；写入、shell、MCP、审批、取消和资源冲突仍是串行屏障。模型请求由同一份含真实输出预留的快照生成和测量，命令输出使用增量有界缓冲，流式正文按 40ms 合并刷新，以减少长任务中的宿主开销。
- Git 状态使用 NUL 分隔的结构化结果解析，并把变更文件指纹与任务开始时的既有脏状态比较，因此模型 shell 对已有脏文件的再次修改、未跟踪文件和中文路径也会进入同一验证闭环。追踪超限、非 Git 项目的 shell 改动、审批拒绝或修复次数耗尽时都不能报告为已验证。模型可用 `list_workspace_changes` 捕获 staged、unstaged 和 untracked 列表，再用 `read_workspace_change` 惰性读取有界详情；列表快照刷新后旧引用会明确过期。既有 `workspace_status`、`workspace_diff` 调用保持兼容；审阅内容不授予写权限，也不表示变更归 Agent 所有。`/undo` 继续只覆盖未被再次修改的结构化编辑。
- 模型回复结束与工作流验证完成采用不同状态。宿主会显示观察到的路径和完整检查结果，只有真正验证通过的 coding 回合才能进入成功经验提炼；活动 Goal 的完成请求会等宿主接受最终验证后才落盘。Session JSONL 只保存兼容的结果元数据，不保存检查输出、错误正文、文件内容或撤销检查点。
- `/fork` 仅在当前本地 Session 完全空闲且其模型仍可用时接受。它固定源 EOF，复制 context、timeline、模型、聊天 Memory policy、标为继承的 TaskProgress 和最多 16 份保留输出附件，并在最后原子发布独立子副本；附件沿用 opaque ID，但父子各自拥有。usage、Goal、修复次数、审批、undo/文件观察及旧验证成功证据被重置，已变更路径和待验证债务保留。子 Session 持久保存 `fork_pending_resume`：首次及任何未结算后的 coding 输入继续使用 Session resume 语义，直到任务结算为 `verified` 或 `no_changes`；Plan、查看命令、取消、错误、限制停止及 failed/unverified 结果不会消耗它，也不会自动续跑 Goal。
- 模型最多可在相同 sandbox 和权限策略中运行两个非交互后台命令，提供有界的运行中预览，并可查询或停止；默认上限十分钟，由当前 coding task 持有。终态元数据会在下一普通 step 持久送达模型，输出仍通过 poll 获取；运行 job 与未送达通知共用 20 个 task-local 槽位。取消、权限收紧、预算停止、异常、最终验证或销毁 Agent 都会终止并等待进程树、丢弃待送通知并忽略迟到 callback。后台任务只存在当前进程，不随 Session 恢复。
- 维护者可使用 `pnpm benchmark:campaign -- --config <campaign.json> --preflight|--prove-fixtures|--live`。preflight 会在无真实模型请求的情况下启动命名 checkout 的生产 adapter 与固定 dsh profile，核对源码/build digest、请求边界、固定 `high`/32K 设置和清理；`taskIds` 可固定 3 项 smoke 或完整 10 项计划。详见 [benchmark 文档](docs/BENCHMARKING.md)。固定 dsh adapter 会核对完整源码 revision，并通过专用 profile 在上游请求边界计量。Live 模式需要另行授权、已注册模型，以及每任务和 campaign 数值 token 预算，不会自动发起真实请求。
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

开始开发先读 [AGENTS.md](AGENTS.md)、[当前交接](docs/HANDOFF.md) 和 [知识库索引](docs/README.md)。索引按任务关联架构说明、源码入口和回归测试，让新 Agent 复用项目知识，仅定向检查相关实现。旧计划与执行记录单独保留在 [历史归档](docs/archive/README.md)。

```text
src/
├─ cli/          # CLI 入口、参数解析和输出格式
├─ agent/        # ReAct 循环和会话状态
├─ codex/        # 固定 Codex CLI 启动器
├─ exec/         # 公开非交互任务 runner 与结果契约
├─ mcp/          # 读取 Codex 配置的 MCP client runtime
├─ providers/    # DeepSeek、OpenAI 及兼容端点适配
├─ runtime/      # 与 UI 无关的生产 Agent 和命令 factory
├─ skills/       # Codex 主机 Skill 发现与渐进读取
├─ storage/      # 凭据、模型注册、Session、历史和输出附件
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
