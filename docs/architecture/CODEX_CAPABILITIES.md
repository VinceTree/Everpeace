# Codex Sandbox、MCP 与 Skill 接入

## 对标基线

本轮先读取 OpenAI 官方 [Permissions](https://developers.openai.com/es-419/docs/permissions)、[MCP](https://developers.openai.com/es-419/docs/extend/mcp?surface=cli) 和 [Skills](https://developers.openai.com/es-419/docs/build-skills) 文档，再检查 `openai/codex` 源码提交 [`78245b47af2a7aafcabe025828ceecca69db4df1`](https://github.com/openai/codex/tree/78245b47af2a7aafcabe025828ceecca69db4df1)。重点映射如下：

- Sandbox：`codex-rs/core/src/sandboxing/mod.rs`、`codex-rs/core/src/tools/sandboxing.rs`、`codex-rs/cli/src/debug_sandbox.rs` 和 Windows sandbox wrapper。
- MCP：`codex-rs/core/src/mcp.rs`、`codex-rs/core/src/session/mcp_runtime.rs`、`codex-rs/core/src/tools/handlers/mcp.rs` 和 `codex-rs/core/src/mcp_tool_call.rs`。
- Skills：`codex-rs/skills/src/parser.rs`、`codex-rs/ext/skills/src/host_roots.rs`、`catalog_prompt.rs` 和 `tools/read.rs`。

Everpeace 没有复制整套 Rust runtime；它固定依赖 `@openai/codex@0.162.0` 作为 sandbox 执行后端，Windows 启动时显式选择 MXC，使用官方 MCP TypeScript SDK，并在现有 Responses/ReAct 循环内实现 Codex 对齐的主机 Skill 发现与渐进读取。

## Sandbox

模型发起的命令统一经 `codex sandbox` 启动并包含 `--include-managed-config`。read-only/full-access 选择内置 profile；ask/workspace-write 使用宿主按当前工作区生成的完整 `:workspace` 子 profile，保护控制目录和平台应用状态。每次调用前冻结有效策略并显式开启后端默认环境凭据排除；启动 Node wrapper 前也会过滤继承的凭据/启动注入变量，不会根据命令输出自动重放 payload。固定源码对比与后续统一策略计划见 [SANDBOX.md](./SANDBOX.md)。profile 映射为：

| Everpeace mode | 审批 | Codex profile |
| --- | --- | --- |
| `read-only` | 每次模型 shell 请求审批 | `:read-only` |
| `ask` | 每次模型 shell 请求审批 | `:workspace` |
| `workspace-write` | 无逐条 shell 审批 | `:workspace` |
| `full-access` | 二次确认后免工具审批 | `:danger-full-access` |

Sandbox 和审批保持两层独立判断。CLI、平台二进制或 sandbox 初始化失败时，命令返回失败结果，不会退回宿主直接执行。Skill 目录以额外只读根传给 sandbox，允许被选中的 Skill 引用自己的脚本和资源。

Windows 的 Codex restricted-token backend 可以运行系统 PowerShell，但 Git Bash/MSYS 在该令牌中会因自身服务初始化返回 `E_ACCESSDENIED`。因此 Windows 模型命令使用非交互 PowerShell；macOS/Linux 使用 Bash。用户亲自输入的 `!<command>` 仍走原有原生 PTY，不进入模型 sandbox，也不进入模型 context。

这不是完整 Codex runtime：当前会把后端 managed requirements 纳入 profile 解析，但未把同一策略扩展到全部宿主工具，也未接入自动审批 reviewer、代理域名策略或额外可写根 UI。Everpeace 的用户 command rules 和独立 shell 网络开关持久化在平台配置目录；可选的项目策略只能收紧模式、关闭 web/shell 网络或追加 deny/ask 规则，不能通过仓库文件提升权限，也不替代原生 sandbox。复合命令逐段检查，嵌套解释器和含糊语法转为审批；`:workspace` 的实际文件与网络限制仍由固定版本后端执行。

## MCP

`McpRuntime` 通过同一固定版本的 `codex mcp list --json` 与 `codex mcp get <name> --json` 读取 Codex 用户/可信项目配置，不另造第二份 MCP 配置。它支持：

- stdio 和 Streamable HTTP transport；
- stdio `command`、`args`、显式环境、继承环境名和工作目录；
- HTTP 静态 header、环境变量 header 和 bearer-token 环境变量；
- 启动/调用超时、enabled/disabled tool 过滤、单服务器失败隔离；
- server instructions、按初始化 capabilities 注册工具/资源/提示入口、受限分页工具发现与 `notifications/tools/list_changed` 热更新；
- `mcp__<server>__<tool>` 命名空间、参数转发、有界结果和取消；
- `/mcp` 强制重载配置、重置重试状态，并显示 disabled/connecting/reconnecting/ready/failed 状态。

每个 server 有独立 supervisor。瞬时启动失败或断连使用 500 ms 起步、30 秒封顶的指数退避，最多重试十次；连接连续稳定 30 秒才清零计数。配置不支持、认证不可用、stdio executable 明确缺失等永久错误直接进入 failed。断连先从目录原子移除该 server 的全部 callable，再关闭旧 client；初始化未完成的 client 也由 supervisor 管理，关闭同时等待 SDK close 完成及 transport 的实际 close 事件。五秒内不能确认关闭时停止自动恢复，不能同时建立替代连接。退出、切换工作区、`/mcp` 主动刷新都会取消旧 generation 的连接和 timer，迟到 callback 不能复活它。默认 TUI 在正常退出和启动失败路径都等待共享 `TuiDependencies.dispose()`；它关闭活动 Memory runtime 与 `McpRuntime`，即使清理失败也继续恢复终端模式。

恢复只影响后续调用。断连时正在进行的 tool call 不自动重放；普通业务错误、单次 tool timeout 和用户取消不会单独触发 reconnect。Streamable HTTP 已有 session ID 收到 404 时，宿主将该会话视为失效，通过同一关闭/重连流程建立后续连接；SDK 自身的 SSE 流恢复仍由 SDK 管理。`tools/list_changed` 通知以 50 ms 合并；每次先完整读取分页结果，再原子替换该 server 的工具定义和执行校验器。失败时保持上一份完整目录并在 status 中记录错误，真正断连则立即移除。发现最多 100 页、1,000 个工具和 2 MiB 定义，连接、发现及校验器编译共享配置的启动期限；重复 cursor、重复原始工具名及超限都明确失败。

`McpSnapshot` 在同一时刻复制 function definitions、annotations/审批所需 metadata 和 opaque binding。binding 摘要包含随机 connection ID、完整原始定义（包括 `outputSchema`、`execution` 和 annotations）及最终 callable name。Agent 为每个逻辑 step 冻结该快照，普通网络重试复用；dispatch 同时检查当前连接 generation 和冻结 binding，因此工具在审批等待或下一步前被删除、重连或改定义后，旧调用返回 stale/unavailable，不会转发到新能力。

发现与调用使用 SDK 公共 `request` 和对应 result schema，不依赖其按页覆盖的工具 metadata cache。已发布定义分别编译 output validator，远端重复使用相同 `$id` 不会复用另一工具或旧定义的校验器。进行中的调用按派发时捕获的定义验证 `structuredContent`；刷新失败不改变旧校验器。无效或异步 output schema 拒绝整次目录更新。要求 task-based execution 的工具不向模型广告，`/mcp` 明确显示 unsupported；optional-task 工具仍可普通调用。

除 `full-access` 外，每次 MCP tool call 都走独立审批；它不受内置 web 开关替代或放行。工具调用及结果和其他 function call 一样进入可恢复 Responses context；配置 header、bearer token 和 stdio 环境值只在连接时使用，不写入 session、transcript 或模型 instructions。

除标准 tools 外，宿主按初始化 capabilities 注册受审批的 `list_resources`、`list_resource_templates`、`read_resource`、`list_prompts` 和 `get_prompt`。只有 resources、prompts 或 instructions 的 server 也能进入 ready，不需要成功发现标准 tools。三个 list 接口接收可选 `cursor`，每次实时读取一页，并原样返回服务器游标为 `next_cursor`；空页也保留续点，返回与请求相同的非空游标则拒绝。空字符串游标仍原样转发；若服务器持续返回相同空游标而不前进，应重新列举，宿主不猜测替代游标。单页最多 1,000 项且完整序列化结果最多 1 MiB；超限返回 `incomplete` 与 `range_error`，不返回会跳过遗漏条目的续点。read/get 同样按需读取，不缓存目录、不自动订阅资源更新。

MCP 文本投影保留文本、URI 和 MIME；只处理协议明确的 tool `content[]`、prompt `messages[].content`、resource `contents[]` 及其中嵌入的 resource 内容块，将 image/audio/blob 的 base64 替换为类型与大小说明。`structuredContent`、各层 `_meta` 和列表 metadata 不递归改写，业务字段即使名为 `blob` 或形如 image 也保持原值。普通结果连同截断 envelope 保持有效 JSON 且最多 1 MiB。Client 声明 `roots: { listChanged: true }` 并应答 `roots/list`，把当前工作区作为唯一 root 提供给 server；`setWorkspace` 通过断开重连让新工作区生效。Codex OAuth 凭据复用、`http_headers_helper`、elicitation、sampling、tasks 和按工具持久审批策略尚未接入。OAuth/header-helper server 会以明确失败状态显示；不得声称与完整 Codex MCP runtime 等价。

模型文件编辑通过兼容的 `apply_patch` function tool 接入，支持有界 unified diff；生产 update/delete 强制匹配宿主读版本，审批绑定 preview hash 与权限 revision。更新逐文件原子替换，创建排他执行；批量失败仅回滚仍匹配本次 post-image 的已写文件，冲突或回滚错误明确报告，不保证整个批次原子成功。详见 [TOOLS](TOOLS.md)；它不是完整 Codex 原生 `apply_patch_call` wire protocol。

MCP 的真实 stdio 恢复回归见 [stdio-recovery.test.ts](../../tests/unit/mcp/stdio-recovery.test.ts)。fixture 启动期限覆盖 Node／tsx／SDK 冷启动，首代主动不回应初始化以触发超时；仍严格检查恰好两代、旧进程先退出、binding 失效和不重放。测试时间预算见 [开发指南](../DEVELOPMENT.md#独立测试-ci-与证据范围)，不会修改生产默认期限或恢复策略。

MCP SDK 安全修复按 [官方公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h) 升级并同步 lock。实际 `src/mcp/runtime.ts` 的 StreamableHTTP transport 仅传 requestInit headers，不配置 OAuth authProvider；stdio 也没有 OAuth 调用路径。依赖告警需要处理，但不能据此声称当前应用已经泄漏 OAuth client 凭据。stdio、Streamable HTTP、断连不重放与资源关闭仍由真实协议回归验证，远端告警状态在最终交接记录。

## Skills

`SkillCatalog` 的开发/嵌入装配可显式提供发现根；传入时仅扫描这些根，不读取默认用户或系统目录。正常生产构造不传 roots，继续使用下面的完整发现规则。离线 TUI 用它加载本轮隔离 Skill，不修改用户环境或个人 Skill 库。

`SkillCatalog` 按 Codex 主机 Skill 规则发现：

- 从当前工作目录向项目根查找每层 `.agents/skills`；
- 项目根 `.codex/skills`；
- `$CODEX_HOME/skills`（默认 `~/.codex/skills`，含系统 Skill cache）；
- `~/.agents/skills`；
- 非 Windows 的 `/etc/codex/skills`。

目录 symlink 可以指向 Skill；读取引用资源时再次 realpath，并拒绝逃逸 Skill 根目录。`SKILL.md` 必须有 YAML frontmatter 和非空 `description`，管理器创建或安装的新 Skill 名称还必须使用小写字母、数字和连字符且最长 64 个字符；扫描深度、条目数、单文件大小和模型 catalog 均有限制。

模型请求只预载名称、描述和路径。用户写 `$skill-name` 时，本轮在首次采样前完整注入对应 `SKILL.md`；隐式匹配由模型根据 catalog 判断，并通过 `read_skill` 分页读取完整说明或相对资源。Skill 不自动延续到下一轮。`/skills` 重新扫描并显示全部发现结果和错误数。

`/skills` 现为三入口管理向导：

- 创建：每次选择项目或用户作用域，按供应商能力构造无工具的有界辅助请求，只接受一个完整 `SKILL.md`；非 OpenAI 端点不强行发送 `store` 字段。生成后可让模型再次校验/改进、在 TUI 中编辑完整文件，或确认保存。
- URL 安装：接受公开 HTTPS GitHub 仓库/文件夹、任意公开 Git 仓库根、直接 `SKILL.md` 和单/多 Skill ZIP。来源先进入系统临时目录；Git 来源先 shallow、no-checkout clone，再从 Git tree 读取候选 metadata、按 Skill 名称优先保留规范 `skills/<name>` 副本，并只 sparse checkout 通过预检的候选目录；发现多个不同 Skill 时用户只选择一个。完整 `SKILL.md`、来源和文件数量先预览，之后再选择作用域并明确确认。
- 查看：列出所有发现的 Skill，显示完整内容；可把 `$name` 回填到主输入框，实际显式激活仍发生在用户提交该问题时。

项目创建/安装目标固定为项目根 `.agents/skills/<name>`，用户目标为 `$CODEX_HOME/skills/<name>`。写入先复制到同一目标根的隐藏 staging 目录，重新校验后 rename；任何发现根已经存在同名 Skill或目标目录已存在时都拒绝覆盖。catalog 发现多个同名 Skill 时保留可见冲突记录，但从模型 metadata catalog 中排除该名称，`$name` 和 `read_skill` 也返回歧义错误，避免作用域优先级静默选择错误内容。

远端安装边界为：仅 HTTPS、URL 不得包含凭据或 fragment；普通下载每次重定向都重新执行公共地址/DNS 校验，最多 5 次、30 秒和 20 MiB；Git clone 关闭 HTTP 重定向、启用 Windows long-path 支持、浅克隆且整个准备阶段限制 60 秒。ZIP 最多 10,000 项，来源遍历最多 10,000 项，单个 Skill 最多 5,000 项；Git tree 最多 20,000 个 tracked entries，最多读取 500 个 `SKILL.md` 清单，并在按名称优先保留规范目录后限制为 100 个不同候选。解压或单包总量限制 50 MiB、单文件 10 MiB、`SKILL.md` 512 KiB，并在 checkout 前拒绝候选中的 symlink、gitlink 和其他特殊条目；文件系统校验继续拒绝绝对路径、`..` 穿越、符号链接和特殊文件。取消、失败、返回菜单或离开向导时清理临时准备目录。当前不支持私有仓库、认证 URL、更新和删除。

当前仍只把已安装内容作为主机文件 Skill 使用；没有接入 Codex plugins、orchestrator/executor Skill provider、远端资源 authority、动态 selector、`agents/openai.yaml` UI metadata 或 `[[skills.config]]` 开关。Skill 内容和 MCP 返回内容都属于用户启用的扩展数据，不能改变应用权限，也不能绕过 sandbox 或审批。

[SkillManager](../../src/skills/manager.ts) 记录所有活动准备和 Git 子进程，Unix Git 使用独立进程组。close 永久关闭准入，取消下载和 Git，等待准备、child close 与单次进程树终止后才删除安全预览；重复 close 复用同一 promise。清理失败以 typed ProcessCleanupError 保留，不能被用户取消替换，也不删除可能仍被后代使用的 stage；故障管理器拒绝后续安装。TUI 共享 dispose 同时等待 Memory、MCP 和 Skill 管理器，任一失败不阻止其他服务清理或终端恢复。回归见 [manager](../../tests/unit/skills/manager.test.ts)、[read process lifecycle](../../tests/unit/tools/read-process-lifecycle.test.ts) 和 [TUI lifecycle](../../src/tui/index.tsx)。

## Session 与兼容性

Session JSONL 现以兼容方式追加 `workflow_updated` 事件，保存当前 workflow phase、变更路径、repair 次数和最后一次有界验证结果；持久化快照清空验证 stdout/stderr/error，旧文件缺少该事件时按无 workflow 元数据读取。工作流不会把文件 before/after 内容或检查点写入 JSONL，检查点只存在当前进程。Skill catalog、MCP 连接和权限授权都不从 session 恢复；function call 与结果仍按既有 context 事件持久化。原有兼容端点如果不能接受动态 function tool schema，会把服务端错误正常返回给当前模型请求，不会改写注册信息或泄露凭据。
