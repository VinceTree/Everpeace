# Everpeace

[English](./README.md) | **简体中文**

Everpeace 是一个带交互式 TUI 的 ReAct coding agent，支持 DeepSeek、OpenAI 和自定义 OpenAI-compatible API。普通输入由所选模型处理，模型可以请求调用 Bash；你也可以用 `!<command>` 直接运行本地命令。

API Key 不从环境变量读取，也不会写入项目或配置 JSON。Everpeace 使用操作系统凭据库保存 Key，并在本地模型注册表中只保存模型名、base URL 和凭据引用。

## 需求

- Node.js 22+
- pnpm
- macOS/Linux 上的 Bash，或 Windows 上的 Git Bash/WSL Bash
- DeepSeek、OpenAI 或兼容服务的 API Key

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
✦ Everpeace Agent (v0.1.19) · 天下长平，以规司矩

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
```

输入区域会直接跟随终端的当前可用宽度，并预留最后一列防止 Windows Terminal 自动换行；启动时的 model/directory 信息框与 Codex 一样把内容区限制为 56 格（含内边距和边框共 60 列），每行预先裁剪，在窄终端中只缩短、不换行。输入区只有显式换行才会增高，过长输入会在当前行内水平裁剪，不会因 Ctrl + 滚轮缩放而自动折行。

TUI 使用原生 inline 模式，普通滚轮可以浏览已完成的 Everpeace 会话；Ctrl + 滚轮改变字号后，会采用 Codex 的 75ms 尾随延迟进行同步、基于源状态的重绘，完整恢复启动信息与会话，并且不会暴露清屏后的中间空帧。

第一次普通提问会创建本地 JSONL session。Everpeace 会保存完整可见记录和继续聊天所需的模型上下文，同时在后台单独调用当前模型，根据第一次提问生成简短名称。`/new` 会立即创建并进入一个空 session，第一次提问后再替换临时名称。`/resume` 会按名称和最后活动时间列出本机全部 session，恢复原模型、原工作目录及上下文，并继续追加到同一个文件。Windows 下 session 默认保存在 `%APPDATA%\Everpeace\sessions`。

输入快捷键与 Codex composer 保持一致：`Enter` 提交，`Shift+Enter`、`Alt+Enter` 或 `Ctrl+J` 换行，`Home`/`End` 与 `Ctrl+A`/`Ctrl+E` 移动到当前行首/行尾，`Ctrl+U`/`Ctrl+K` 删除到当前行首/行尾，`Ctrl+W` 删除前一个词，`Ctrl+Y` 恢复最近删除的内容。方向键、`Ctrl+B/F/P/N` 和 `Alt+B/F` 也可移动光标。

TUI 会在启动、退出及 `!` 命令结束时关闭终端焦点事件上报，切换窗口不会再把 `[I`、`[O` 写入输入框。

TUI 命令：

- `/login`：登录并立即启用一个模型。
- `/model`：切换已注册模型，切换后重置对话上下文。
- `/models`：查看所有模型和凭据状态。
- `/new`：立即创建并进入一个新的本地 session。
- `/resume`：查看并恢复本机 JSONL session。
- `/logout`：多选删除模型与对应系统凭据。
- `/clear`：结束当前对话并清屏；下一次提问创建新 session，同时保留当前模型。
- `/help`、`/exit`：显示帮助或退出。
- `!<command>`：直接运行当前系统的命令行（Windows 使用 PowerShell，macOS/Linux 使用 Bash），不再次确认；PTY 排版结果会流式写入 TUI 历史，不再暂停或整页刷新交互界面。

行为说明：

- 模型提出的命令每次都需要确认。
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
