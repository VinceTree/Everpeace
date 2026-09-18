# Everpeace

终端 transcript 对齐 Codex 的 resize/reflow 行数上限：同步重放按终端保留尾部，VS Code 为 1,000 行、Windows Terminal 为 9,001 行、WezTerm 为 3,500 行、Alacritty 为 10,000 行，其他终端为 1,000 行。Ink 不提供最终布局测量，因此按源文本和当前终端宽度估算行数。Session JSONL、模型上下文、输入导航和 `/outputs` 继续保留完整数据。


[English](./README.md) | **简体中文**

Everpeace 是一个具备较强编程能力、带交互式 TUI 的通用 ReAct agent，支持 DeepSeek、OpenAI 和自定义 OpenAI-compatible API。所选模型可以搜索网页、读取公共页面并请求调用 Bash；你也可以用 `!<command>` 直接运行本地命令。

API Key 不从环境变量读取，也不会写入项目或配置 JSON。Everpeace 使用操作系统凭据库保存 Key，并在本地模型注册表中只保存模型名、base URL 和凭据引用。

## 需求

- Node.js 22+
- pnpm
- macOS/Linux 上的 Bash，或 Windows 上的 Git Bash/WSL Bash
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

API Key 不会显示在终端。验证成功后选择一个服务端返回的原始模型 ID，该模型会被安全保存并立即用于当前会话：

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

如果 `bash` 不在 `PATH` 中，可以显式配置：

```powershell
$env:EVERPEACE_BASH_PATH="D:\GitBash\Git\usr\bin\bash.exe"
```

## 使用

```text
✦ Everpeace Agent (v0.1.26) · 天下长平，以规司矩

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

TUI 自身界面现统一使用英文。任务运行时会显示按供应商识别的状态，例如 `Waiting for DeepSeek (3s • ctrl+c to interrupt)`，进入工具调度阶段后切换为 `Working`。模型回复支持 GitHub Flavored Markdown，包括标题、列表、强调、链接、表格、行内代码和 fenced code；代码块及 Bash/PowerShell 命令使用语言感知的终端高亮，超大内容会安全退回纯文本。

命令与对话正文使用不同层级展示：运行中显示 `Running`，完成的模型命令显示 `Ran`，用户直接命令显示 `You ran`，并附带状态色、shell、耗时和保留输出。模型 `diff` 代码块及命令输出中的标准 unified diff 会显示新旧行号、青色文件/hunk 标题、绿色新增和红色删除；真彩终端使用随明暗背景调整的底色，低色彩及 `NO_COLOR` 环境仍保留结构标记。恢复旧 Session 时，已知旧中文系统/工具提示只在显示层翻译，不改写 JSONL，也不翻译用户或模型正文。

输入区域会直接跟随终端的当前可用宽度，并预留最后一列防止 Windows Terminal 自动换行；启动时的 model/directory 信息框与 Codex 一样把内容区限制为 56 格（含内边距和边框共 60 列），每行预先裁剪，在窄终端中只缩短、不换行。输入区只有显式换行才会增高，过长输入会在当前行内水平裁剪，不会因 Ctrl + 滚轮缩放而自动折行。

TUI 使用原生 inline 模式，普通滚轮可以浏览已完成的 Everpeace 会话；Ctrl + 滚轮改变字号后，会采用 Codex 的 75ms 尾随延迟进行同步、基于源状态的重绘，完整恢复启动信息与会话，并且不会暴露清屏后的中间空帧。

第一次普通提问会创建本地 JSONL session。Everpeace 会保存对话记录和继续聊天所需的模型上下文，同时在后台单独调用当前模型，根据第一次提问生成简短名称。带信息或选择界面的 slash command 会打开独立临时窗口，隐藏 banner、历史、输入框和全局状态栏。命令窗口水平、垂直居中，最大宽度 80 列，并在窄终端自动缩小、保留安全边距。按 `Esc` 后原子重放并返回同一个 session，窗口内容不会加入历史。直接 `!` 命令的输出仍属于可恢复记录。`/new` 会立即创建并进入一个空 session，第一次提问后再替换临时名称。`/resume` 会按名称和最后活动时间列出本机全部 session，恢复原模型、原工作目录及上下文，并继续追加到同一个文件。Windows 下 session 默认保存在 `%APPDATA%\Everpeace\sessions`。

`/status` 会打开居中的独立 Codex 风格命令窗口，只显示状态详情和 `Esc` 返回提示。它显示当前模型、根据 `base_url` 识别的供应商、接口地址、工作目录、Session ID、当前 context 占用，以及主 Responses API 循环累计的输入/输出 token。Usage 总量会随 session 持久化并由 `/resume` 恢复，但状态窗口本身不会加入 transcript；恢复后再次执行 `/status` 即可查看累计值。后台标题请求不计入统计。已知官方 model ID 使用文档公布的 context 上限，未知型号和自定义兼容端点显示 `N/A`，不会猜测。

输入快捷键与 Codex composer 保持一致：`Enter` 提交，`Shift+Enter`、`Alt+Enter` 或 `Ctrl+J` 换行，`Home`/`End` 与 `Ctrl+A`/`Ctrl+E` 移动到当前行首/行尾，`Ctrl+U`/`Ctrl+K` 删除到当前行首/行尾，`Ctrl+W` 删除前一个词，`Ctrl+Y` 恢复最近删除的内容。方向键、`Ctrl+B/F/P/N` 和 `Alt+B/F` 也可移动光标。

在输入区开头输入 `/` 会在下方打开斜杠命令菜单。菜单会随输入进行不区分大小写的前缀筛选，每次最多显示八个命令，并可滚动访问其余匹配项。使用 `↑`/`↓` 或 `Ctrl+P/N` 选择，`Enter` 直接执行选中命令，`Tab` 只补全不执行，`Esc` 关闭菜单但保留输入。

TUI 会在启动、退出及 `!` 命令结束时关闭终端焦点事件上报，切换窗口不会再把 `[I`、`[O` 写入输入框。

TUI 命令：

- `/login`：登录并立即启用一个模型。
- `/model`：切换已注册模型，切换后重置对话上下文。
- `/models`：查看所有模型和凭据状态。
- `/status`：查看当前模型、供应商、context window 和 session token 使用量。
- `/permissions`：选择只读、逐条审批或完全访问模式，并开关网页工具。
- `/outputs`：分页浏览保留输出、已高亮的命令及 unified diff。
- `/history`：浏览或明确确认后清空全局输入历史，不删除 Session。
- `/terminal-setup`：预览并可选配置稳定版 Windows Terminal 的 Shift+Enter；确认后先备份设置，再新增全局按键绑定。
- `/new`：立即创建并进入一个新的本地 session。
- `/resume`：查看并恢复本机 JSONL session。
- `/resume` 后上下键浏览该会话保存的用户提问及带来源记录的直接命令，向下越过最新一条回到空输入。召回的斜杠命令在编辑前不打开候选菜单；`/history` 仍显示全局输入历史。
- `/logout`：多选删除模型与对应系统凭据。
- `/clear`：结束当前对话并清屏；下一次提问创建新 session，同时保留当前模型。
- `/help`、`/exit`：显示帮助或退出。
- `!<command>`：直接运行当前系统的命令行（Windows 使用 PowerShell，macOS/Linux 使用 Bash），不再次确认；PTY 排版结果会流式写入 TUI 历史，不再暂停或整页刷新交互界面。

行为说明：

- 核心循环已适配 Codex 的采样、工具执行、后续采样流程，提供逐工具结果保存、可取消的请求重试和并发轮次防护。这不是完整 Codex runtime，详见 [源码对应与移植范围](docs/architecture/AGENT_LOOP.md)。

- 默认 `ask` 模式逐条确认模型 Bash；`read-only` 拒绝所有模型 Bash；`full-access` 经二次明确确认后免审批。
- 模型可以用 `read_file` 查看工作目录内不超过 128 KiB 的 UTF-8 文件，用 `list_directory` 列出最多 500 个目录项。拒绝目录外路径和符号链接越界。文件正文会进入模型 context 和 Session 文件，请避免读取机密。
- 权限在当前进程内跨 `/new`、`/clear`、`/resume` 保留，重启恢复逐条审批、网页工具开启；切换权限不丢失 context，恢复 JSONL 不会恢复完全访问授权。
- 当前是应用层权限，不是 OS 沙箱。获批 Bash 仍拥有当前系统账户的文件和网络权限；关闭网页工具不限制 Bash 网络、模型 API 或直接 `!` 命令。详见 [对标与安全限制](docs/architecture/PERMISSIONS.md)。
- 网页搜索和公共页面读取属于只读工具调用，不需要确认。搜索词会先发送给 Bing，失败时回退到 DuckDuckGo；打开搜索结果时会向对应网站发送请求。
- 网页读取只允许公共 HTTP/HTTPS 地址，会逐次检查重定向、阻止本机和内网地址，并限制超时与响应大小；返回内容始终作为不可信数据处理。
- 搜索可用性和结果质量取决于外部搜索服务及当前网络。联网失败会作为工具结果返回模型，由模型说明限制或尝试其他来源。
- `!<command>` 是用户直接输入的本机终端命令，不会再次确认，也不会加入模型上下文。
- 模型名称在 login 时直接来自所选端点的 `/models` 接口。
- 重复 login 相同 `base_url + model_name` 会更新 Key，不会生成重复注册项。
- 远程自定义 base URL 必须使用 HTTPS；只有本机地址可使用 HTTP。
- 系统凭据库不可用时会直接失败，不会降级为明文存储。
- Linux 使用持久化的 Secret Service；如果不可用，不会回退到仅存于内存的 kernel keyring。
- Bash 命令使用当前用户权限运行，没有额外沙箱。
- 每次 Bash 调用都是独立进程，`cd` 和临时环境变量不会在调用间保留。
- TUI 需要交互式终端；重定向或管道环境下会直接给出错误提示。

## 项目结构

```text
src/
├─ cli/          # CLI 入口以及 login/models/logout/run 命令
├─ agent/        # ReAct 循环和会话状态
├─ providers/    # DeepSeek、OpenAI 及兼容端点适配
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
- 模型请求的 Bash 运行时通过有界预览展示最前五行和最后五行及省略数量，终端高度不足时对称缩减；用户直接 `!` 仍优先展示最新五行，完成后的长输出继续折叠。`/outputs` 查看保留内容，每条 UI 记录最多 10,000 行 / 2 MiB，已截断内容不可恢复。模型 Bash 分别保留最多 1 MiB 的 stdout/stderr，不提供交互 stdin；用户直接 `!` 命令仍支持交互输入。
