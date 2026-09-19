# Codex Sandbox、MCP 与 Skill 接入

## 对标基线

本轮先读取 OpenAI 官方 [Permissions](https://developers.openai.com/es-419/docs/permissions)、[MCP](https://developers.openai.com/es-419/docs/extend/mcp?surface=cli) 和 [Skills](https://developers.openai.com/es-419/docs/build-skills) 文档，再检查 `openai/codex` 源码提交 [`78245b47af2a7aafcabe025828ceecca69db4df1`](https://github.com/openai/codex/tree/78245b47af2a7aafcabe025828ceecca69db4df1)。重点映射如下：

- Sandbox：`codex-rs/core/src/sandboxing/mod.rs`、`codex-rs/core/src/tools/sandboxing.rs`、`codex-rs/cli/src/debug_sandbox.rs` 和 Windows sandbox wrapper。
- MCP：`codex-rs/core/src/mcp.rs`、`codex-rs/core/src/session/mcp_runtime.rs`、`codex-rs/core/src/tools/handlers/mcp.rs` 和 `codex-rs/core/src/mcp_tool_call.rs`。
- Skills：`codex-rs/skills/src/parser.rs`、`codex-rs/ext/skills/src/host_roots.rs`、`catalog_prompt.rs` 和 `tools/read.rs`。

Everpeace 没有复制整套 Rust runtime；它固定依赖 `@openai/codex@0.155.1` 作为 sandbox 执行后端，使用官方 MCP TypeScript SDK，并在现有 Responses/ReAct 循环内实现 Codex 对齐的主机 Skill 发现与渐进读取。

## Sandbox

模型发起的命令统一经 `codex sandbox -P <profile> -C <workspace> -- <shell>` 启动。profile 映射为：

| Everpeace mode | 审批 | Codex profile |
| --- | --- | --- |
| `read-only` | 每次模型 shell 请求审批 | `:read-only` |
| `ask` | 每次模型 shell 请求审批 | `:workspace` |
| `workspace-write` | 无逐条 shell 审批 | `:workspace` |
| `full-access` | 二次确认后免工具审批 | `:danger-full-access` |

Sandbox 和审批保持两层独立判断。CLI、平台二进制或 sandbox 初始化失败时，命令返回失败结果，不会退回宿主直接执行。Skill 目录以额外只读根传给 sandbox，允许被选中的 Skill 引用自己的脚本和资源。

Windows 的 Codex restricted-token backend 可以运行系统 PowerShell，但 Git Bash/MSYS 在该令牌中会因自身服务初始化返回 `E_ACCESSDENIED`。因此 Windows 模型命令使用非交互 PowerShell；macOS/Linux 使用 Bash。用户亲自输入的 `!<command>` 仍走原有原生 PTY，不进入模型 sandbox，也不进入模型 context。

这不是完整 Codex runtime：当前未接入 prefix rules、managed policy、自动审批 reviewer、网络代理域名策略或额外可写根 UI。`:workspace` 的实际文件与网络限制由固定版本 Codex 的当前平台 backend 执行。

## MCP

`McpRuntime` 通过同一固定版本的 `codex mcp list --json` 与 `codex mcp get <name> --json` 读取 Codex 用户/可信项目配置，不另造第二份 MCP 配置。它支持：

- stdio 和 Streamable HTTP transport；
- stdio `command`、`args`、显式环境、继承环境名和工作目录；
- HTTP 静态 header、环境变量 header 和 bearer-token 环境变量；
- 启动/调用超时、enabled/disabled tool 过滤、单服务器失败隔离；
- server instructions 与分页工具发现；
- `mcp__<server>__<tool>` 命名空间、参数转发、有界结果和取消；
- `/mcp` 强制刷新连接并显示 ready/failed/disabled 状态。

除 `full-access` 外，每次 MCP tool call 都走独立审批；它不受内置 web 开关替代或放行。工具调用及结果和其他 function call 一样进入可恢复 Responses context；配置 header、bearer token 和 stdio 环境值只在连接时使用，不写入 session、transcript 或模型 instructions。

当前范围只把 MCP tools 暴露给模型。Codex OAuth 凭据复用、`http_headers_helper`、resources、prompts、elicitation、sampling、tasks、list-changed 热更新和按工具持久审批策略尚未接入。OAuth/header-helper server 会以明确失败状态显示；不得声称与完整 Codex MCP runtime 等价。

## Skills

`SkillCatalog` 按 Codex 主机 Skill 规则发现：

- 从当前工作目录向项目根查找每层 `.agents/skills`；
- 项目根 `.codex/skills`；
- `$CODEX_HOME/skills`（默认 `~/.codex/skills`，含系统 Skill cache）；
- `~/.agents/skills`；
- 非 Windows 的 `/etc/codex/skills`。

目录 symlink 可以指向 Skill；读取引用资源时再次 realpath，并拒绝逃逸 Skill 根目录。`SKILL.md` 必须有 YAML frontmatter 和非空 `description`，管理器创建或安装的新 Skill 名称还必须使用小写字母、数字和连字符且最长 64 个字符；扫描深度、条目数、单文件大小和模型 catalog 均有限制。

模型请求只预载名称、描述和路径。用户写 `$skill-name` 时，本轮在首次采样前完整注入对应 `SKILL.md`；隐式匹配由模型根据 catalog 判断，并通过 `read_skill` 分页读取完整说明或相对资源。Skill 不自动延续到下一轮。`/skills` 重新扫描并显示全部发现结果和错误数。

`/skills` 现为三入口管理向导：

- 创建：每次选择项目或用户作用域，向当前模型发送无工具、`store: false` 的生成请求，只接受一个完整 `SKILL.md`；生成后可让模型再次校验/改进、在 TUI 中编辑完整文件，或确认保存。
- URL 安装：接受公开 HTTPS GitHub 仓库/文件夹、任意公开 Git 仓库根、直接 `SKILL.md` 和单/多 Skill ZIP。来源先进入系统临时目录；Git 来源先 shallow、no-checkout clone，再从 Git tree 读取候选 metadata、按 Skill 名称优先保留规范 `skills/<name>` 副本，并只 sparse checkout 通过预检的候选目录；发现多个不同 Skill 时用户只选择一个。完整 `SKILL.md`、来源和文件数量先预览，之后再选择作用域并明确确认。
- 查看：列出所有发现的 Skill，显示完整内容；可把 `$name` 回填到主输入框，实际显式激活仍发生在用户提交该问题时。

项目创建/安装目标固定为项目根 `.agents/skills/<name>`，用户目标为 `$CODEX_HOME/skills/<name>`。写入先复制到同一目标根的隐藏 staging 目录，重新校验后 rename；任何发现根已经存在同名 Skill或目标目录已存在时都拒绝覆盖。catalog 发现多个同名 Skill 时保留可见冲突记录，但从模型 metadata catalog 中排除该名称，`$name` 和 `read_skill` 也返回歧义错误，避免作用域优先级静默选择错误内容。

远端安装边界为：仅 HTTPS、URL 不得包含凭据或 fragment；普通下载每次重定向都重新执行公共地址/DNS 校验，最多 5 次、30 秒和 20 MiB；Git clone 关闭 HTTP 重定向、启用 Windows long-path 支持、浅克隆且整个准备阶段限制 60 秒。ZIP 最多 10,000 项，来源遍历最多 10,000 项，单个 Skill 最多 5,000 项；Git tree 最多 20,000 个 tracked entries 和 100 个候选。解压或单包总量限制 50 MiB、单文件 10 MiB、`SKILL.md` 512 KiB，并在 checkout 前拒绝候选中的 symlink、gitlink 和其他特殊条目；文件系统校验继续拒绝绝对路径、`..` 穿越、符号链接和特殊文件。取消、失败、返回菜单或离开向导时清理临时准备目录。当前不支持私有仓库、认证 URL、更新和删除。

当前仍只把已安装内容作为主机文件 Skill 使用；没有接入 Codex plugins、orchestrator/executor Skill provider、远端资源 authority、动态 selector、`agents/openai.yaml` UI metadata 或 `[[skills.config]]` 开关。Skill 内容和 MCP 返回内容都属于用户启用的扩展数据，不能改变应用权限，也不能绕过 sandbox 或审批。

## Session 与兼容性

本轮没有改变 JSONL schema。Skill catalog、MCP 连接和权限授权都不从 session 恢复；function call 与结果仍按既有 context 事件持久化。原有兼容端点如果不能接受动态 function tool schema，会把服务端错误正常返回给当前模型请求，不会改写注册信息或泄露凭据。
