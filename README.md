# Everpeace

一个带交互式 TUI 的 ReAct coding agent，支持 DeepSeek、OpenAI 和自定义 OpenAI-compatible API。普通输入由所选模型处理，模型可以请求调用 Bash；你也可以用 `!<command>` 直接运行 Bash。

API Key 不从环境变量读取，也不会写入项目或配置 JSON。Everpeace 使用操作系统凭据库保存 Key，并在本地模型注册表中只保存模型名、base URL 和凭据引用。

## 需求

- Node.js 22+
- pnpm
- macOS/Linux 上的 Bash，或 Windows 上的 Git Bash/WSL Bash
- DeepSeek、OpenAI 或兼容服务的 API Key

## 开发运行

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

如果 `bash` 不在 PATH 中，可以显式配置：

```powershell
$env:EVERPEACE_BASH_PATH="D:\GitBash\Git\usr\bin\bash.exe"
```

## 使用

```text
✦ Everpeace Agent (v0.1.14) · 天下长平，以规司矩

╭──────────────────────────────────────────────╮
│ model: deepseek-flash  /model to change      │
│ directory: C:\projects\Everpeace              │
╰──────────────────────────────────────────────╯

everpeace ❯ 列出当前项目文件

assistant  我将查看当前目录。

! ls -la
是否执行？ y
...

everpeace ❯ !git status
...
```

输入区域会直接跟随终端的当前可用宽度，并预留最后一列防止 Windows 终端自动换行；启动时的 model/directory 信息框采用 Codex 风格的 76 列上限，在窄终端中自动收缩。交互输入框始终固定为三行，过长输入会在框内裁剪，不会撑出新行。TUI 使用原生 inline 模式，普通滚轮可以浏览 PowerShell 历史；Ctrl + 滚轮改变字号时会清除被终端重新排版的旧帧和 scrollback，再按新尺寸完整重绘，界面只保留一个交互框。

TUI 命令：

- `/login`：登录并立即启用一个模型。
- `/model`：切换已注册模型，切换后重置对话上下文。
- `/models`：查看所有模型和凭据状态。
- `/logout`：多选删除模型与对应系统凭据。
- `/clear`：清屏并重置当前对话，保留当前模型。
- `/help`、`/exit`：显示帮助或退出。
- `!<command>`：直接运行当前系统的命令行（Windows 使用 PowerShell，macOS/Linux 使用 Bash），不再次确认；执行时会接管当前终端，原生输出保留在终端 scrollback 中。

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
├─ cli/          # CLI 入口、交互组件和 login/models/logout/run 命令
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
