# Architecture Decisions

## Coding workflow and verification

普通 coding turn 使用进程内状态机协调理解、实现、验证、诊断和完成阶段，不替换 Responses/ReAct 工具循环，也不自动提交 Git。`apply_patch` 成功后立即选择有界快速检查，回合结束选择完整检查；命令只从工作区 manifest/锁文件和常见项目标志中发现，不执行任意脚本发现逻辑。验证 stdout/stderr 有界保留，失败作为结构化结果返回模型，修复次数超过三次后进入 `blocked`。

`workspace_status`、`workspace_diff` 和 `/diff` 只读 Git 状态。最新 Agent turn 的 `/undo` 使用内存检查点保存每个文件的 before 内容和 after SHA-256；恢复前必须确认当前内容仍等于 after SHA，用户改动的文件跳过并报告冲突。检查点不写入 Session JSONL，`/new`、`/clear`、`/resume` 和新一轮 turn 都会隔离它；Session 只追加 workflow 阶段、变更路径和最后一次验证结果等元数据，持久化验证事件不包含 stdout/stderr/error。

完整验证成功后，生产 TUI 对当前变更路径执行只读 Git review checkpoint；review 只确认变更仍可见，不修改工作区、不自动提交。失败进入 `diagnose`，错误作为有界 workflow prompt 返回模型；review 未配置时 runtime 保持原有 `review -> done` 路径。该检查点不新增 Session JSONL 字段，仍只保存阶段和最后验证元数据。

验证命令和工作区 review 都属于当前 turn 的可取消阶段。收到 AbortSignal 后必须传播原始取消错误，不得把取消或关闭转换成普通 verification/review failure、`diagnose` 或 repair attempt；只有命令自身以非零退出结束且未取消时，才生成修复指导。

## Shared sandbox process boundary and structured edits

模型 Bash 与 Codex CLI JSON 请求必须共享同一条 bounded process executor，避免只在 `runCodexCli` 测试路径覆盖 Windows sandbox helper retry，而真实 Bash 仍绕过它。Windows sandbox helper setup/refresh/unknown 错误只允许一次重试，取消、超时和最终失败都保持 fail-closed，不得回退宿主 shell。

文件编辑使用兼容 provider 的 `apply_patch` function tool，而不是要求所有端点支持原生 patch call。工具先完整预检工作区边界、符号链接、大小、重复路径和可选 SHA-256，再以临时文件/rename 应用多文件批次；任何失败都尽力恢复原内容。权限策略不进入 Session JSONL：用户 command prefix rules 写入平台配置目录，项目策略写入 `.everpeace/permissions.json` 时只允许收紧权限，避免仓库内容提升模型能力；patch staging 数据仍只存在进程内。

## Model shell timeout boundary

模型 Bash 调用必须有界：TUI 依赖层为模型命令设置 120 秒默认超时，`runBash` 在超时后终止完整子进程树，并保留已捕获输出。返回结果使用 `timedOut` 字段，序列化给模型时使用 `timed_out: true` 和明确错误文本；超时不是用户 Ctrl+C，因此 `cancelled` 保持 false。用户直接 `!` 走原生终端路径，不继承该默认超时。超时只限制执行时长，不绕过或改变 Codex sandbox 和审批策略。

## Coding task benchmark isolation

benchmark runner 是 Agent/TUI 之外的独立评测边界。任务通过 adapter 提供 prompt、工作区和可选验证命令；runner 只负责有界超时、验证执行、结果聚合和既有 `LoopEvent`/phase 指标采集，不负责 reset、checkout、删除工作区或改变权限策略。验证命令的 stdout/stderr 各保留最多 1 MiB 尾部。

benchmark 结果不是 Session 事件，不写入 JSONL，也不进入模型 context。adapter 必须把取消信号传递给底层 harness；runner 在任务超时后立即结束记录并将结果标记为 `timed_out`，底层 adapter 仍需自行终止其子进程或网络请求。unsafe action 会使运行失败，即使验证命令通过。

验证失败默认允许最多三次有界修复尝试。第一次 adapter 调用使用 `implement` phase，后续调用使用 `diagnose` phase，并通过 `previousVerification` 传递上一次验证结果；同一个 adapter 应复用 Agent/session context。任务前后只读记录 Git 快照，正式 benchmark 使用临时 clone/worktree，日常目录不自动回滚。可选 artifact sink 独立保存脱敏诊断文件，不进入 Session JSONL。

Provider capability profile 只记录已观察的模型能力和 context window。未知兼容端点保持保守默认值，第一阶段不自动路由或切换模型，避免把未验证的 provider 假设变成运行时策略。

## Context compaction

`/compact` 和自动压缩都调用供应商原生 Responses `/responses/compact`，不生成本地摘要。原始输出必须原样保留为新的模型 context，包括供应商的 retained items 与 opaque compaction item；可见 transcript 和既有 JSONL timeline 不裁剪。压缩成功后以 `context_compacted` 事件原子替换 context，并把压缩 usage 累计进 session token 统计；手动命令在模型轮次或直接命令运行时拒绝，已知 context window 达到 80% 时在下一次采样前自动触发，未知 window 不自动触发。

响应式恢复继续复用同一原生 compaction 接口：只有明确的 context-limit 错误才触发，每个 `runTurn` 最多一次；压缩成功后才用替换后的 context 重试采样，压缩失败不进入普通采样重试，也不做本地摘要回退。SSE 只有收到 `response.completed` 才算成功；能力拒绝必须发生在首个事件之前才允许切到 buffered 请求，连接中断、异常 EOF 或半截输出只从未持久化的历史有界重试。

Agent Loop 可靠性预算彼此隔离：普通采样重试默认最多两次，provider event-cursor 续接和 context compaction 各使用独立的一次性预算；半截 SSE 永不写入 context 或执行工具，续接失败回退到有界整轮重试。并行工具采用能力标记而非工具名泛化，默认 `parallelToolCalls=false`，显式开启后仅 `read_file`、`list_directory`、`read_skill` 可组成连续批次。批次同时执行但按模型调用顺序持久化，guidance/stop 等待整批结果落盘，副作用工具和审批永不自动并行。批次、续接和 retry 分类事件只供当前 UI/诊断使用，不扩展 Session JSONL schema。

Agent Loop 的正常 follow-up sampling step 使用独立预算，默认每个 turn 最多 32 个逻辑 step；同一 step 内的网络重试、stream recovery 和 context compaction 不重复消耗该预算。达到上限时发出 `step_limit_reached` 并返回结构化 `step_limit`；可选的正整数 `maxTurnDurationMs` 到期时返回 `deadline_exceeded`。两类受限停止都禁止额外工具、采样、workflow 修复和 Goal 续跑，不伪造完成，也不新增 Session JSONL 事件。该边界参考 xAI 官方 function-calling 示例中的显式 step count 停止模式；不代表已验证 Grok Build 的内部 runtime。


## 有界历史显示

聊天渲染及 resize、恢复、命令返回重放按 Codex 的 terminal resize-reflow 行数上限选择尾部：VS Code 1,000、Windows Terminal 9,001、WezTerm 3,500、Alacritty 10,000、未知终端 1,000。`WT_SESSION`、`TERM_PROGRAM` 和 VS Code 注入环境用于检测。Ink 不提供最终布局的行数，所以按源文本、宽度、换行及常见双宽字符估算；单条超长记录保持原子显示。窗口起点变化后复用同步终端重放，清除已输出的旧 scrollback；不能仅对 Ink Static 数组 slice，否则终端仍有旧输出。完整内存 timeline、JSONL、context、输入导航和 outputs 不裁剪。上游普通 transcript 没有通用的记录数上限；上游 `INITIAL_HISTORY_TURN_LIMIT=5`、`HISTORY_ITEM_PAGE_LIMIT=100` 和扫描上限仅适用于其分页的远端 thread 历史加载，不迁移到本地 JSONL 恢复。


状态快照：2026-09-19。

## TUI 源码边界

`src/tui` 按职责分为 `app`、`commands`、`composer`、`rendering`、`terminal` 和细分后的 `components`，完整映射见 [TUI_STRUCTURE.md](./TUI_STRUCTURE.md)。根目录只保留公开 `index.tsx` 入口；`app` 负责状态机与依赖装配，conversation/feedback/navigation/screens/wizards 组件按用户流程归组，输入编辑、slash command、渲染算法及终端设置文件操作各自独立。此次只移动模块和更新导入，不改变 inline TUI、Session、审批、命令窗口或持久化语义；后续拆分大型 `app/app.tsx` 必须按状态所有权进行并单独补回归，不能按行数机械切割。

## 权限管理

权限实现详见 [PERMISSIONS.md](./PERMISSIONS.md)：`/permissions` 提供 `read-only`、`ask`、`workspace-write`（默认）和 `full-access` 四档 profile。模型 shell 分别映射到固定版本 Codex CLI 的 `:read-only`、`:workspace` 或 `:danger-full-access`，sandbox 初始化失败时禁止回退为宿主直跑。文件工具始终限定工作目录，内置网页工具保留独立开关，MCP 使用另一条审批面。用户策略跨重启持久化在平台配置目录，项目策略可选地放在 `.everpeace/permissions.json` 并以 fail-closed 方式合并；权限切换不重建 Agent 或丢失 context，也不写入 Session JSONL。用户直接 `!` 继续走原生 PTY，不进入模型 sandbox 或 context。

## Codex Sandbox、MCP 与 Skills

完整边界见 [CODEX_CAPABILITIES.md](./CODEX_CAPABILITIES.md)。sandbox 复用 `@openai/codex@0.155.1` 的平台后端而非复制 Rust 实现；Windows 模型 shell 固定用 PowerShell，其他平台用 Bash。MCP 复用 `codex mcp` 配置，以官方 TypeScript SDK 连接 stdio/Streamable HTTP，非 full-access 的 tools、resources、prompts 调用逐次审批。主机 Skills 扫描 Codex 项目/用户/admin/system 根，只把无名称冲突的 metadata catalog 预载到 instructions，显式 `$name` 在本轮完整注入，隐式匹配通过受路径约束的 `read_skill` 渐进读取。`/mcp` 是 transient 状态窗口；`/skills` 是不进入 session timeline/context 的多步管理向导，可在每次操作中选择项目或用户作用域，AI 创建单个 `SKILL.md`，或从公开 HTTPS GitHub/Git/SKILL.md/ZIP 来源先暂存、校验和预览，再明确确认安装。创建/安装不得覆盖任一发现根的同名 Skill，重复名称在解决前不得自动或显式调用。三者均不改变 JSONL schema；当前不包含完整 Plugin、OAuth、远端 Skill provider 或 managed-policy runtime，Skill 管理也不包含私有认证、更新或删除。

Git Skill 来源采用 shallow、no-checkout 克隆：先读取有界 Git tree 和候选 `SKILL.md` metadata，同名打包副本按规范 `skills/<name>` 路径优先去重，预检候选文件类型、数量和字节数后才 sparse checkout。原始 `SKILL.md` 清单数与去重后的不同 Skill 候选数使用独立上限，100 个候选限制只对去重结果生效，避免同一仓库中的 Codex/评审镜像副本在实际候选未超限时被提前拒绝。该顺序避免 Windows 在无关深层路径上提前失败，也防止为了一个 Skill 展开整个仓库工作树；它不改变公开 HTTPS、无认证、超时、无覆盖和显式确认边界。

## Session 持久化

`/resume` 的批量删除是文件级永久操作：SessionStore 校验 ID、等待该 Session 的串行写入队列完成后删除 JSONL，不写入删除事件或回收站。当前活动 Session 被删除后由 TUI 清理内存状态并解除会话；未选中的 Session 与当前聊天不受影响。
- 每个 session 使用一个版本化 JSONL 文件，存放于平台应用状态目录；API Key 仍只进入系统 keyring。
- 可见 timeline 与 Responses API context 分开记录，保证恢复界面完整，同时不把直接 `!` 命令错误加入模型上下文。
- 写入按 session 串行追加；不完整末行可忽略，其他损坏只隔离对应文件。
- `session_created` 保存模型引用、工作目录及 usage tracking 能力；`model_selected` 表达模型变化及是否重置 context；`usage_recorded` 保存每次主 Agent 响应的 token 增量。

## Learned 经验记忆

- Learned 经验与对话 context 分离，写入平台应用状态目录：项目条目按规范化工作区路径哈希隔离，用户条目单独保存；不会自动修改仓库文件。详细格式和生命周期见 [MEMORY.md](./MEMORY.md)。
- 每个逻辑 step 按当前问题和已访问文件生成不可变 `MemorySnapshot`；普通网络重试复用该快照，工具 follow-up 或 guidance 后重新检索。`/memory view` 只显示最近一次实际注入的 revision、加载时间和内容。
- 只有 workflow 验证成功或用户明确要求长期记忆的轮次进入持久队列。生产运行时等待五分钟真实空闲；前台 turn 会暂停后台请求，任务可跨 Agent 重建和进程重启恢复，使用租约、去重键、单并发、每次最多五项、60 秒超时和最多两次重试。
- 后台先提取最多三条带来源候选，再做确定性去重与冲突检查；有多条可合并候选时才调用模型提出合并，程序校验后写入 Markdown。无法可靠判断的冲突保持 review，不进入 active 召回；旧 Markdown 继续作为 legacy 来源。
- 输入先结构化脱敏再裁剪，输出再次脱敏；覆盖 JSON 凭据字段、Bearer/token 和完整或不完整 PEM。长期条目保留完整时间与证据，active 配额按 scope 限制为 100，归档和候选不挤占该配额；读改写使用跨进程锁与原子替换。
- 全局开关同时控制读取和自动学习；当前聊天的 `readExisting` / `captureFuture` 策略通过兼容性 `memory_policy_updated` 事件随 Session 保存和恢复。关闭读取会使下一次请求刷新为空快照并撤下 `memory_lookup`，关闭捕获会取消待处理任务并阻止迟到结果回写。
- 召回使用中文双字片段、英文、路径和标识符匹配，按完整条目装入字符预算。主 prompt 只包含短索引；只读 `memory_lookup` 可按 ID 查看当前 scope 内的脱敏详情，Plan 模式也可使用。
- Memory 模型 usage 单独显示，缺失时标记 unknown，不计入前台 context 占用或 Goal 预算。Learned memory 只提供不可信 recall，不替代 `AGENTS.md`、项目文档、当前用户指令、权限策略、Session context 或 Responses compaction。

## Plan 与 Goal

- `/plan` 是进程内严格规划模式，不写计划文件；只暴露 read/list、web、Skill read、`request_user_input` 和 `submit_plan`，从工具列表层面阻止 Bash/MCP。启用网页工具时，Plan 的公共 web 请求按只读联网能力免逐次确认；关闭网页工具仍然拒绝请求，普通聊天继续遵循当前权限档位。结构化问题和最终计划均经 transient picker/review，用户批准后在同一 Session 切回 Default 执行。
- `/goal` 绑定原 Session，以 `goal_updated` JSONL 事件保存最新快照，旧 Session 文件缺少该事件时按无目标兼容读取。目标恢复只发生在用户 `/resume` 原 Session 后，不扫描其他 Session 自动运行；`/new` 和 `/clear` 不继承目标。
- Goal 工具按 Codex 语义提供 `get_goal`、`create_goal`、`update_goal`；只有显式目标创建、用户确认的暂停/恢复，以及真实完成或连续三轮同一阻塞才改变状态。连续阻塞计数写入 goal 快照，跨 Agent 重建和 Session 恢复不丢失。token budget 只在用户显式指定时启用，缺失 usage 不伪造 token。

## Status 与 usage

- `/status` 生成结构化独立命令窗口；窗口与聊天根视图互斥，隐藏 `History`、Prompt 和全局状态栏。Esc 同步清屏并从内存重放原 Session，窗口不进入 `Static` timeline、session JSONL 或 Responses context。
- 信息型 slash command 使用 transient `View`，选择型命令使用 picker/wizard，但都位于同一独立命令窗口。`session_created`、`model_selected`、注册表修改等真实状态变化仍分别持久化，立即动作的结果提示可以只留在当前 UI。普通聊天、Agent 工具输出和直接 `!` 命令保持可恢复。
- 独立窗口继续使用 inline terminal 和同步输出，不启用 alternate screen；异步只读加载用 operation generation 隔离，Esc 返回后迟到结果不得重新打开窗口。
- 所有独立窗口使用共享 `CommandScreen`：外框宽度为 `min(80, terminalColumns - 2)`，在 `terminalRows - 1` 的可用高度内水平、垂直居中；内容过高时容器自然扩展而不裁剪，字段内容保持左对齐。
- Session input/output token 是主 Agent 每次 Responses API 调用 usage 的累计值，包括工具循环中的中间响应，不包含后台标题请求。
- Context 占用取最近一次成功响应的 `total_tokens`；切换并清空 context 后归零，保留 context 换用替代模型时在下一次响应前视为未知。
- Provider 由规范化 `base_url` 识别；context 上限只对已知官方 model ID 使用文档值，自定义端点和未知型号显示 `N/A`。
- 旧 session 缺少 usage tracking 时继续兼容读取，历史总量标记为不完整，不反推或伪造 token。
- 旧 session 已包含的结构化 status timeline entry 继续解析和显示，不迁移或改写已有 JSONL。

## Prompt cache

主 Agent 使用 Responses API 的服务端 prompt caching，不缓存或复用完整模型回答。官方 OpenAI endpoint 的主采样与原生 compaction 请求携带按 Session ID 生成的 `everpeace:v2:session:<id>` `prompt_cache_key`，并在请求 options 中携带同值 `session-id` header；key 由 Agent 在请求时延迟解析，以覆盖 Session 创建晚于 Agent 创建的生命周期。DeepSeek 和未知 OpenAI-compatible endpoint 不主动发送缓存参数或 header，避免兼容端点因未知字段失败。缓存 key 不包含原始路径、API key 或用户输入。

GPT-5.6 及以后官方型号额外使用 `{ mode: "implicit", ttl: "30m" }`，并把固定系统指令放入 request-local developer 前缀，在其最后一个输入文本块设置显式 breakpoint；动态权限、Plan/Skill/MCP、memory 和 goal 内容不进入固定前缀。旧型号只使用基础 key/header。若官方端点返回明确的 prompt-cache 参数不支持错误，当前 Agent 生命周期内关闭高级字段并对原请求降级重试一次。

Responses usage 中的 `input_tokens_details.cached_tokens` 与 `cache_write_tokens` 会归一化为 Session usage 的可选缓存统计，并通过既有 `usage_recorded` / `context_compacted` 事件兼容持久化。旧 JSONL、没有缓存详情的 provider 和缺失 usage 不伪造缓存命中，`/status` 对不可用统计显示 `N/A`；可用时显示缓存读取量、写入量和累计命中率。

## Session 生命周期

- 默认采用延迟创建：没有活动 session 时，第一次普通提问先建档再请求模型。
- `/new` 是显式立即创建：要求已有活动模型，写入临时标题“New Session”并立刻切换到新 timeline/context；旧记录中的“新 Session”只在选择器显示层翻译，不改写 JSONL；创建提示只显示在当前 UI。
- `/clear` 不等同于 `/new`：它只清屏并解除当前 session，下一次普通提问才创建文件。
- 切换 session 不需要丢弃确认，因为所有活动内容持续写入本地文件。

## 标题状态

- `/new` 创建的空 session 使用 `title_pending: true`；该状态持久化，因此空 session 经 `/resume` 后仍会由第一条问题命名。
- 首问先写入截断后的可靠回退标题并清除 pending，再并行执行无工具、`store: false` 的模型标题请求。
- `title_updated` 始终把 pending 状态置为 false；旧 JSONL 没有该字段时默认 false。
- 标题限制为单行 60 display cells，并移除常见 Markdown、引号和结尾标点。

## 恢复行为

- `/resume` 全局列出 session，按最后活动时间倒序显示“名称 + 时间”。
- 优先恢复 session 当前模型；模型缺失时允许选择替代模型并保留 context。
- 恢复其他项目时自动切换到原工作目录；目录不存在则拒绝恢复并保留当前会话。
- transcript 重放继续使用现有 synchronized output 和 source-backed timeline，不改变 inline TUI 与普通滚轮行为。

## Slash 命令菜单

- 仅当去除前导空格后的单行输入是以 `/` 开头的单个 token 时显示候选，正文、参数和多行输入不触发。
- 候选按现有命令定义顺序进行不区分大小写的前缀匹配；最多同时显示八项，超出时随当前选择滚动。
- `Prompt` 独占输入处理：方向键或 `Ctrl+P/N` 选择，Enter 执行，Tab 只补全，Esc 关闭到下一次编辑；菜单本身不注册第二个 input handler。
- 菜单位于 composer 下方且只展示命令名，不改变 slash command 的解析和执行接口。
- 带界面的命令执行后通过同步清屏进入独立窗口，只显示当前命令内容；Esc 再次同步清屏并重放完整 transcript，不启用 alternate screen。
- 命令窗口 resize 时按新的行列数重新居中；Session 列表标签按窗口实际宽度截断，不按全屏宽度计算。

## 联网工具

- 联网能力使用 Responses API 普通 `function` 工具 `web_search` 和 `web_fetch`，不依赖供应商私有 built-in tool，因此 DeepSeek 和自定义 OpenAI-compatible 端点可复用同一 ReAct 循环。
- `web_search` 先请求 Bing HTML 搜索，失败或无结果时回退 DuckDuckGo HTML 搜索；每次最多返回五条标题、URL 和摘要，不需要额外搜索 API Key。
- `web_fetch` 只执行公共 HTTP/HTTPS GET，请求前解析 DNS，每次重定向重新校验，拒绝凭据 URL、localhost、本地域名、内网、链路本地和其他非公共 IP。
- 搜索页和目标页都有限时及响应体上限；页面正文最多向模型返回 30,000 字符。网络、解析和页面错误序列化为 function output，让模型可以解释失败或换用其他来源。
- 网页内容是提示注入边界之外的不可信数据；系统指令要求模型不得执行网页中的指令，并在最终回答中列出实际采用的来源 URL。
- 搜索和页面读取无需 Bash 确认，简短工具动作写入可恢复 timeline；完整 function call/output 继续按既有规则写入 Responses context。

## 任务取消与输入输出

- 模型轮次运行时保留一个可编辑 guidance composer。用户提交的普通消息立即写入可恢复 transcript；真实 Agent 支持时会中止当前 sampling，并在已持久化上下文的安全检查点应用 guidance，工具执行中的消息等待当前工具结果落盘后生效，未启动调用补齐 `steered` output。Ctrl+C 取消时先将待处理 guidance 写入模型 context，避免遗留给未来轮次。旧 AgentSession 替身仍按 FIFO 下一轮兼容。模型 Bash 的非交互输出不会夺取输入焦点。直接 `!` 运行时仍将 stdin 独占给 PTY，Ctrl+C 取消当前命令。

- TUI 自有文案使用英文；用户和 assistant 正文保持原文。已知旧 system/tool/error timeline 文案在渲染时映射为英文，持久化文件与 Responses context 均不迁移、不改写。
- Agent loop 的 `sampling` / `tools` phase 及 `LoopEvent` 通过构造回调进入 TUI：Responses SSE 的文字 delta、审批、工具开始/结束、重试和 steering 都即时展示，兼容端点退回 buffered 阶段显示。阶段状态和增量内容不持久化；耗时小于一分钟显示秒，超过一分钟显示 `m+s`，超过一小时显示 `h+m+s`。
- assistant timeline 以 GFM token 渲染标题、列表、强调、链接、表格和代码；代码语言由围栏或 shell 元数据确定。高亮限制为 512 KiB、10,000 行、单行 4 KiB，未知语言、越界内容或解析失败退回纯文本。原始 Markdown 仍是唯一持久化内容。
- 模型命令、用户直接命令分别以 Ran/You ran 卡片显示；失败和取消保留文本状态而不只依赖颜色。新命令不再额外写入重复 `! command` 和成功提示，审计信息继续由 output timeline 的可选 command 元数据承担，旧 timeline 保持可读。
- unified diff 只有在显式 `diff`/`patch` 围栏或严格识别到文件头+hunk 的命令输出时启用。展示 old/new 行号、hunk/file gutter 及增删色；真彩配色根据 `COLORFGBG` 选择明暗背景，ANSI256/16 与 `NO_COLOR` 降级仍保留 `+`/`-`/gutter。该功能只渲染已有内容，不自动采集 Git 或文件快照。

- `/resume` 的输入导航从所选 timeline 中的 user 条目及 source=user 的命令输出恢复，不依赖新增全局历史文件；不将模型命令混入用户输入。不带来源的旧 tool 条目不能可靠区分用户与模型，故不推断。恢复成功清空草稿和导航索引，`/new`、`/clear` 回到全局输入导航。召回斜杠命令不自动打开候选菜单，编辑后恢复正常筛选。
- Agent 构造及每轮开始时修复不完整 function call/output 配对：在后续用户消息前补 interrupted/结果未知，不重新执行工具，不伪造成功。修复仅用于内存请求上下文，不重写旧 JSONL；再次恢复会幂等修复。工具执行异常转为错误 output，取消仍停止整轮。

- Ctrl+C 优先取消活动任务（含审批和子进程）；空闲有草稿时清空，否则退出。模型取消时为剩余 function calls 追加取消结果后停止，不留下未匹配调用。
- Ink 独占 TUI stdin，通过 writer 将输入转发给直接 `!` PTY；模型 Bash 使用非交互管道。Windows Bash 取消使用 taskkill 进程树；PTY 先发送 ETX，500ms 后通过 node-pty 关闭。Unix Bash 当前使用进程组强制终止，PTY 先 ETX 后强制终止。
- 输入历史独立于 Session 和模型 context，保存于 state 目录 input-history.json；保留最近 1,000 条、4 MiB，临时文件原子替换及跨进程文件锁。只记录主输入区提交，不记录登录向导字段；用户手输机密不自动脱敏。
- output timeline 增加可选 command 元数据而不新增事件类型，兼容旧无元数据输出。模型 Bash 的实时回调使用独立 1 MiB 有界缓冲，按到达顺序保留真实首五行、尾五行和省略行数；正常终端展示 5+5，矮终端按可用高度首尾缩减。该缓冲只服务当前 UI，不改变最终 `BashResult`、模型 context 或 JSONL。用户直接 `!` 继续显示最近五行；完成超过六行时展示前二后四；`/outputs` 在独立窗口分页查看保留输出，不能找回超限截断内容。
- /terminal-setup 仅支持已识别的稳定版 Windows Terminal 设置路径。用户确认后备份并追加 Shift+Enter sendInput LF，不覆盖已有绑定；提示全局影响。Preview/其他安装布局暂不自动配置。
- pnpm 对 node-pty 1.1.0 应用局部补丁：处理关闭控制台时进程枚举竞争，并在自然退出后释放输入 socket 和 conout worker。使用 pnpm 安装本仓库以应用补丁；发布前需另验打包安装，普通 npm 下游安装不会自动继承根项目 pnpm 补丁。

## Agent loop 对齐路线

当前采用保守的 `response.completed` 后整批工具执行：响应必须先持久化，半截或失败响应、缺失/重复 `call_id` 不得启动工具。后续只有在 provider 明确证明 `output_item.done` 顺序、durable record 与 recovery cursor 安全时，才允许 capability-gated item-level 执行；未知端点继续现有路径。

并发能力已从工具名白名单迁移到显式 `read_only`、`idempotent`、`parallel_safe` 和资源键；未声明工具串行，MCP 元数据不单独授予本地并发权限。结果按模型顺序持久化，取消、steering、stop 和持久化失败不得留下未配对 function output。

benchmark 只作为协议变更证据，不是自动路由或近期重构理由。hooks、完整 MCP lifecycle、Plugin/远端 provider、多 Agent 和外部 app-server 维持明确未实现边界，不用 no-op 或伪造成功暴露。

## 维护约束

- Agent 主循环采用 Codex 核心控制流程的 TypeScript 适配，位于 `agent-loop.ts`；`ReactAgent` 保留为供应商/工具/持久化适配层。逐工具结果持久化，主请求重试由循环控制，明确不等同完整 Codex runtime。来源和差异见 `AGENT_LOOP.md`。

- 功能、行为、接口或验证结果发生变化时，同步更新 `docs/PLAN.md`、本文件及 `docs/HANDOFF.md` 中受影响的内容。
- 根级 `AGENTS.md` 只保存跨 Session 长期有效的项目事实和工作约束；易变化的进度、验证结果及下一步统一记录在 `docs/HANDOFF.md`。


## Agent loop 交叉边界

- `hasPendingSteering` 只查看队列，`applySteering` 只在工具调用全部闭合后提交。guidance 保存成功才出队，响应完成后的 steering 也重建 step 并受同一正常步数上限约束。
- 广告工具、准入和能力来自隔离的 step snapshot；Plan 禁止操作不能通过模型返回未提供的工具绕过。实时权限继续在 dispatch 检查。
- `AgentTurnResult.stopReason` 为预算停止提供独立控制路径，`stopped` 不等同于 `completed`；TUI 不继续 workflow 自动修复或 Goal 自动采样。限额在收到 usage 后生效，不声称能提前预测单次请求消耗。
- 持久化失败使用 `PersistenceError`，不走网络重试，不降级为模型可继续处理的工具错误。存储事件类型保持兼容。
- 默认串行保持不变，显式并行只开放内置文件/Skill 读取，默认批次上限 4；MCP 和审批全部串行，远端 metadata 不授予本地并发权限。共享资源键冲突拆分批次，写调用作为屏障。
- 自动压缩按 step 准备一次；压缩 usage 累计到消耗，替换后的 context 占用标为未知，恢复 Session 也不把压缩消耗当作占用。
- SSE event log 只为 recovery adapter 保留，默认最多 8 MiB；超限释放恢复缓存且放弃当前响应续接，仍完整消费内容，失败走有界整请求重试。
