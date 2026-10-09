# 工具：文件、规则、搜索与后台命令

本文是工具修改的知识入口。启动仍先读 [AGENTS.md](../../AGENTS.md) 和 [HANDOFF](../HANDOFF.md)；只修改某类工具时，阅读对应小节及链接的实现/测试即可。请求与最终结算见 [RUNTIME](RUNTIME.md)，权限配置和原生后端细节见 [PERMISSIONS](PERMISSIONS.md)、[SANDBOX](SANDBOX.md)。

## 职责地图

| 能力 | 主要实现 | 回归入口 |
|---|---|---|
| 读取、目录、随包搜索、glob | [files.ts](../../src/tools/files.ts)、[ripgrep.ts](../../src/tools/ripgrep.ts) | [files.test.ts](../../tests/unit/tools/files.test.ts)、[ripgrep.test.ts](../../tests/unit/tools/ripgrep.test.ts) |
| Composer 文件引用 | [file-attachments.ts](../../src/agent/file-attachments.ts)、[prompt.tsx](../../src/tui/composer/prompt.tsx) | [file-attachments.test.ts](../../tests/unit/agent/file-attachments.test.ts)、[prompt-history.test.tsx](../../tests/unit/tui/prompt-history.test.tsx) |
| 文件版本与结构化编辑 | [file-version.ts](../../src/tools/file-version.ts)、[apply-patch.ts](../../src/tools/apply-patch.ts) | [apply-patch.test.ts](../../tests/unit/tools/apply-patch.test.ts)、[ReactAgent tests](../../tests/unit/agent/react-agent.test.ts) |
| 项目规则链 | [project-context.ts](../../src/agent/project-context.ts) | [project-context.test.ts](../../tests/unit/agent/project-context.test.ts) |
| 结果截断与附件续读 | [context-limits.ts](../../src/agent/context-limits.ts)、[session-outputs.ts](../../src/storage/session-outputs.ts) | [context-limits.test.ts](../../tests/unit/agent/context-limits.test.ts)、[session-outputs.test.ts](../../tests/unit/storage/session-outputs.test.ts) |
| 模型历史检索 | [session-history.ts](../../src/storage/session-history.ts) | [session-history.test.ts](../../tests/unit/storage/session-history.test.ts) |
| 模型命令与后台任务 | [bash.ts](../../src/tools/bash.ts)、[background-jobs.ts](../../src/tools/background-jobs.ts) | [bash.test.ts](../../tests/unit/tools/bash.test.ts)、[background-jobs.test.ts](../../tests/unit/tools/background-jobs.test.ts) |
| TypeScript 导航 | [code-navigation.ts](../../src/tools/code-navigation.ts)、[cli.ts](../../src/codex/cli.ts) | [code-navigation.test.ts](../../tests/unit/tools/code-navigation.test.ts)、[cli.test.ts](../../tests/unit/codex/cli.test.ts) |
| 模型 Git 工具与变更审阅 | [workspace.ts](../../src/tools/workspace.ts)、[workspace-review.ts](../../src/tools/workspace-review.ts) | [workspace.test.ts](../../tests/unit/tools/workspace.test.ts)、[workspace-review.test.ts](../../tests/unit/tools/workspace-review.test.ts) |
| 人工变更审阅 | [workspace-review.ts](../../src/tools/workspace-review.ts)、[workspace-diff-surface.tsx](../../src/tui/components/screens/workspace-diff-surface.tsx) | [workspace-review.test.ts](../../tests/unit/tools/workspace-review.test.ts)、[daily-use-surfaces.test.tsx](../../tests/unit/tui/daily-use-surfaces.test.tsx) |
| 公共网页 | [web.ts](../../src/tools/web.ts) | [web.test.ts](../../tests/unit/tools/web.test.ts) |

`ReactAgent` 使用 [StepToolCatalog](../../src/agent/step-tool-catalog.ts) 提供广告与准入，负责解析参数、观察读取、审批和 dispatch；工具实现不自行决定任务成功。新增工具要同时检查快照广告、Plan/权限、取消、结果持久化与最终变更追踪，不能只添加 schema。

## 文件读取与版本

内置文件／搜索、shell／后台命令和 patch 的已知失败增加可执行的 `errorCode`／`remedy`，成功结果和已有错误字段保持兼容。分类来自显式参数检查、`ToolFeedbackError`、已有 patch 错误码或 `timedOut`，不解析错误文案猜测；未知异常仍保留原错误。文件参数先校验字段、类型和上限再访问目标或启动搜索，拒绝广告 schema 之外的参数。`INVALID_ARGUMENTS` 指出字段及允许范围；`TOOL_UNAVAILABLE` 提供当前能力下的处理方式；`POLICY_DENIED` 明确禁止换工具绕过；`RULES_REFRESH_REQUIRED` 要求先阅读下一请求的规则。现有 `FILE_NOT_OBSERVED`、`STALE_VERSION` 与 patch 匹配错误继续要求重新读取或修正编辑。

[tool-feedback](../../src/tools/tool-feedback.ts) 的 `ToolArgumentError` 保存字段名，使 Composer 的越界行范围继续给出原有可操作提示，不依赖旧错误文案。回归见 [tool feedback tests](../../tests/unit/agent/tool-feedback.test.ts)，包含错误参数无执行、输出顺序、已知类型与任意异常区分、权限拒绝及前后台超时不重放。

- `read_file` 限定工作区内的普通 UTF-8 文本文件，最大 16 MiB；二进制和非法 UTF-8 拒绝。
- 参数 `start_line` 为一基行号，`max_lines` 默认 200、最多 1,000；返回 `start_line`、`end_line`、`total_lines` 和 `next_line`，中段内容可以继续读取。
- 返回的 `sha256` 是完整原始字节指纹，不是当前页或解码后文本指纹。不存在的文件返回 `exists: false` 和空版本。
- 路径先检查词法包含关系，再检查真实路径；不能利用 symlink/junction 越出工作区。Windows ADS 不支持；Linux 文件打开还使用 no-follow/non-blocking 保护。
- `list_directory` 返回有界条目及类型，不递归授权整个目录。搜索或 LSP 返回文件位置不等于读取过文件版本。

`ReactAgent` 在进程内维护 `read_file` 观察记录。update/delete 必须已有本进程观察版本，模型省略 `expectedSha256` 也不能绕过；模型提供的版本若与宿主记录不一致立即拒绝。Session 恢复的历史文本不能重新授权覆盖文件，恢复后必须重新读取。

`decodeTextFile` 从原始字节计算 SHA-256，并分别保存 BOM 和换行风格；编辑编码复用原文件的 UTF-8 BOM 与 LF/CRLF 风格，回滚保存原始字节。混合换行按检测到的风格编码，不应宣称任意混合格式逐字节保持。

## Composer 文件引用

输入区的 `@` 候选用参数数组启动有界、可取消的随包 `rg --no-config --files`，按路径筛选并显示最多八项。只有 Markdown 行内/围栏代码之外完整的 `@"path"` 或 `@"path"#L10-L40` 会扩展；邮箱、包名和普通 `@` 文本保持原样。提交前重新读取所有引用，任一引用失败都会保留原草稿并返回可操作错误。

摘录复用 `read_file` 的工作区包含、真实路径、UTF-8 与二进制保护。未写范围时从第一行读取 200 行；显式范围最多 1,000 行。每条消息最多八个不同的路径/范围，单个摘录最多 32 KiB，总计最多 64 KiB；达到字节限制时拒绝整条提交，不静默丢弃内容。标签记录实际起止行、总行数、完整文件原始字节 SHA-256 和是否省略其他行。

用户原文与带标签摘录作为同一条 durable user context item 先落盘，再进入模型请求；timeline、输入历史和标题生成只使用原文。普通问题和运行中 guidance 采用相同顺序与持久化边界，重试、修复和 Goal 续跑不重复附加摘录。引用路径参与本轮项目规则发现，但附件读取不写入文件观察表，因此不会授予 update/delete 权限；修改前模型仍须调用 `read_file`。Session 恢复可重放已持久化的上下文，但不会恢复写权限。

## 结构化编辑、审批和撤销

`apply_patch` 接受 create/update/delete 操作，由宿主预览并绑定观察版本。update 在完整 `content`、unified `patch` 和 `replace: { oldText, newText, matchMode? }` 中三选一。matchMode 默认 `exact`：非空 oldText 在规范化 CRLF/LF 后精确且唯一匹配，并拒绝不改变内容的替换。

只有显式 `line_whitespace` 且精确匹配不存在时才容错；精确匹配已歧义时直接拒绝。容错只接受全文件唯一的连续完整行块，仅忽略行首／行尾 ASCII 空格和 Tab，保留行数、空行位置及所有行内字符；纯空白目标、大小写／标点／字符串内部空格差异都拒绝。替换实际匹配范围，newText 按提交内容应用，不自动缩进；保留原 BOM 和主换行风格。预览和执行共用定位逻辑，返回 `matchMode` 与一基 `matchedLines: { start, end }`，审批正文明确显示方式和范围。原始字节与 permission revision 绑定、重新读取、回滚保护均保持。回归见 [line whitespace](../../tests/unit/tools/line-whitespace.test.ts)、[production editing](../../tests/unit/runtime/project-editing.test.ts)。

解析、预览和执行错误返回稳定原因及修复提示，覆盖无效参数、缺少当前进程观察、旧版本、未匹配或多重匹配、hunk 不符及策略拒绝。策略拒绝与可修复的编辑错误保持不同；任何替代编辑路径仍需通过同一权限边界。审批绑定预览文件 SHA-256 与权限 revision；审批期间权限变化或文件内容变化时不能沿用旧批准继续写入。create 使用排他创建，不能把期间新增的用户文件覆盖。

真正写入前再次比较目标版本；update 使用临时文件原子替换，delete 检查原版本后删除。工作区控制目录与平台状态保护继续有效，详见权限文档。

批量写入失败后，只逆序回滚本批已实际修改的文件，而且当前文件必须仍匹配本批 post-image。用户在此期间再次修改时保留用户内容，返回 `rollbackConflicts`；回滚 IO 错误返回 `rollbackErrors`，不能无条件报告 `rolledBack: true`。

`/undo` 使用 [TurnCheckpoint](../../src/workflow/checkpoint.ts) 的进程内检查点，只恢复结构化编辑，不承诺撤销任意 shell 副作用。恢复前比较当前版本，发生冲突不能覆盖用户内容。检查点及文件内容不写入 Session JSONL，重启后不伪造可撤销状态。

文件观察是防止盲写的必要条件，不替代完整验证；显式修改 ignored 文件也要纳入工作流追踪，详见 [RUNTIME](RUNTIME.md)。

## 按需项目地图

[project_map](../../src/tools/project-map.ts) 是共享 production Agent 的只读文件工具，TUI、exec、SDK 和 Plan 均可使用。`path` 默认工作区目录，只允许工作区内目录；`depth` 默认 2、范围 1–4，只控制结构展示深度。每次重新枚举，遵守随包 rg ignore 规则，不跟随 symlink/junction，排除 node_modules、vendor、虚拟环境及 `.git`／`.codex`／`.agents`／`.everpeace`，不查询系统 PATH、不建数据库或自动注入每轮请求。

结果包含观察到的目录结构、文件类型计数、包元数据和 README／AGENTS／测试／配置／manifest 位置。只解析 package.json 的 name、packageManager、脚本与声明入口（main/module/types/typings/bin/exports）；其他语言仅标记已发现 manifest。`declaredEntries` 与 `entryCandidates` 分开，后者仅依据文件名约定，不代表已确认架构。地图不扫描源码正文、符号或依赖图，不加载规则正文、登记文件写观察、提升权限或证明验证成功；地图作用域也不会登记到下一步规则加载路径。编辑仍须 read_file。

枚举最多 5 秒、2 MiB、10,000 路径；最多解析 32 份 manifest，每份 256 KiB、合计 1 MiB；JSON 结果最多 32 KiB。达到上限、文件期间变化或损坏 manifest 时返回 `incomplete`、明确 `reasons` 和缩小目录提示；不把不完整地图当作全部结构。不熟悉项目时可先地图、再搜索与读取；简单任务无须强制扫描。回归见 [project map](../../tests/unit/tools/project-map.test.ts) 与 [共享生产链路](../../tests/unit/runtime/project-editing.test.ts)。

## 按路径项目规则

`ProjectRuleSnapshot` 包含工作区根到已访问目标目录的 `AGENTS.md` 链、相对 scope、原始内容指纹、scope revision 和加载诊断，同时提取根 `package.json` 的开发脚本信息。

每个逻辑 step 读取根和本轮已访问路径的规则；普通网络重试复用当前快照。文件创建也检查目标父级规则。结构化编辑前加载目标的最新规则，发现模型尚未收到的 scope 或 revision 时返回 `rules_refresh_required`，到下一采样边界重新提供后才允许重试。

规则文件单项上限 128 KiB，总量上限 256 KiB，manifest 上限 256 KiB。不可读、越界、超限都保留诊断，不能静默声称已读全规则。

规则更新通过既有 context 渠道持久化；每次请求以当前有效快照替代历史版本，压缩过滤过时的 snapshot。恢复 Session 后从当前工作区重新读取。项目规则不会提升权限或覆盖更高优先级指令。

README、HANDOFF 等按任务需要读取；规则链并不意味着自动装入所有项目文档。修改规则语义时同时覆盖新增目录、规则删除、审批前更新及压缩后的恢复回归。

## 可遍历搜索与工具输出

`glob_files`、`search_files` 惰性解析 `@vscode/ripgrep@1.18.0` 当前平台 optional package 的绝对可执行路径，再使用含 `--no-config` 的参数数组启动，不拼接 shell，也不查询系统 `PATH`；Composer 文件候选和诊断 probe 复用同一 resolver。路径限定当前工作区，遵守 rg ignore 规则；包含 hidden 文件不等于忽略 `.gitignore`。搜索默认 fixed string，只有显式 `regex` 才启用正则。

当前依赖发布 Windows x64/arm64/ia32、macOS x64/arm64，以及 Linux x64/arm64/arm/ia32/ppc64/riscv64/s390x 二进制。安装时禁用 optional dependencies、缺少匹配包或使用其他平台/架构时，resolver 返回包含平台信息的 unavailable 错误；文件搜索、`@` 候选和 doctor 不回退到用户安装的 `rg`。CI 不再单独安装系统 ripgrep；resolver 回归覆盖成功、恶意 config 隔离和缺包错误。

| 范围 | 当前上限/行为 |
|---|---|
| 搜索页 | 默认 100 项，最大 200 项 |
| 单次搜索收集 | 最多 5 秒、2 MiB，已完成行与未终止记录共同计入 |
| 后续页面 | `read_search_results` 使用 opaque continuation |
| 搜索续读保留 | 最多 16 个搜索、序列化 UTF-8 payload 合计 8 MiB |
| 模型单项工具结果 | 默认最多 32 KiB，保持有效 JSON envelope |
| 大结果存储 | 每 Session 持久化最近 16 项，每项保留脱敏正文前 2 MiB |
| 工具结果续读页 | `read_tool_output` 最多 24 KiB，按 UTF-8 边界切片 |

`has_more` 只表示还有已保留页面；`incomplete` 表示搜索达到时间/字节限制，需缩小 query 才能继续获得未收集结果。两者不能混为“下一页会涵盖所有匹配”。每个 continuation 消费后生成下一引用，最后一页会立即释放对应搜索；数量或 UTF-8 字节超限时按创建顺序淘汰最旧搜索并使其所有引用过期。未知/已消费/已淘汰引用都要求重新搜索，Session 恢复与 Agent dispose 不保留引用内容。

上述搜索 continuation 与持久 `read_tool_output` 引用不同。附件续页读取 v1 文件的目标范围，不必每页加载整份保留正文；最多 256 项的进程内输出定位缓存仍逐次核验日志身份和真实 call/result 来源。缓存及并发改写检查见 [STATE_AND_UI](STATE_AND_UI.md#模型历史与输出附件恢复)。

搜索结果行列来自 ripgrep，其中 column 是字节偏移加一；LSP column 则是 UTF-16 位置，中文行中不能直接等同。

搜索和项目地图枚举通过 [process-completion](../../src/tools/process-completion.ts) 保持子进程所有权。传输错误、取消或期限到达后，必须等待 child close 和已请求的单次进程树终止；typed ProcessCleanupError 优先于普通取消，不能变成可继续采样的工具反馈。达到输出／路径保留上限后停止收集并排空后续输出，原有期限仍会请求终止；短命生产者自然退出不再触发多余 taskkill。期限已经耗尽的地图不启动枚举。受控生命周期及实际 Agent 结果配对见 [read process lifecycle](../../tests/unit/tools/read-process-lifecycle.test.ts)。

大输出返回 `status: truncated`、`output_id`、首尾预览、原始/保留字节数和续读入口，不能直接截断原 JSON。超过保留上限的内容明确 `retention_truncated`，此时也不能宣称续读可取回全部正文。引用对应 Session 目录内的脱敏输出附件，模型不接收宿主路径；提交、读取、淘汰、清理和删除在 Session 跨进程事务锁内协调；压缩、Agent dispose 和重启不删除已提交附件。`read_tool_output` 的可选 `session_id` 默认当前会话，跨会话读取重新校验完全相同的规范化工作区；淘汰、删除或旧进程内正文明确不可用。正文先脱敏再截断、保存和分页，offset 以脱敏 UTF-8 字节计算；容不下一个完整字符的页明确返回范围错误。

终端展示与模型上下文限制分离；模型结果压缩不能悄悄缩小已有 `/outputs` 或 scrollback 的保留语义。命令输出实现还需查看 [command-record](../../src/tools/command-record.ts) 和 [bash-output-preview](../../src/tools/bash-output-preview.ts)。

## 模型历史检索

`session_search(query)` 在标题和可检索正文中发现同工作区旧会话；查询采用脱敏后、去除首尾空白的不区分大小写字面量匹配，非空且最多 1,024 个字符。`session_event_search(query, session_id?)` 搜索指定会话，默认当前会话；`session_event_read(event_id, session_id?, offset_bytes?, max_bytes?)` 按引用分页读取，最多 24 KiB。`session_relations(session_id?)` 返回目标会话的直接 parent/children；默认当前会话，仍只允许完全相同工作区，并与其他历史查询共享 50 项、30 秒、64 MiB 扫描上限。父记录被删除、替换或短于分支边界时关系仍以 `available: false` 返回；子关系必须重新验证 lineage/header/boundary，不能靠 Session ID 字符串推断。

这些工具是普通 coding 与 Plan 的只读能力，与 learned Memory 开关独立，不自动注入整段历史。`session_event_read` 分页读取稳定的日志正文；大结果历史条目同时给出 `output_id`，保留正文继续通过 `read_tool_output` 读取。历史正文页最多 24 KiB，完整 JSON 结果最多 32 KiB；遇转义或元数据扩张时缩小正文页，并使用实际字节 continuation。

投影来自原始 `context_append` 的用户/助手文本、工具调用及结果，并搜索仍保留的输出附件。reasoning、加密内容、developer 规则快照、Memory 结果、历史检索与续读工具自身结果不进入投影；用户直接 `!` 的 timeline 不进入模型历史。每条历史都标记来源和时间；不能恢复文件观察、审批、Goal 完成或验证成功事实。

当前会话读取边界在每个逻辑 step 固定且由普通网络重试复用；旧会话在查询开始固定文件边界。引用绑定 Session、JSONL 字节位置、条目序号和内容摘要，追加不使引用失效，删除或改写则不可用。工作区规范化兼容 Windows 盘符大小写和分隔符，但不扩大到父子目录或符号链接别名。

检索采用有界流式扫描，不建数据库、不迁移旧日志。最多 50 条命中、16 KiB 返回、30 秒和 64 MiB 扫描量，单条日志缓冲最多 8 MiB；达到限制或遇损坏记录明确 `incomplete` 并要求缩小查询。

同一 runtime 还向宿主提供内部批量 tool-result 解析，用于压力裁剪而不向模型增加另一项工具。它只在当前 step 固定 EOF 内接受 call ID、原工具名和脱敏 inline 正文 SHA-256；只有这个三元组在完整扫描中恰好对应一个有效 call/output 配对，才返回绑定 Session/日志位置的 `session_event_read` 引用。之后复用同一个 call ID 但正文摘要不同，不会让已经唯一的三元组失效；相同三元组重复、来源歧义、日志损坏、记录或扫描限制都会使候选跳过。Memory、历史/关系查询及 `read_tool_output` 结果继续排除，不能凭相似文本制造恢复引用。

## 工作区变更审阅

`/diff` 和模型的 `list_workspace_changes` / `read_workspace_change` 共用只读服务；既有 `workspace_status` / `workspace_diff` 契约保持兼容。列表从 `git status --porcelain=v1 -z` 构建，分别保留 staged、unstaged 和 untracked 条目；同一路径同时有两种 tracked 状态时会出现两项。Git 路径先按仓库根解释，再映射到当前活动工作区，仓库子目录之外的路径不进入列表。

详情按选择惰性读取。tracked 文本使用禁用 external diff、text conversion 和 rename detection 的 unified diff；untracked 普通 UTF-8 文件显示有界正文预览。二进制、非法 UTF-8、符号链接、submodule 和非普通文件显示明确摘要。列表最多 2 MiB/10,000 项；详情最多保留前 2 MiB 或 10,000 行，并在界面显示截断。

模型列表创建进程内快照和 opaque 引用，详情页只在同一快照内续读；刷新会创建新快照，过期引用要求重新 list。模型大结果仍使用既有 `read_tool_output` 续读边界。审阅结果不进入文件观察表、不授予更新权限，也不证明变更归 Agent 所有；编码说明要求在总结前检查完整变更。人工界面用 `R` 刷新当前列表或详情，`Esc` 按详情 → 列表 → 聊天返回；异步操作可取消，关闭后的迟到结果被忽略。界面显示持久工作流中的 “Last task result”。

## 模型 shell 与后台任务

模型 `bash` 使用固定原生后端，不能在 sandbox 启动失败后回退宿主执行。shell 网络和公共 web 开关分别管理，审批与命令规则必须在每次执行时检查。用户主动输入的 `!` 是另一条 PTY 路径，不代表模型 shell 也有宿主权限。

`start_background`、`poll_background`、`stop_background` 复用模型 shell 的权限及执行器：最多两个运行任务，每项默认十分钟，没有交互 stdin。启动立即绑定 coding task 的 AbortSignal，poll 返回运行首尾预览和终态结果。

[BackgroundJobManager](../../src/tools/background-jobs.ts) 在调用执行器之前登记占位与完成 promise，重入启动也受同一个限额约束。预先取消不调用执行器；同步启动抛错与异步拒绝都保留一个失败 job，沿用 poll 与完成通知，不自动重试。结果、终态与完成时间在同一次结算中发布，解绑父信号后通知观察者；观察者异常不改变任务结果。运行和取消清理期间的预览继续保留，终态后忽略迟到输出，快照不共享内部结果或预览数组。

stop、waitAll 和 stopAll 等待已登记任务的完成 promise。cleanupFailed 或 typed ProcessCleanupError 永久保留在管理器中，终态优先为 failed；输出淘汰、取消和重复 dispose 不能清掉这个故障。全部 worker 收束后等待／清理方法仍抛出该错误，新 start 关闭准入。stopAll 期间的新 start 返回 `BACKGROUND_CLEANUP`；重叠清理全部完成后才恢复准入。dispose 立即永久关闭启动，重复调用共用清理 promise；之后 start 返回 `BACKGROUND_DISPOSED`。等待中的取消也必须先等 worker 结束，空任务列表仍尊重已取消的信号。管理器等待既有执行器的结束边界，进程树停止仍由 Bash／原生后端实现负责。生命周期及 Agent／runner 配对证据见 [管理器回归](../../tests/unit/tools/background-jobs.test.ts)、[Agent 回归](../../tests/unit/agent/react-agent.test.ts) 和 [runner 回归](../../tests/unit/workflow/task-runner.test.ts)。

前台 timeout JSON 与后台终态 result 都增加 `COMMAND_TIMEOUT` 和修正提示，保留 stdout/stderr 与原超时字段；提示先检查部分输出及已产生的副作用，不盲目重放。后台数量／通知积压上限提供 `BACKGROUND_LIMIT`，旧 job ID 明确 `BACKGROUND_JOB_UNAVAILABLE`；搜索过期 continuation 提供 `SEARCH_CONTINUATION_EXPIRED`。这些提示不增加自动 retry、审批或模型请求，取消、持久失败和预算停止保持原有收束顺序。

完成 callback 只向当前 coding task 报告 job ID、终态、退出码和时间，不携带命令或输出。通知在下一普通 Agent step 持久化并送入 context，模型仍用 poll 取得输出；它不会主动唤醒 Session。运行 job 与尚未送达的完成通知共用 20 个 task-local 槽位，满时新的 start 返回可操作的 backlog 错误，通知成功落盘后才释放槽位。

完成任务保留受数量和输出字节约束，最多 20 项、总终态输出 4 MiB；旧任务可被淘汰。job ID 是进程内状态，恢复 Session 不能假装恢复旧进程。

取消先关闭通知准入，再终止并等待进程树；预算停止、异常、权限收紧和退出应用采用相同收束边界。任务结束丢弃未送达通知并忽略迟到 callback。最终验证前 runner 等待所有后台命令收束，清理未结束不能开始新的编码任务。shell 进程树停止与退出等待位于 [process-completion](../../src/tools/process-completion.ts)。Agent、runner 和 workflow 在资源故障后关闭后续工具、请求、手工验证及 undo；任务结算先等全部后台清理，保留故障优先于取消，拒绝 Goal 和成功 Memory。workflow 仅保存固定的未验证原因及债务，不保存清理错误正文；恢复后空改动不能擦掉债务。生产 handle 的重复 dispose 共用同一 promise，也保留拒绝结果。

等待和取消不是只改 UI 标签：测试必须验证实际任务结束，特别是采样中取消后不能残留写文件进程。原生 Windows Terminal 的端到端证据与 hosted CI 的跳过范围单独记录在 HANDOFF。

## 可选 TypeScript 导航

显式配置 `EVERPEACE_TYPESCRIPT_LSP` 才暴露 `code_navigation`；`EVERPEACE_TYPESCRIPT_LSP_ARGS` 为 JSON 字符串数组，默认 `--stdio`。语言服务器可执行文件目录自动加入只读根，额外 SDK/依赖源码根使用 `EVERPEACE_TYPESCRIPT_LSP_READ_ROOTS` 的 JSON 字符串数组声明。不下载或自动安装服务器；可用性和隔离错误由 `/doctor` 与工具结果展示，缺失时仍可使用 lexical search。

支持 definition、references、implementation、hover。输入位置为一基 UTF-16 行列；查询按工作区串行，每次读取当前目标文档、启动服务器并 `didOpen`，请求结束后 `didClose` 和关闭进程。因此文件修改后下次查询读取新内容，不依赖旧编辑器缓冲。

单次请求上限 30 秒，文档上限 16 MiB，位置最多 100 项，hover 文本最多 64 KiB，并在完整 UTF-8 字符边界截断。JSON-RPC header 最多 8 KiB，单 frame 最多 2 MiB，单查询总入站流量最多 8 MiB，stderr 只保留前 64 KiB。输入的 UTF-16 位置先对当前文本验证；初始化必须支持请求操作、UTF-16 编码与临时文档 open/close 同步。目标和返回位置都同时检查原始路径与 realpath，拒绝工作区外及策略保护的控制目录/应用状态路径。

宿主拒绝所有 server 发起的请求，包括 applyEdit 和 executeCommand。导航结果不写入文件观察记录，不授权随后 patch；修改前仍需 `read_file`。

每次查询通过 pinned Codex backend 的 duplex 接口直接启动 executable/argv，不经过 shell wrapper，也不回退宿主执行。专用 `:read-only` 子策略拒绝 workspace 写入与应用全局状态，并请求 native network denial；该隔离不受用户选择 full access 影响。配置的 language server 启动前，宿主先用同一监听目标完成宿主连接正对照，再在相同策略中运行直接 socket 探针。只有明确的 `EACCES`/`EPERM` 才记为 denied；连接成功记为 allowed，拒绝连接、超时、无效输出或清理失败记为 inconclusive。只有 denied 可继续，其余均返回 unavailable。证据仅描述本次 TCP/IPv4 及 loopback/non-loopback 目标，不证明其他网络协议或地址都被隔离。传输保持 raw stdout、处理 stdin backpressure、持续 drain 有界 stderr，并等待进程清理后才推进队列或结算成功。任务取消或权限 revision 变化会取消查询。

`:read-only` 的平台 ambient system read 与临时目录能力仍然存在；额外源码根用于明确记录所需依赖，并不表示其余 ambient reads 被移除。Windows 使用固定后端与 MXC 配置，原生 fixture 同时验证 workspace 写入、应用状态读取和直接 TCP 探针拒绝；真实 TypeScript server 四类查询已有证据，见 [HANDOFF](../HANDOFF.md)。Node promise realpath 的 EPERM 兼容适配仅在 sandbox 内的 LSP 子进程加载，仍真实解析 symlink 并遵守 OS 权限；临时 launcher 根只读、与工作区及保护状态分离，退出及清理结束后才推进队列。原生可用性仍逐平台验收，不能从 profile 名称推断；通用 registry 和进程池尚未启用。

duplex 的重复 terminate 共用同一清理 promise，不使用固定延时冒充进程退出。普通传输错误与成功资源清理分开报告，真正清理失败始终保留为 ProcessCleanupError。RPC 关闭先发送 stdin EOF，短暂等待自然退出后才请求强制终止；这个期限仅触发清理，不能提前结算。查询或隔离探针的清理失败永久关闭当前 navigation runtime 的准入，已排队查询也不能启动替代 server；隔离证据保留 inconclusive/probe_cleanup_failed。回归见 [duplex lifecycle](../../tests/unit/codex/process-lifecycle.test.ts)、[navigation](../../tests/unit/tools/code-navigation.test.ts) 和 [Agent settlement](../../tests/unit/workflow/cleanup-settlement.test.ts)。

## 外部工具与修改检查表

公共 `web_search` / `web_fetch` 为普通 function calls；请求失败返回工具结果。fetch 每次重定向都检查公共 HTTP/HTTPS 边界，禁止 localhost、内网和链路本地；返回正文始终是不可信数据。

MCP 和 Skills 已实现，不在本文重复配置细节；参见 [CODEX_CAPABILITIES](CODEX_CAPABILITIES.md)。MCP annotations 不能自动授予本地并发资格，Skill 名称冲突必须从目录和按名读取中排除。

完成工具改动前，检查四个方向：参数/路径边界、取消和审批后的权限复查、结果配对与持久化失败、最终变更追踪与验证。对应单测通过后按根 guide 执行交付门禁，并在 HANDOFF 区分自动化已验证与真实模型/终端尚未验收的范围。
