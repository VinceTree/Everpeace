# 状态、持久化与终端交互

`/privacy`、无模型隐私 CLI、跨进程活动租约、安全导出及 `/perf` 的持久/兼容契约见 [验证、隐私与性能](VALIDATION_PRIVACY_PERFORMANCE.md)。默认保留永久；旧 Session 缺少解释字段和安全关闭证据时不推断成功或自动删除。

这份文档回答“状态归谁所有、哪些内容可以恢复、UI 修改必须守住什么”。先按 [项目路由表](PROJECT_MAP.md) 找到入口；只有修改对应行为时才读取相关源码和测试。当前交付证据、环境限制和待办见 [HANDOFF](../HANDOFF.md)。

## 状态所有权

| 状态 | 所有者与存储 | 不得混入的内容 |
| --- | --- | --- |
| API Key | [AuthStorage](../../src/storage/auth-storage.ts) 与系统 keyring | models JSON、Session、日志、UI、测试快照 |
| 模型注册 | [ModelRegistry](../../src/storage/model-registry.ts)，平台配置中的 `models.json` | 明文 Key；只保存 `auth_ref` |
| 对话、context、主请求 usage | [SessionStore](../../src/storage/session-store.ts)，每 Session 一个 JSONL | 从历史恢复的权限授权 |
| 当前视图、审批与运行显示 | [TUI App](../../src/tui/app/app.tsx) 及依赖；模式和活动任务显示是协调状态的投影 | 临时命令窗口不能变为聊天历史 |
| 当前 Session 身份、模式、模型任务准入／取消及命令操作身份 | [ApplicationCoordinator](../../src/runtime/application-coordinator.ts)，TUI 每次挂载一个实例 | 持久事实、UI 组件、第二套 runner 或资源清理循环 |
| 已批准待执行计划 | 当前协调实例内，绑定 Session 与 Agent，正文按值返回 | JSONL、恢复后的执行授权、文件审批或验证成功 |
| coding 结果与验证债务 | [workflow runtime](../../src/workflow/runtime.ts)，Session 只保存元数据 | 验证 stdout/stderr/error、文件检查点 |
| 当前 coding 执行清单 | [TaskProgress](../../src/workflow/task-progress.ts)，Session 保存最新整体投影 | 验证成功、Goal 完成或权限授权 |
| Goal | [GoalRuntime](../../src/goal/runtime.ts)，Session 绑定 | 无宿主验证的编码完成状态 |
| Learned memory | [LearnedMemoryRuntime/Store](../../src/memory/learned-memory.ts)，独立平台目录 | 原始凭据、未经验证的成功事实 |
| 权限 | [PermissionPolicy](../../src/permissions/policy.ts)，当前用户策略与项目限制交集 | JSONL 中历史授权、项目自提权 |
| 文件观察、undo、后台进程 | 当前进程内工具与 workflow runtime | 恢复后凭历史文本重新获得写权限或假装进程仍活着 |
| 大工具输出附件 | [SessionOutputStorage](../../src/storage/session-outputs.ts)，Session 目录内每会话的脱敏附件、opaque ID | 模型可见宿主路径、超出保留范围的正文、恢复写权限 |
| Session lineage / 分支待继续 | [SessionStore](../../src/storage/session-store.ts) 的 header 与 additive 事件 | 父 Session 的运行中状态、旧 Goal、审批、undo、观察版本或验证成功证据 |
| Session 搜索投影、最近 coding 请求快照 | [SessionStore](../../src/storage/session-store.ts)、当前 [ReactAgent](../../src/agent/react-agent.ts) 的进程内缓存 | 持久索引、JSONL schema、重启后猜测请求快照 |

模型 `model_name` 保留服务端原始 ID；应用内部注册 `id` 不等于模型名称。可选 `request_settings` 同时存在于模型注册和 Session 模型引用中，旧记录使用供应商默认设置。切换设置在任务边界应用，不能在同一任务内悄悄改变请求预算。

## 存储位置与凭据

模型注册可增量保存 `responses_profile`，旧字段缺失等同 auto。`/model profile` 在空闲命令操作内更新，绑定原注册 ID/地址/原始模型 ID；清除旧请求设置、重建 Agent 并使批准失效，兼容 context 和累计 unknown 仍保留。opaque context 与目标协议不兼容时拒绝修改。Session 保存选择时的 profile；恢复时以当前注册为准，profile 不同时不重用旧 request settings。`/status` 显示实际 profile、official/configured 来源及 wire reasoning，不把用户配置记为实测能力。回归见 [注册](../../tests/unit/storage/model-registry.test.ts) 与 [App](../../tests/unit/tui/app.test.tsx)。

- Windows：配置、Session 等默认位于 `%APPDATA%/Everpeace/`，Session 子目录为 `sessions/`。
- macOS：默认位于 `~/Library/Application Support/Everpeace/`。
- Linux：模型配置使用 `$XDG_CONFIG_HOME/everpeace/`（默认 `~/.config/everpeace/`）；Session 使用 `$XDG_STATE_HOME/everpeace/sessions/`（默认 `~/.local/state/everpeace/sessions/`）。
- 系统 keyring 不可用时报告故障，不降级为明文 Key 文件；注册表只用 `auth_ref` 关联凭据。
- 普通输入历史由 [InputHistory](../../src/storage/input-history.ts) 单独保存，不能记录登录向导的凭据字段。

这些是默认路径，测试应注入临时目录与 AuthStorage 替身，不依赖真实用户的凭据或 Session。

## JSONL 契约

每个 Session 使用带格式字段的逐行事件文件，同一文件追加通过本实例队列和 `proper-lockfile` 跨进程 Session 锁串行化；附件提交、续读、淘汰、启动清理与删除复用该事务锁，另一实例不能把尚未追加引用的附件清理为孤儿。`timeline` 是人看到的历史，`context` 是发给 Responses 的输入；两者独立恢复，不能互相推导。

`load`、`list` 与 `/resume` 搜索共用字节流记录读取器，在打开日志时固定 EOF，按 64 KiB 文件块逐条解析，不再同时保留整份原始文本、拆行数组和事件数组。`list` 只累积摘要所需状态；`load` 仍须保留最终 timeline 与有效 context，因此这不表示整个 Session 的内存恒定。重放不会新增拒绝超过 8 MiB 合法旧记录的限制；单条记录仍完整解析，旧 JSONL 与未终止末行的判定保持一致。模型历史工具自身的单行扫描上限保持独立。

| 事件 | 含义 |
| --- | --- |
| `session_created` | Session ID、标题、工作目录、无凭据模型引用、标题待生成、usage 跟踪标记，以及分支时的可选 lineage |
| `title_updated` | 修改标题并清除待生成标记 |
| `timeline_entry` | 用户/助手/工具/输出等可见记录；兼容旧 status 快照 |
| `context_append` | 追加模型交互项，保持工具调用与结果配对；大结果可附带可选 `tool_output_attachment` 引用 |
| `context_compacted` | 替换有效 context，保留是否自动压缩标记及 usage；不改写可见历史 |
| `context_pruned` | 在 provider 压缩前以可恢复引用替换早期工具正文；先落盘再替换有效 context，只把当前 `context_tokens` 设为 unknown，累计 usage 不变 |
| `model_selected` | 模型引用及是否保留 context |
| `usage_recorded` | 主请求的 usage 或明确 unknown |
| `goal_updated` | Session Goal 状态、预算及已用量 |
| `workflow_updated` | 修改路径、任务来源、验证债务、检查状态与文件 revision 等元数据 |
| `task_progress_updated` | model-authored coding 清单的完整替换投影；空列表表示明确清除 |
| `memory_policy_updated` | 当前聊天的 `readExisting` 与 `captureFuture` |
| `fork_boundary` | 新子 Session 的父 ID、固定源 EOF/header 摘要、继承后的 workflow/TaskProgress/Memory policy 与待继续状态 |
| `fork_resume_updated` | 持久更新子 Session 是否仍需用恢复语义继续 coding |

`workflow_updated` 序列化会清空验证输出并去掉错误正文；这不代表普通 `timeline/context` 不保存用户消息或工具交互。不要将新的请求正文、文件快照或凭据塞入诊断元数据。压缩内容继续使用既有 context 通道。

旧记录缺少 `title_pending` 按 false；缺少 usage、workflow 或新字段不能补推“统计完整”“已验证”。只允许忽略损坏且没有换行终止的最后一行，其余 JSONL 错误按文件隔离，列表跳过坏文件而不是吞掉中间事件。追加及当前 step 捕获 EOF 前，在 Session 锁内有界恢复尾部：完整有效的旧无 LF 事件补换行并保留原字节，未完成或无效尾部截回上一完整行；超过 8 MiB 无法判定时保留原文件并停止写入。旧条目的字节位置及摘要保持不变。持久化失败走 `PersistenceError`，不能当网络错误重试模型或继续成功结算。

## 创建、切换与恢复

| 操作 | 固定语义 |
| --- | --- |
| 第一条普通消息 | 先创建 Session，再请求模型与追加记录 |
| `/new` | 必须已有模型；立即进入标题为 `New Session`、`title_pending: true` 的空 Session |
| 第一条新 Session 问题 | 先生成可靠回退标题，再异步命名；不能阻塞回答 |
| `/clear` | 清屏并解除当前 Session，保留模型；下一条普通消息才创建新 Session |
| `/resume [query]` | 默认搜索当前工作区，可明确切换全部工作区；预览后仍通过原恢复路径加载 timeline、context、模型、工作目录、Goal、workflow、TaskProgress 和聊天 Memory 策略，继续原文件 |
| `/fork [title]` | 仅当前本地 Session 完全空闲且源模型仍可用时固定已提交 EOF，生成独立子副本，成功发布后切换；失败或取消保持父会话 |
| 模型切换 | 保留累计 usage，重置或标记未知的新模型 context 占用 |
| Session 删除 | 使用选择/确认流程，同时清理所属输出附件；任务或直接命令运行期间不得删除 |

恢复前先检查工作目录；目录不存在时保持当前会话不变。原模型缺失可选择替代，但含供应商专属加密/不透明 context 时不得跨供应商静默迁移。旧“新 Session”标题只在显示层翻译。

恢复后重新读取项目规则与文件观察；权限读取当前配置，不从 JSONL 复活。`session_resume` 和 Goal 自动续跑必须保留修复计数与未验证债务，不能通过新的 `no_changes` 清除失败。后台命令和进程内 undo 检查点不可恢复。

`session_resume` 恢复最后一个有效 `task_progress_updated`；repair 与同一顶层任务里的 Goal continuation 复用投影，新的用户 coding task 则先持久化空清单。清单随每次请求重新提供，包括 context 压缩之后；它始终是进度说明，不能推导 workflow 或 Goal 结果。旧 Session 没有该事件时按“尚无清单”处理。

`SessionStore.search` 流式读取并校验 JSONL，只投影当前标题以及 user/assistant conversation message；tool output、模型 context 和 learned Memory 不参与匹配。匹配采用不区分大小写的字面量比较，每个 Session 只返回一项，按最新活动时间排序，并提供命中片段及最多三条本地对话预览。每页最多 50 项，界面显示八行；输入有 200ms debounce，新的 query/scope/page 会取消旧搜索并忽略迟到结果。

搜索投影只存在进程内，采用 16 MiB LRU 上限；Session 追加和删除使对应条目失效，读取后再次核对文件元数据，避免缓存并发变化。冷读和缓存命中的返回 summary 都深度复制，调用方可以修改自己的快照，但不能改写缓存中的标题、模型设置、Goal、workflow 债务、TaskProgress、Memory policy 或 lineage。match 与 preview 按值生成；复制不增加日志扫描，后续搜索仍从内部投影匹配。搜索不创建持久索引或 schema migration；损坏 Session 单独跳过，未完成末行沿用现有兼容规则。删除仍使用原确认流程和 Session 写队列，搜索结果不改变恢复语义。

### Session 分支

`SessionStore.fork` 在父 Session 队列与跨进程事务锁中固定源 EOF，流式校验并复制 timeline、原始 context append、已有 compaction/pruning context 和模型选择事件。它把父会话最近最多 16 份仍保留的附件复制到隐藏 staging，保留原 `output_id`，但子目录独立拥有正文；父子之后的追加、淘汰和删除互不影响。附件准备完成后先发布子输出目录，最后原子 rename 子 JSONL，使列表和 `/resume` 看不到半成品。失败或取消清理 staging；启动 orphan 清理会识别仍持锁的分支事务。

子 Session 生成新 ID 和 task ID，usage 清零并清除 Goal、repair 次数、审批、undo、文件观察和此前验证成功证据。模型及请求设置、聊天 Memory policy、timeline/context、相关 changed paths 与未验证债务被继承；TaskProgress 带 `inherited_from_session_id` 标记。lineage 绑定父 ID、fork 时间、源 header SHA-256 和源 EOF，父记录后续追加不改变该边界。`session_relations` 只返回同工作区直接父子，并重新核验这些字段；父被删除或替换后，子仍可用且父关系显示 `available: false`。复制过程不改写正文中已有的父历史引用；在子 Session 重新查询历史时生成绑定子日志位置的新引用，旧父引用在父删除后按原作用域失效。

新子会话持久保存 `fork_pending_resume`。首个及未结算后的普通 coding 输入以 `session_resume` 来源进入 runner，保留继承的清单和验证债务；只有任务完成且宿主结果为 `verified` 或 `no_changes` 后，才先持久清除此标记。Plan、查看命令、取消、异常、限制停止、failed/unverified 结果都不消耗它。分支会清除 Goal，恢复子会话也不会据此自动续跑父 Goal。

## 模型历史与输出附件恢复

模型历史通过原始 `context_append` 建立只读、按需投影，与 `/resume` 的对话搜索和有效 context 恢复分开。`session_search`、`session_event_search`、`session_event_read` 和 `session_relations` 只允许完全相同的规范化工作区，兼容 Windows 盘符和分隔符，但不将父子目录或符号链接别名视为同一工作区。当前会话在逻辑 step 开始固定已落盘边界，普通网络重试复用；旧会话查询在开始时固定边界。引用绑定 Session、日志字节位置、条目序号和内容摘要，追加后仍有效，删除或改写后不可用。遇损坏记录的检索标记 `incomplete`，不改变正常 Session 恢复的损坏隔离契约。

大结果附件每 Session 最多 16 份，每份保留脱敏正文前 2 MiB；JSONL 继续保存最多 32 KiB 的有效预览 envelope。按模型调用顺序执行附件写入、结果引用追加和旧附件淘汰，准备中的有界正文计入并发背压。附件或日志写入失败进入 `PersistenceError`；启动清理未被日志引用的崩溃遗留附件。Agent dispose 仅释放内存，压缩和重启继续复用原 `output_id`。旧进程内引用不能重建正文，明确返回不可用。

附件沿用 v1 文件格式，续页只读取有界 header、目标范围和 UTF-8 对齐余量，并在读取前后核验文件身份、长度和修改信息。`SessionHistoryRuntime` 最多缓存 256 个输出定位 metadata，按最近使用顺序淘汰；缓存键包含规范化工作区、Session 和 output ID，条目绑定日志文件身份、header 摘要及 call/result 位置与摘要，不保存正文。每次命中仍在固定 EOF 下重读结果并核对 call→result 来源区间；读取期间日志变化时再次核验。追加保持有效，删除、替换、改写、来源冲突或损坏使当前读取失败并移除定位。缓存只减少重新发现位置的扫描，不改变工作区、来源、取消或扫描预算约束。

`read_tool_output` 与历史分页的正文最多 24 KiB；`session_event_read` 的完整序列化结果同时限制为 32 KiB，必要时缩小正文页以容纳 JSON 转义和来源元数据，返回实际 continuation。脱敏先于保存、搜索、裁剪和分页，保留正文的换行、缩进和 CRLF。offset 使用脱敏 UTF-8 字节；极小页不能容纳一个字符时返回范围错误。所有历史内容都标记为来源明确的不可信资料，不恢复观察版本、权限、审批、Goal 完成状态或当前验证证据。

## Usage、Goal 与 Memory

- [model-status](../../src/status/model-status.ts) 分别累计 input、output、reasoning、cache hit 与 cache write；reasoning 不重复加到已经包含它的 output 上。
- 缺失 usage 或缓存字段保留不完整状态，后来的完整样本不能掩盖缺口。缓存命中率仅用有对应统计的输入作分母；context 占用和累计消费不同，压缩后占用设为未知。
- 主 coding/压缩 usage 随 Session 保存；手动压缩也计入 active Goal，预算或 usage 停止时 `/compact` 显示明确原因，Esc 返回同一 Session。标题、Skill、Memory、doctor 的辅助请求通过共享 executor 计量，`/status` 分栏显示。独立操作的准入账本与持续 incomplete 的累计显示分离；同一 Memory job 的提取/合并在 runtime 与辅助服务之间共享实际请求 scope；准入前拒绝不产生 unknown，取消保留可靠返回的用量，旧故障不重复计量，资源故障关闭整个辅助所有者。当前辅助总数由 TUI dependency 实例持有，不伪称为恢复后的完整历史辅助账目。
- Goal 仅按用户明确意图建立，预算仅在明确指定时设置。`paused`、`blocked`、`complete` 与预算/usage 停止各有独立语义；停止条件不得被 UI 的“本轮结束”覆盖。GoalRuntime 保留已有 usage 缺口，运行时重建或后来的可靠样本不能将其改回完整。
- 编码完成意图先暂存，由 [CodingTaskRunner](../../src/workflow/task-runner.ts) 在完整、未过期验证通过并再次检查取消后结算。取消、预算停止、无检查和修复耗尽均不提交成功 Memory。
- 新指令可开启新任务预算，但旧未验证事实仍须保留；Goal 续跑不构成新任务授权。
- Plan 审批、宿主验证、修复和 Goal 续跑属于同一前台任务，Memory 后台请求持续暂停；整项任务最终退出或 runtime 重建后重新计满五分钟。失败、取消、受限停止、无改动和 Plan 退出仍恢复先前可靠队列，不把本次助手声明作为新学习。
- Memory 是不可信背景，低于用户指令和项目规则；全局开关控制 learned Memory 读写，聊天策略随 Session 恢复，均不控制只读 Session 历史检索。成功学习、明确长期偏好、候选审核及后台队列的完整边界见 [MEMORY](MEMORY.md)。

## Plan 审阅与显式执行

`/plan` 和 `/plan <request>` 保持严格只读。审阅菜单为 `Approve plan / Revise plan / Cancel plan`；修订输入要求非空意见，通过当前 `submit_plan` 的配对结果先落盘再继续采样。修订输入的 Esc 返回菜单，菜单的 Esc 取消规划，两处 Ctrl+C 均取消活动任务。预先 aborted 的 signal 不打开窗口，回调只结算一次，迟到决定不能复活批准。

批准后等待 runner 完成清理，由协调实例校验任务、Session 与 Agent 身份后保存标题和完整正文，继续保持 Plan 模式并提示 `Plan approved. Run /plan execute to start.`。不新增 Session event，不从历史推断批准。`/plan show` 只读查看进程内计划，不发模型请求；手动压缩不影响这份正文。`/plan execute` 的正文消费与任务准入同步完成，再通过包含完整正文的新 coding 输入启动共享 runner。消费后取消或失败不自动重试；计划批准不能代替 patch／shell 审批，也不恢复文件观察。

协调实例发出取消但保留活动任务，宿主等待 runner 清理后才释放准入。成功新建／恢复／清空／fork 调用会话替换，取消旧任务并推进身份；首次惰性创建只绑定当前任务，不替换它。会话或 Agent 已改变时，迟到任务结果不能发布批准或错误消息，也不能继续排队 guidance；尚未处理的输入返回草稿等待重交。初次创建在清空后才返回，也不能重新绑定旧会话。界面仍负责存储／目录切换及其失败处理，仅成功后提交协调身份，失败不会提前丢失原批准。相关回归见 [协调状态](../../tests/unit/runtime/application-coordinator.test.ts) 和 [App](../../tests/unit/tui/app.test.tsx)。

新讨论、带需求的 `/plan` 在任务启动前清除旧批准；`/plan exit`、成功新建／切换／清空／fork 会话和 Agent 替换均使批准失效。失败的会话操作保持原批准；重启／恢复不重建。Plan 的 queued guidance 不自动进入另一轮任务，结束时连同现有草稿返回输入区，等待用户再次提交；coding 的实时 steering 继续沿用现有路径。相关回归见 [Plan runtime](../../tests/unit/plan/runtime.test.ts)、[审阅组件](../../tests/unit/tui/plan-surface.test.tsx)、[App](../../tests/unit/tui/app.test.tsx) 与 [生产闭环](../../tests/unit/runtime/plan-execution.test.tsx)。

## 非交互 exec

[exec runtime](../../src/exec/runtime.ts) 不创建 Ink 组件。它通过 [production factory](../../src/runtime/production.ts) 取得与 TUI/benchmark 相同的 provider、历史/附件、Memory 读取、MCP、权限工具和请求账本，再用 `CodingTaskRunner` 完成后台收束、验证与修复。通过启动配置后建立可由 TUI `/resume` 打开的正常 Session；标题根据提示第一条非空行确定，聊天 Memory policy 固定为读取已有内容、关闭本次 capture。

CLI 提示词只能来自一个位置参数或非 TTY stdin。模型解析先匹配注册 ID，再匹配唯一 `model_name`；不指定时仅允许一个凭据可用模型。`--resume` 创建同工作区的独立子 Session 并保留验证债务，不能与 `--model` 组合；`--plan` 只读规划并输出提交正文，从不自动批准／执行。审批和必须回答的结构化问题保存标准 function output 后返回 `interaction_required`。SDK `runTask` 复用此路径，边界不变。可选 token budget、deadline 和 task step 上限覆盖 coding、压缩、重试及所有修复轮。SIGINT/SIGTERM、deadline、stdout/stderr 关闭或写入失败都先取消任务并等待 Agent/后台资源清理；输出失败返回 1，信号保留 130/143。只有输出可写且此前没有半条 JSONL 记录时才尝试发布终态，不能向不完整末行拼接一个伪完整的最终事件。

默认 stdout 只写最终 assistant 文本，stderr 写进度与宿主验证摘要。`--json` 通过 [exec-output](../../src/cli/exec-output.ts) 输出 schema version 1 JSONL：每行含 ISO 时间和白名单字段，可出现 `session_started`、`assistant_message`、`tool_started`、`tool_finished`、`workflow_updated`、`interaction_required`，并在任务清理后最多一次 `run_finished`。正文先整体去终端控制序列、脱敏，再分块转义写出；assistant 正文完整保留，其余事件连同换行最多 64 KiB，缩短预览时带 `truncated: true`。不导出 reasoning 正文、原始 provider response 或任意对象展开，usage 可以包含汇总 reasoning/cache 计数。退出码及用户调用格式见双语 README。

workflow 提供路径列表时同时返回 `changed_paths_total` 和 `changed_paths_returned`；后者始终等于实际交付数组长度。截断 `output`、`prompt` 或 `result_reason` 时给出对应的 `*_total_bytes`，计量完整去控制序列、脱敏后且限幅前的 UTF-8 正文。整行因 JSON 转义再次缩减时同步这些字段，保留 Session、身份、状态、usage 和停止原因。助手正文不走截断路径。

[exec-writer](../../src/cli/exec-writer.ts) 每次写入最多 16 KiB，并等待 callback 与必要的 drain；事件锁保证同一 JSONL frame 不被其他事件插入，编码缓冲/队列最多 1 MiB。该上限不包含 Agent 原本持有的正文或 Session context。单块 30 秒没有完成进展即中止输出并取消任务。Windows/Linux 非 TTY 标准流统一通过 CLI host 惰性创建的专用 Node writer 子进程输出；TTY 继续使用 Writable。固定子程序用可报告完成／错误的流写入，只有每块实际写入 callback 后才 IPC 确认，支持慢消费者；超时和取消由父进程控制。正常退出、取消或故障都等待待处理写入结算、代理流关闭与子进程退出，再移除宿主监听器；代理流还保留迟到错误处理，清理关闭不伪造任务取消。取消或故障可能留下半条 JSONL 末行，此时不补写终态；消费端必须同时检查退出码。

[真实子进程回归](../../tests/unit/cli/exec-process.test.ts) 通过 IPC 分别观察 provider 就绪、取消先于任务清理、输出清理完成；继续断言退出码、owned helper 回收、完整终态文件和半条输出无 final。Linux 使用实际 OS 信号，Windows 通过 IPC 触发安装的 signal handler；这不能替代真实 Windows Terminal Ctrl+C 验收。上一轮双平台 CI 失败与本轮实际验证结果只在 [HANDOFF](../HANDOFF.md) 维护。

代理 Writable 的 error 事件可能等异步 destroy 完成后才发出。CLI host 因此也在写入 Promise 失败边界立即通知输出失败、取消任务，不能仅等 stream error；原 error／close 监听器仍保留到完整清理后，取消必须先于 runtime 资源结算。

## Inline TUI 与独立命令窗口

详细目录职责见 [TUI_STRUCTURE](TUI_STRUCTURE.md)。界面始终 inline，使用终端原生 scrollback，不切换 alternate screen。主状态机拥有视图切换；展示组件不得自己创建 Agent、写 Session 或启动新任务。

- 宿主文案集中管理并支持中英文切换；模型正文、源码和第三方输出保持原文。状态仅投影协调器、权限、计量及清理事实，清理失败保留准入阻塞。Markdown、代码、shell 和严格 unified diff 分层高亮，超大或未知内容安全退回纯文本。
- 等待状态包含 provider、耗时与 Ctrl+C 提示；`/status` 显示模型、供应商、实际协议、压缩/推理设置、context 占用和累计 token/cache，缺失数据明确显示未知或不完整。
- `/status`、`/outputs`、`/history`、`/terminal-setup`、信息窗口及 picker/wizard 使用独立命令窗口；`/new`、`/clear`、`/exit` 是立即动作。
- `/fork` 使用可取消 loading/结果窗口；任务、审批、直接命令或其他 command load 活动时拒绝。只有子日志原子发布并加载成功后才重放并切换 UI。
- Composer 中 `@` 候选最多显示八项，Esc 只关闭候选；提交文件引用时异步读取，失败保留草稿。摘录只进入该 user context item，不复制进可见历史或标题请求。
- Composer 在调用提交回调前同步占用当前输入，防止 React 更新前的重复 Enter、输入、粘贴或回调重入。接收成功只清空仍属于同一挂载、同一提交和原 ComposerState 对象的草稿；宿主替换草稿或输入框卸载后，旧回调不得清空编辑状态、历史导航或修改新界面的提交显示。false、同步抛错和异步拒绝保留原草稿并释放当前输入，等待用户明确重交。该占用仅属于输入适配，不代替应用协调的任务准入、取消或 runner 清理。回归见 [提交生命周期](../../tests/unit/tui/prompt-submission.test.tsx) 和 [App](../../tests/unit/tui/app.test.tsx)。
- `/diff` 先显示 staged/unstaged/untracked 文件列表，Enter 惰性加载分页详情；Esc 从详情回列表、再回聊天。`/resume` 搜索和预览保持八行列表与 50 项分页，并提供当前/全部工作区开关。
- `/context` 展示当前 Agent 在已准入 provider-call 边界捕获的 “Last submitted coding request”。打开和刷新只读取不可变内存快照，不刷新文件、不压缩 context、也不发送模型请求；进程重启、Agent 替换或首次 coding 请求前显示明确空状态。
- `/tasks` 只读显示当前完整清单及最新宿主 workflow result；状态栏仅显示完成数/总数。界面不得把全部步骤 completed 渲染为验证成功。
- Plan 与 coding 共用结构化问题窗口。Plan 的 Esc 保持规划取消；coding 的 Esc 和 Ctrl+C 中止活动任务，触发相同的后台清理并恢复一个 prompt。迟到答案必须被忽略，已经 aborted 的 signal 不得打开窗口。
- 命令窗口隐藏 banner、历史、composer 与全局状态栏，进入时同步清屏，Esc 从内存原子重放原 Session。窗口本身不得写入 `Static`、timeline 或 context。
- 只有命令造成的真实变更进入对应状态存储。可取消加载使用操作身份检查，关闭窗口后忽略迟到结果。
- `/memory remember` 绑定命令取消信号；Esc 取消提取并返回同一 Session。迟到成功和失败都复核操作身份，不能重新打开 Memory 或错误窗口。服务关闭等待手动 Memory 的存储结束，并保留真实存储及清理错误；临时手动 runtime 不处理共享自动学习队列。
- 所有命令窗口共享居中布局，外框最多 80 列，窄屏有左右安全边距，字段左对齐；resize 后重新居中且不得泄露底层历史。
- `/` 前缀菜单最多显示八项，保留方向键选择、Enter 执行、Tab 补全和 Esc 关闭。
- resize 保留历史、单一 prompt 与输入的自动换行安全单元格；不得破坏滚轮或 Ctrl+滚轮缩放。
- 聊天 resize 才清屏并重放 Static 历史；命令窗口由 Ink 原位调整，不能再次清屏导致未变化的帧空白，修订草稿保持挂载。Markdown 按 stdout 共享一个列宽订阅，最后一个块卸载时释放；不提高监听器上限或屏蔽警告。

## 取消、Steering 与终端输出

- Ctrl+C 在任务活动时取消；空闲且有草稿时清空；空闲且无草稿时退出。
- 活动 coding turn 保留 guidance composer；支持 steering 的 Agent 即时记入可见 transcript，在采样/工具结果安全边界应用。未开始工具补 `steered` 结果；取消时仍保存已提交 guidance。不支持 steering 的替身保留 FIFO。
- 工具审批与 guidance 共用一个 composer 输入所有者：空草稿时 y 批准、n 或 Enter 拒绝，这些按键不进入草稿；有草稿时 y/n 是正文，Enter 只提交 guidance，不同时批准工具。修改权限后仍按当前 revision 拒绝旧审批。App 与 prompt-submission 回归验证按键归属。
- 取消、权限收紧、预算停止和异常都必须收束 task 拥有的后台进程树；清理完成前不能启动下一任务。最终检查期间也可取消，不能在取消后完成 Goal。
- Agent 和辅助服务 dispose 关闭准入，取消并等待活动 turn、手动压缩、手动 Memory、辅助请求及其持久化/计量；provider 已返回也不提前结束 Memory 存储的所有权。重复关闭共用完成结果，真实清理或存储故障不被普通取消替代。预取消不产生请求或 unknown 样本，迟到的可靠 usage 仍计量，迟到结果不报告成功。
- 用户直接 `!` 使用交互 PTY，由 Ink 单一 stdin 入口转发并独占输入；禁止同时注册原始 stdin 监听器。它由用户主动执行，不进模型 sandbox，也不进入模型 context，但可进入可恢复输出历史。
- 原始 PTY 控制序列不能直接写入 Ink stdout；保持清洗、流式显示与终端模式复位。
- SSE 可用时实时显示正文、审批与工具状态；否则显示 buffered 等待。只有实际 reasoning 事件才显示 Thinking，其耗时与整段请求耗时区分。
- 模型 shell 展示有界首五行/尾五行，随高度缩减；直接 `!` 优先最近五行。最终折叠与 `/outputs` 保留原始有界输出语义。
- 修改终端按键设置必须预览、明确确认和备份，不能静默覆盖用户配置。

## 修改入口与最低回归范围

| 修改类型 | 先读与必须考虑的回归 |
| --- | --- |
| Session schema、恢复、usage | [Session 测试](../../tests/unit/storage/session-store.test.ts)、[status 测试](../../tests/unit/status/model-status.test.ts)、[App 测试](../../tests/unit/tui/app.test.tsx)；旧缺字段、损坏尾行、串行追加 |
| Session 搜索与请求检查 | [Session 搜索](../../tests/unit/storage/session-store.test.ts)、[picker](../../tests/unit/tui/session-picker.test.tsx)、[context](../../tests/unit/agent/context-inspection.test.ts)、[surfaces](../../tests/unit/tui/daily-use-surfaces.test.tsx)；scope、分页、缓存失效、迟到结果、空状态与不可变快照 |
| UI 命令或布局 | [命令目录](../../src/tui/commands/slash-commands.ts)、[command surface 测试](../../tests/unit/tui/command-surface.test.tsx)、[App 测试](../../tests/unit/tui/app.test.tsx)；Esc、resize、迟到结果、历史重放 |
| 输入提交、草稿与历史导航 | [提交生命周期](../../tests/unit/tui/prompt-submission.test.tsx)、[输入历史](../../tests/unit/tui/prompt-history.test.tsx)、[App](../../tests/unit/tui/app.test.tsx)；连续 Enter、粘贴、重挂载、宿主草稿替换、失败重交和真实附件解析 |
| TaskProgress 与结构化问题 | [task progress 测试](../../tests/unit/workflow/task-progress.test.ts)、[ReactAgent 测试](../../tests/unit/agent/react-agent.test.ts)、[App 测试](../../tests/unit/tui/app.test.tsx)；旧 Session、持久化失败、resume/new、压缩、Esc/Ctrl+C 与单 prompt |
| Goal/Memory 结算 | [task runner 测试](../../tests/unit/workflow/task-runner.test.ts)、[Goal 测试](../../tests/unit/goal/runtime.test.ts)、[Memory 测试](../../tests/unit/memory/learned-memory.test.ts)；取消和验证债务 |
| 权限与审批 | [PERMISSIONS](PERMISSIONS.md)、[SANDBOX](SANDBOX.md)；运行时权限 revision、取消、原生启动失败关闭 |

新增状态前先决定它属于持久化事实、临时视图还是进程内资源；不要把三者共用一个布尔“成功”字段。增加持久字段必须同时补解析、序列化、缺字段默认与恢复测试，并更新本页和 [DECISIONS](DECISIONS.md)。

## 团队状态与窗口

Session 增量 team_updated 仅保存关系引用，成员使用独立 Session；fork 不复制团队所有权。成员 usage_recorded 可选 preserve_context 只累计总量，不污染根 context estimate。/team 独立窗口、单一审批队列、英文里程碑、显式继续与产物清理见 [TEAMS](TEAMS.md)。/status 和本地 /doctor 增加配置、团队完整性及验证状态；不自动发付费诊断。

聊天与命令窗口共享稳定的最外层 Ink Box。切换时直接卸载 Static，而不是释放包含 Static 的祖先；否则 Ink 保留的 Yoga 布局引用可能已经失效，在后续提交中形成异常尺寸及内存耗尽。原生 scrollback 重放和 resize 仍使用现有 timeline epoch。

## Web、诊断与估算面板

`/web` 保存 HTML/Brave 选择，密钥在 AuthStorage；`/doctor --live` 预览后默认 Cancel；`/cost` 配置每个注册模型的单价与预警。新面板保留 Esc 返回同一 Session、inline history 与 resize 契约，不进入 alternate screen。cost_estimated JSONL 可选事件由已结算账本生成；旧 Session 缺字段为未知，不推断零金额。详细字段、来源和时效见 [安全与诊断契约](SECURITY_AND_DIAGNOSTICS.md)，测试为 security-panels 与真实 PTY fixture。
