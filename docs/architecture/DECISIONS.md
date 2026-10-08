# Architecture Decisions

## 全项目分层与验证基线

现有实现按入口适配、应用协调、任务执行、Agent 引擎、能力与资源划分职责；各层映射和状态所有者统一记录于 [PROJECT_MAP](PROJECT_MAP.md#整体分层与状态归属)。生产 factory 保持共享装配入口，核心模块不依赖 React、Ink 或 TUI。入口负责交互，应用协调决定是否启动及会话归属，现有 runner 决定清理、验证和最终完成；后续按状态所有权逐步提取，不按行数拆文件，不建立第二套 runner 或存储。

Session 保存持久事实，界面使用投影。批准、文件观察和活动进程各自保留现有生命周期，不通过恢复历史重建批准或写权限。基础阶段建立架构与验证契约；后续提取协调状态同样不改变公共 CLI/SDK、Session schema 或操作流程。

[架构回归](../../tests/unit/architecture/dependency-boundaries.test.ts) 使用已安装 TypeScript 的解析能力，禁止 runtime、Agent、workflow、exec、SDK 普通／类型导入、重导出或字面量动态导入 React、Ink、`@inkjs/ui` 与 TUI 模块；CLI 与 TUI 适配入口允许合法 UI 依赖。常规类型检查显式覆盖源码及测试全部 `.ts` / `.tsx`，构建显式覆盖源码 TSX 并排除测试，保留严格设置与 ES2022。暴露的测试契约差异由替身和数据修复，不放宽生产接口或断言。门禁与升级编译器时的解析 API 复核见 [DEVELOPMENT](../DEVELOPMENT.md#开发与检查命令)。

## 应用协调状态提取

[ApplicationCoordinator](../../src/runtime/application-coordinator.ts) 从 TUI 提取 Session／Agent 身份、模式、模型任务准入／取消、Plan 批准和命令操作身份。它是每次 TUI 挂载的进程内状态所有者，使用泛型 Agent 身份，不引用 UI 合同；TUI 保存显示投影和宿主 I/O 适配，生产 factory 与 coding runner 继续承担原职责。

取消不释放准入，清理后才由同一任务句柄释放；成功会话替换推进身份并取消旧任务，首次惰性创建保留现有任务身份。批准正文复制保存／读取，消费与执行准入同步完成，旧会话、旧 Agent、取消或重复结果不能恢复批准。失败的宿主会话操作不提交身份替换。初次 Session 创建在清空后才返回时，保留已落盘事实但不重新进入旧会话；旧任务清理仍释放入口，不把其错误或批准显示到新会话。语义回归见 [协调状态](../../tests/unit/runtime/application-coordinator.test.ts) 和 [TUI App](../../tests/unit/tui/app.test.tsx)。第二阶段的这次提取不建立第二套验证或存储，也不同时整理 Agent 引擎、工具、存储或终端模块。

## Agent step 工具目录

第三阶段首轮按同一逻辑 step 的状态归属提取 [StepToolCatalog](../../src/agent/step-tool-catalog.ts)：广告定义、名称准入、MCP binding 和并发资格由一个不可变目录派生。ReactAgent 在独立来源准备成功后构建它；请求、稳定前缀、context inspection 与 dispatch 共同读取，普通 retry 复用，follow-up／steering 刷新，turn 收尾丢弃。保持工具顺序和格式，不扩展公共参数或 Session schema。

MCP metadata 仅绑定当前广告工具，annotations 与供应商并行参数都不能授予本地并发能力。宿主审定的读取可以并发，LSP 与 MCP 保持串行屏障；返回的能力对象独立，外部修改不能改变目录。工具路由、实时权限、审批、取消、预算、文件观察、durable record 与 runner 结算继续归既有实现，不因目录存在而获得操作授权。回归覆盖嵌套定义／binding 隔离、失败准备不得采样、跨 turn 准入丢弃和真实本地读取顺序，见 [目录回归](../../tests/unit/agent/step-tool-catalog.test.ts) 与 [loop boundaries](../../tests/unit/agent/loop-boundaries.test.ts)。后续请求／上下文职责逐项细化，不机械拆分整个 ReactAgent。

## 后台任务准入与完整结算

第四阶段首轮由现有 [BackgroundJobManager](../../src/tools/background-jobs.ts) 拥有启动占位、父信号绑定、执行器完成 promise 和一次终态发布。登记先于执行器调用，同步抛错与异步拒绝使用同一结算路径；结果和完成时间随终态一起可见，终态之后忽略输出 callback。先建立完成 promise 也使执行器重入清理时仍能等待自己的 worker，不通过临时空 promise 跳过任务。

stopAll 使用清理计数关闭准入，重叠清理全部返回后才允许新的显式启动；dispose 立即永久关闭，重复调用复用清理。停止与等待都等完整登记任务的 promise，不从 UI 标签判断结束。预先取消不能启动执行器，失败 job 可以正常查询并通知，`BACKGROUND_CLEANUP`／`BACKGROUND_DISPOSED` 使用现有结构化反馈，不增加重试或审批旁路。task generation、通知持久化、shell sandbox、文件观察和 runner 验证结算仍归原路径，公共参数、工具定义与 Session schema 不变。详见 [TOOLS](TOOLS.md#模型-shell-与后台任务) 与 [生命周期回归](../../tests/unit/tools/background-jobs.test.ts)。

## Session 搜索返回快照

第五阶段首轮明确 [SessionStore](../../src/storage/session-store.ts) 搜索缓存与返回快照的所有权。JSONL 是恢复事实的来源，LRU 保存内部投影，冷读与 warm hit 都在返回边界深度复制 summary；调用方修改自己的标题、模型、Goal、workflow、TaskProgress、Memory policy 或 lineage，不能污染后续查询。match／preview 沿用按值生成，缓存大小、失效条件、日志扫描和恢复流程保持原状，不新增事件或公共参数。

使用已有 structuredClone 复制经过 JSONL 校验的普通数据，不冻结接口、不通过关闭缓存掩盖别名问题。回归绑定再次匹配、嵌套状态、fork 债务、usage unknown、实际 cache-hit／读取字节及真实 picker，见 [存储回归](../../tests/unit/storage/session-store.test.ts) 与 [选择入口](../../tests/unit/tui/session-picker.test.tsx)。其余重放／存储职责继续逐项细化，不在本轮拆分整个 SessionStore。

## 个人开发任务连续性与失败反馈

参考固定 DeepSeek Harness `639ed015397290b3745d163aafe02ffee4aa3f84` 的 `compaction-basic/src/summarizer.ts`，采用结构化交接保留目标、最新纠正、失败证据和下一步，但继续使用现有 Responses 与单 Agent runner。模型摘要作为 assistant 背景；旧摘要仅做请求投影，避免将模型生成正文放入 developer 权威。八章结构验证失败时保留原 context，不以额外请求修复摘要；这保证失败关闭，不保证模型摘要语义无遗漏。

工作流只读投影通过共享 production IO 注入每个逻辑 step，复用已有状态和持久化；它不包含验证正文、权限、凭据或检查点，并保留未知字段与历史验证债务。工具反馈使用显式类型和状态分类，补充原因及修正方式，不靠错误文案判断，不自动重放可能已产生副作用的命令。默认请求参数、sandbox 与宿主成功判定继续复用；效果证据限定离线机制回归，真实 DS 成功率和成本需另行有界实测。

## Composer 提交与草稿生命周期

第六阶段首轮在现有 [Prompt](../../src/tui/composer/prompt.tsx) 内固定提交占用、挂载身份和草稿快照的归属。输入占用在调用宿主前同步建立，React 的 submitting 状态只控制显示和订阅，不能单独防止连续按键或同步重入。普通 resize／重渲染保持身份，卸载使旧完成回调失效；即使仍挂载，宿主替换了 ComposerState，旧提交也不能清空新草稿或历史导航。

false、抛错和拒绝沿用保留草稿、显式重交的语义，不新增重试。挂载内提交占用不是模型任务准入；应用协调、文件附件取消、Session 身份和 runner 清理仍走现有路径，不把 UI 状态迁入 Session 或核心模块，也不改变公共参数。实际输入流、重挂载和受控 Promise 见 [提交回归](../../tests/unit/tui/prompt-submission.test.tsx)，真实附件解析、任务切换、resize 与命令重放见 [App 回归](../../tests/unit/tui/app.test.tsx)。

## 文档分层与按任务阅读

开发知识统一放在 `docs/`，`dosc/` 只保留导航入口。根 [AGENTS](../../AGENTS.md) 保存启动流程与全局约束；[知识库索引](../README.md) 路由专题；[PROJECT_MAP](PROJECT_MAP.md) 关联实际源码和回归测试。新 Session 只必读 AGENTS 与 [HANDOFF](../HANDOFF.md)，然后按任务选择必要专题与修改点，不重复全仓调查。

专题说明当前机制，HANDOFF 保存当前证据与待验收项，[PLAN](../PLAN.md) 维护当前范围；历史交接与计划完整移入 [archive](../archive/README.md)，旧结论不当作当前行为或执行授权。代码和测试推翻文档时先服从证据，再同步修正说明；文档不能替代修改前的定向代码阅读。本文同主题内容须保持一致，不依赖读者自行猜测后面的段落覆盖前文。

## 日常上下文选择与检查面

Composer 文件附件采用显式 `@"path"` / 行范围语法，而不自动检索历史或隐式展开普通 `@` 文本。宿主在提交时通过既有安全文件读取边界获得新鲜摘录，把用户原文和带元数据的摘录作为一条 durable context message 持久化。timeline、输入历史和标题请求保留用户原文；retry、repair 和 Goal continuation 复用已经落盘的 message，不能重复附件。附件路径参与项目规则发现，但附件读取不写入文件观察表，所以不产生修改授权。

人工 `/diff` 与模型的 workspace tools 分开：前者从结构化 Git status 建立 staged/unstaged/untracked 列表，再按选择读取有界详情；后者接口保持兼容。两个界面都只陈述观察到的当前变化，不推断 Agent 所有权。Git 路径以仓库根解析后约束到活动工作区，禁用 external diff/textconv，特殊文件显示摘要。

`/resume` 搜索使用 Session JSONL 的瞬时进程内投影，不增加持久索引或 schema。标题与 user/assistant conversation message 才参与不区分大小写的字面量匹配；tool output、context 和 Memory 排除。当前工作区是默认 scope，切换全部工作区由用户明确操作；命中后仍走原恢复路径，搜索不会改变 Goal、workflow、模型或目录语义。

`/context` 的快照边界是 coding provider call 已获准并即将发送，而不是请求大小预估或 Session 恢复。快照只存当前 Agent 内存并深复制，辅助请求不覆盖；因此首次提交前、重启或 Agent 替换后必须显示 unavailable，不能从历史近似重建。只保留有界脱敏的已知可见来源，reasoning、encrypted body、凭据和 transport header 仅可用非内容计数/大小表达或完全排除；估算不得标为 measured usage。

## Coding workflow and verification

普通 coding turn 使用进程内状态机协调理解、实现、验证、诊断和完成阶段，不替换 Responses/ReAct 工具循环，也不自动提交 Git。`apply_patch` 成功后执行有界快速检查，回合结束运行完整检查集合；命令只从工作区 manifest/锁文件和常见项目标志中发现，不执行任意脚本发现逻辑。验证 stdout/stderr 有界保留，失败作为结构化结果返回模型；宿主实际启动最多三轮诊断，耗尽后进入 `blocked`，同一轮多次 patch 失败不重复扣减。

个人开发语义以 Node/TypeScript 单包项目为目标。每个逻辑 step 读取工作区根到已访问目标目录的 `AGENTS.md` chain 和 `package.json` scripts；该内容属于低优先级项目背景，不能提升权限或覆盖当前用户/开发者指令，网络重试复用同一 step 快照。最终检查不再选择单条命令，而是重新发现当前 manifest，按 `typecheck`、`lint`、`test`、`build` 串行首败停止；不存在检查时返回 `unavailable`，不能等价为成功。

工作区跟踪以任务开始时的 Git dirty state 为基线，解析 `git status --porcelain=v1 -z --untracked-files=all` 并为候选路径计算有界内容指纹。最终 changed paths 是当前状态相对该基线的差值，因此已有脏文件被模型再次修改、未跟踪文件、删除、空格及非 ASCII 路径都可识别；超出路径/字节限制时失败关闭为 tracking limited。非 Git 项目的结构化 patch 继续用进程内 SHA-256 checkpoint 校验，非 Git shell 修改只可标为未验证。`/undo` 不扩展到 shell 修改。

`WorkflowState.result` 区分 `verified`、`unverified`、`failed`、`no_changes`，完整检查保存为 `VerificationSuiteResult`。Session 的兼容 `workflow_updated` 事件只保存命令、退出码、耗时、跳过项和整体状态，移除 stdout、stderr、error 与文件内容。模型请求 Goal complete 时先返回 pending；宿主仅在最终 `verified` 或确定无改动时提交完成状态。Memory 的 verified outcome 同样只来源于工作流结果，宿主生成的摘要报告观察路径、已运行/跳过检查和限制原因。

`workspace_status`、`workspace_diff` 和 `/diff` 只读 Git 状态。最新 Agent turn 的 `/undo` 使用内存检查点保存每个文件的 before 内容和 after SHA-256；恢复前必须确认当前内容仍等于 after SHA，用户改动的文件跳过并报告冲突。检查点不写入 Session JSONL，`/new`、`/clear`、`/resume` 和新一轮 turn 都会隔离它；Session 只追加 workflow 阶段、变更路径和最后一次验证结果等元数据，持久化验证事件不包含 stdout/stderr/error。

完整验证成功后，生产 TUI 对当前变更路径执行只读 Git review checkpoint；review 只确认变更仍可见，不修改工作区、不自动提交。失败进入 `diagnose`，错误作为有界 workflow prompt 返回模型；review 未配置时 runtime 保持原有 `review -> done` 路径。该检查点不新增 Session JSONL 字段，仍只保存阶段和最后验证元数据。

验证命令和工作区 review 都属于当前 turn 的可取消阶段。收到 AbortSignal 后必须传播原始取消错误，不得把取消或关闭转换成普通 verification/review failure、`diagnose` 或 repair attempt；只有命令自身以非零退出结束且未取消时，才生成修复指导。

## Sandbox hardening and follow-up policy boundary

固定源码对比与分阶段计划见 [SANDBOX.md](./SANDBOX.md)。保留固定原生后端，模型 shell 显式传入 `--include-managed-config`，启动 Node wrapper 前过滤继承的凭据及启动注入变量，同时启用后端默认凭据排除。直接 `!` 与 MCP 的环境不走这个过滤器。该过滤不承诺阻止从可读文件或显式后端配置获取凭据。

结构化编辑保护 `.git`、`.codex`、`.agents`、`.everpeace`，full-access 例外由宿主根据实时权限设置，模型参数不能放开；Windows ADS 仍拒绝。预检拒绝整个批次，workflow checkpoint 后再检查取消与只读权限。

每个模型命令启动前从实时用户/项目权限、cwd 和 Skill 读取根生成不可变有效策略。workspace/ask 使用完整覆盖的原生 `:workspace` 子 profile，把控制目录设为只读、平台 Everpeace 状态根设为不可访问；宿主先创建 `.everpeace` 并拒绝其为符号链接或 junction，避免 Windows 对不存在 deny target 的空洞。full-access 明确保留例外，managed requirement 冲突失败关闭。Windows 原生回归已验证普通文件可写而 `.everpeace` 写入失败；Linux/macOS 仍待原生验收。

命令规则按顶层 shell 段分别检查；命令替换、未闭合语法与嵌套解释器转为逐条审批，未解析内容中出现明确 deny 仍拒绝。该保守分析器不冒充完整 shell parser。审批期间权限 revision 变化会使 Bash、patch 或自动验证的旧审批失效。模型 shell 网络使用独立持久开关，关闭时只通过原生后端 deny 参数执行，不复用 web/MCP 开关；选择 full-access 清除用户级网络 deny，项目级 deny 继续收紧，后端无法组合时失败关闭。隔离文件 worker 仍属于后续阶段，因此不得声称所有宿主文件工具共享 OS 隔离。

## Shared sandbox process boundary and structured edits

模型 Bash 与 Codex CLI JSON 请求必须共享同一条 bounded process executor，避免只在 `runCodexCli` 测试路径覆盖 Windows sandbox helper retry，而真实 Bash 仍绕过它。携带 `--` payload 的 sandbox 命令不得根据 stdout/stderr 中的 helper 文案自动重试；只有无 payload 的 helper 调用保留一次重试，且成功退出不得重试。取消、超时和最终失败都保持 fail-closed，不得回退宿主 shell。

文件编辑使用兼容 provider 的 `apply_patch` function tool，而不是要求所有端点支持原生 patch call。工具完整预检路径、符号链接、大小和重复操作；生产 update/delete 强制使用宿主读取观察的原始字节 SHA-256，模型省略可选 hash 不能绕过。审批再次绑定 preview 版本和权限 revision，create 排他创建；批量失败只回滚仍匹配本次 post-image 的已写文件，并报告冲突/IO 错误。权限策略不进入 Session JSONL：用户 command prefix rules 写入平台配置目录，项目策略只允许收紧；patch staging 数据仍只存在进程内。

## Model shell timeout boundary

模型 Bash 调用必须有界：TUI 依赖层为模型命令设置 120 秒默认超时，`runBash` 在超时后终止完整子进程树，并保留已捕获输出。返回结果使用 `timedOut` 字段，序列化给模型时使用 `timed_out: true` 和明确错误文本；超时不是用户 Ctrl+C，因此 `cancelled` 保持 false。用户直接 `!` 走原生终端路径，不继承该默认超时。超时只限制执行时长，不绕过或改变 Codex sandbox 和审批策略。

## Coding task benchmark isolation

benchmark runner 是 Agent/TUI 之外的独立评测边界。任务通过 adapter 提供 prompt、工作区和可选验证命令；runner 只负责有界超时、验证执行、结果聚合和既有 `LoopEvent`/phase 指标采集，不负责 reset、checkout、删除工作区或改变权限策略。验证命令的 stdout/stderr 各保留最多 1 MiB 尾部。

benchmark 结果不是 Session 事件，不写入 JSONL，也不进入模型 context。adapter 必须把取消信号传递给底层 harness；runner 在任务超时后立即结束记录并将结果标记为 `timed_out`，底层 adapter 仍需自行终止其子进程或网络请求。unsafe action 会使运行失败，即使验证命令通过。

通用 adapter 兼容有界 `implement/diagnose` 尝试；生产 adapter 声明 `managesRepairs` 并复用 `CodingTaskRunner` 和连续 Session，只保留生产三轮诊断，不叠加评测器修复循环。独立 acceptance 不能把取消或预算停止改为整体成功。任务前后只读记录 Git 快照，正式 benchmark 使用隔离工作区，日常目录不自动回滚。可选 artifact sink 保存脱敏结果，不进入 Session JSONL。完整契约见 [BENCHMARKING](../BENCHMARKING.md)。

Provider capability profile 只记录已观察的模型能力和 context window。未知兼容端点保持保守默认值，第一阶段不自动路由或切换模型，避免把未验证的 provider 假设变成运行时策略。

## 生产 runtime 与公开 exec / SDK

真实运行依赖由 `src/runtime/production.ts` 统一装配：provider、ReactAgent、Session 历史/附件、Skills、MCP、learned Memory、Goal、代码导航及原生 sandbox command executor 不再由 TUI 和 benchmark 分别拼装。Ink 只提供交互与显示回调；公开 `everpeace exec` 与 `everpeace/sdk` 的 `runTask` 通过同一 factory 和 `CodingTaskRunner` 运行，内部 benchmark 只保留 reviewed 参数与批准策略覆盖。这样共享的是生产行为，不把 benchmark adapter 暴露为公共 API。

exec 提供 CLI + JSONL，公开 SDK 提供相同非交互运行和事件的 TypeScript 接口，不挂载 Ink。每次调用创建正常可恢复 Session，模型先按注册 ID、再按唯一名称解析；CLI 提示词来自位置参数或非 TTY stdin。`--resume` 在相同工作区 fork 独立子会话，并保留 `session_resume` 的验证债务语义；`--plan` 只读输出计划，不自动批准或执行。所有需要用户的审批／结构化问题先保存配对结果，再以 `interaction_required` 结算。可选 token budget、deadline 和 step 上限覆盖完整 runner/repair 生命周期。默认 stdout 只保留最终正文，JSON 模式只输出脱敏白名单事件，并在任务清理后尝试发布唯一终态；帮助解析不得提前加载 keyring、MCP 或 TUI。

exec 输出接受消费端背压，正文完整保留并分块转义，助手/工具事件的异步回调向生产循环传递等待。Windows 非 TTY 标准管道由 CLI host 拥有的 writer 子进程负责写入，避免同步管道阻塞主循环取消与清理。管道失败或半条 JSONL 中断后不能保证终态可写，消费端同时检查退出码；具体大小与超时契约见 [STATE_AND_UI](STATE_AND_UI.md#非交互-exec)。

## Context compaction

`/compact`、阈值压缩和 context-limit 恢复共用供应商能力选择：官方 OpenAI 走声明的 native compact，DeepSeek/compatible 使用普通模型请求生成 summary。native 输出原样保留 retained/opaque item；summary 按完整 assistant/tool-result 边界压缩，保留最近两个完整单元与未闭合链，拒绝 incomplete、空白或未缩短结果。可见 timeline 不裁剪，context 仅在持久化成功后替换；失败或取消保留原 context。

自动阈值和 context-limit recovery 在模型压缩前先尝试一次 deterministic pruning。候选限定为早期、闭合、超过 8,192 Unicode 码点，并能在本 step 固定 EOF 下用 call ID、工具来源和脱敏正文摘要唯一解析的 tool result；最近两个单元、open chain、非工具/reasoning/opaque、Memory 和历史/续读结果保护。替代 JSON 保留 4,096 码点头部、1,024 尾部与稳定 `session_event_read` 引用，最多 32 KiB；不能唯一恢复的项跳过。该阶段要求持久 Session 历史服务；`context_pruned` 必须先落盘再替换有效 context，原始 append/timeline/附件不变，累计 usage 不变，只有当前 `context_tokens` 改为 unknown。裁剪后重新估算完整请求，足够小则省去 summary/native 请求，否则继续上述压缩。低压力、手动 `/compact` 和普通网络 retry 不触发该阶段。

阈值取 `min(窗口 × 80%, 窗口 − 实际输出预算 − 安全余量)`，安全余量为窗口 5%、最多 32K；未知窗口不自动按阈值触发。`context_compacted` 保留现有持久化渠道，压缩用量计入消耗但压缩后占用设为未知。明确 context-limit 的恢复每个 `runTurn` 最多一次，失败不转为普通采样重试。SSE 只有收到 `response.completed` 才算成功；首个事件之前明确拒绝 streaming 才允许 buffered fallback，半截结果不得启动工具。

Agent Loop 可靠性预算彼此隔离：普通采样重试默认最多两次，provider event-cursor 续接和 context compaction 各使用独立的一次性预算；半截 SSE 永不写入 context 或执行工具，续接失败回退到有界整轮重试。供应商请求仍默认 `parallelToolCalls=false`；宿主读取调度与该参数分离，生产中只允许 `read_file`、`list_directory`、`read_skill` 等明确声明安全能力的调用进入最多四项的任务池。调用并发执行但按模型顺序持久化，副作用工具和审批永不自动并行。批次、续接和 retry 分类事件只供当前 UI/诊断使用，不扩展 Session JSONL schema。

Agent Loop 的正常 follow-up sampling step 使用独立预算，默认每个 turn 最多 32 个逻辑 step；同一 step 内的网络重试、stream recovery 和 context compaction 不重复消耗该预算。达到上限时发出 `step_limit_reached` 并返回结构化 `step_limit`；可选的正整数 `maxTurnDurationMs` 到期时返回 `deadline_exceeded`。两类受限停止都禁止额外工具、采样、workflow 修复和 Goal 续跑，不伪造完成，也不新增 Session JSONL 事件。该边界参考 xAI 官方 function-calling 示例中的显式 step count 停止模式；不代表已验证 Grok Build 的内部 runtime。


## 有界历史显示

聊天渲染及 resize、恢复、命令返回重放按 Codex 的 terminal resize-reflow 行数上限选择尾部：VS Code 1,000、Windows Terminal 9,001、WezTerm 3,500、Alacritty 10,000、未知终端 1,000。`WT_SESSION`、`TERM_PROGRAM` 和 VS Code 注入环境用于检测。Ink 不提供最终布局的行数，所以按源文本、宽度、换行及常见双宽字符估算；单条超长记录保持原子显示。窗口起点变化后复用同步终端重放，清除已输出的旧 scrollback；不能仅对 Ink Static 数组 slice，否则终端仍有旧输出。完整内存 timeline、JSONL、context、输入导航和 outputs 不裁剪。上游普通 transcript 没有通用的记录数上限；上游 `INITIAL_HISTORY_TURN_LIMIT=5`、`HISTORY_ITEM_PAGE_LIMIT=100` 和扫描上限仅适用于其分页的远端 thread 历史加载，不迁移到本地 JSONL 恢复。


状态快照：2026-09-19。

## TUI 源码边界

`src/tui` 按职责分为 `app`、`commands`、`composer`、`rendering`、`terminal` 和细分后的 `components`，完整映射见 [TUI_STRUCTURE.md](./TUI_STRUCTURE.md)。根目录只保留公开 `index.tsx` 入口；`app` 负责状态机与依赖装配，conversation/feedback/navigation/screens/wizards 组件按用户流程归组，输入编辑、slash command、渲染算法及终端设置文件操作各自独立。此次只移动模块和更新导入，不改变 inline TUI、Session、审批、命令窗口或持久化语义；后续拆分大型 `app/app.tsx` 必须按状态所有权进行并单独补回归，不能按行数机械切割。

## 权限管理

权限实现详见 [PERMISSIONS.md](./PERMISSIONS.md)：`/permissions` 提供 `read-only`、`ask`、`workspace-write`（默认）和 `full-access` 四档 profile。模型 shell 分别映射到固定版本 Codex CLI 的 `:read-only`、`:workspace` 或 `:danger-full-access`，sandbox 初始化失败时禁止回退为宿主直跑。文件工具始终限定工作目录，内置网页工具保留独立开关，MCP 使用另一条审批面。用户策略跨重启持久化在平台配置目录，项目策略可选地放在 `.everpeace/permissions.json` 并以 fail-closed 方式合并；权限切换不重建 Agent 或丢失 context，也不写入 Session JSONL。用户直接 `!` 继续走原生 PTY，不进入模型 sandbox 或 context。

## Codex Sandbox、MCP 与 Skills

完整边界见 [CODEX_CAPABILITIES.md](./CODEX_CAPABILITIES.md)。sandbox 复用 `@openai/codex@0.155.1` 的平台后端而非复制 Rust 实现；Windows 模型 shell 固定用 PowerShell，其他平台用 Bash。MCP 复用 `codex mcp` 配置，以官方 TypeScript SDK 连接 stdio/Streamable HTTP，非 full-access 的 tools、resources、prompts 调用逐次审批。每个 server 独立监督断连、退避和关闭；断连立即撤下工具且不重放中断调用。list-changed 只有完整分页发现成功后才原子替换目录，step snapshot 通过 connection/definition binding 防止旧批准调用新能力；`/mcp` 重载配置并重置 supervisor。主机 Skills 扫描 Codex 项目/用户/admin/system 根，只把无名称冲突的 metadata catalog 预载到 instructions，显式 `$name` 在本轮完整注入，隐式匹配通过受路径约束的 `read_skill` 渐进读取。`/mcp` 是 transient 状态窗口；`/skills` 是不进入 session timeline/context 的多步管理向导，可在每次操作中选择项目或用户作用域，AI 创建单个 `SKILL.md`，或从公开 HTTPS GitHub/Git/SKILL.md/ZIP 来源先暂存、校验和预览，再明确确认安装。创建/安装不得覆盖任一发现根的同名 Skill，重复名称在解决前不得自动或显式调用。三者均不改变 JSONL schema；当前不包含完整 Plugin、OAuth、远端 Skill provider 或 managed-policy runtime，Skill 管理也不包含私有认证、更新或删除。

MCP 的发布单位包含完整定义和执行校验器。宿主通过 SDK 公共 request/schema 接口完成分页和调用，避免 SDK 的分页 metadata cache 改变旧目录的校验行为；output schema 与 execution metadata 同样进入 binding。资源、模板和提示采用 capabilities 注册的稳定入口与按需单页请求，不为列表更新引入缓存或订阅。要求 tasks 的工具显式标为 unsupported，不以普通调用代替。

可选 LSP 的可用性取决于有正对照的原生隔离证据，普通连接错误不能作为网络拒绝证据。证据限定本次 TCP/IPv4 目标；allowed 和 inconclusive 都不启动配置的 server。保持每次查询独立进程，Windows 探针仍允许连接时不提前启用 registry/pool，也不退回宿主运行。路径、UTF-16 与协议契约见 [TOOLS](TOOLS.md#可选-typescript-导航)。

Git Skill 来源采用 shallow、no-checkout 克隆：先读取有界 Git tree 和候选 `SKILL.md` metadata，同名打包副本按规范 `skills/<name>` 路径优先去重，预检候选文件类型、数量和字节数后才 sparse checkout。原始 `SKILL.md` 清单数与去重后的不同 Skill 候选数使用独立上限，100 个候选限制只对去重结果生效，避免同一仓库中的 Codex/评审镜像副本在实际候选未超限时被提前拒绝。该顺序避免 Windows 在无关深层路径上提前失败，也防止为了一个 Skill 展开整个仓库工作树；它不改变公开 HTTPS、无认证、超时、无覆盖和显式确认边界。

## Session 持久化

`/resume` 的批量删除是文件级永久操作：SessionStore 校验 ID、等待该 Session 的串行写入队列完成后删除 JSONL，不写入删除事件或回收站。当前活动 Session 被删除后由 TUI 清理内存状态并解除会话；未选中的 Session 与当前聊天不受影响。
- 每个 session 使用一个版本化 JSONL 文件，存放于平台应用状态目录；API Key 仍只进入系统 keyring。
- 可见 timeline 与 Responses API context 分开记录，保证恢复界面完整，同时不把直接 `!` 命令错误加入模型上下文。
- 写入按 session 串行追加；不完整末行可忽略，其他损坏只隔离对应文件。追加和当前 step EOF 捕获先在事务锁内恢复末行：完整有效的旧无 LF 事件补换行，无效 partial 截回上一 LF；超过 8 MiB 保留原文件并失败关闭。完整事件的原始字节和引用摘要不改变。
- `session_created` 保存模型引用、工作目录及 usage tracking 能力；`model_selected` 表达模型变化及是否重置 context；`usage_recorded` 保存每次主 Agent 响应的 token 增量。

Session 优化保持 JSONL 与 v1 输出附件格式：load/list/search 共用逐条字节流解析，摘要列表不构造 timeline/context；附件按页读取，输出定位缓存只保存有界 metadata。缓存命中仍证明日志身份、结果摘要和 call→result 来源，不能以性能优化绕过损坏记录、同工作区或文件改写检查。性能证据只反映宿主读取和临时占用，不能推导真实模型质量或 token 收益。

## Session 分支与 lineage

`/fork` 只接受当前空闲、源模型仍可用的本地 Session 已提交末尾。父 Session 锁内固定 EOF，内容和最多 16 份保留附件先复制到隐藏 staging，子输出目录准备后最后原子发布 JSONL；父子沿用相同 `output_id`，但持有独立文件。lineage 记录父 ID、fork 时间、源 EOF 与源 header 摘要，历史关系查询重新核验这些字段，父被删除时只把关系标记 unavailable，不使子副本失效。

分支不是运行状态克隆。子会话生成新 task ID，清零 usage/repair，清除 Goal、审批、undo、观察版本和旧验证成功；保留模型、context/timeline、聊天 Memory policy、标注继承的 TaskProgress、changed paths 与未验证债务。持久 `fork_pending_resume` 使首次及失败后的 coding 保持 `session_resume` 语义，直到宿主结算 `verified/no_changes`；Plan、查看、取消和失败不消耗它，也不触发父 Goal 续跑。

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

- `/plan` 是进程内严格规划模式，不写计划文件；只广告只读与规划工具，dispatch 拒绝编辑、Bash、MCP 和 Goal 写操作。公共指令与 coding／Plan 行为指令分开，Plan 不注入持续实施或完成活动 Goal 的行动要求。启用网页工具时，Plan 的公共 web 请求按只读联网能力免逐次确认；关闭网页工具仍然拒绝请求，普通聊天继续遵循当前权限档位。`request_user_input` 的 picker 同时用于普通 coding；等待不发模型请求，答案走普通 tool-result 持久化，且不能代替权限审批。
- Plan review 支持非空修订意见，随当前 `submit_plan` 配对结果先持久化，再请求完整替代稿；保留旧字符串决定兼容。批准仅在 runner 清理完成且未取消后形成绑定 Session／Agent 的进程内待执行正文，不恢复或 fork 批准。用户通过 `/plan execute` 消费完整正文并进入共享 coding runner；讨论、退出模式、成功会话变化或 Agent 替换使批准失效，失败会话操作保持原批准。Plan 排队输入返回草稿等待重交，不因批准／取消自动发新请求。审批界面 Esc／Ctrl+C 和迟到回调契约见 [STATE_AND_UI](STATE_AND_UI.md#plan-审阅与显式执行)。
- `update_plan` 整体替换最多 20 项的 model-authored TaskProgress；`task_progress_updated` 是 additive Session event，写入成功后才更新 UI。显式 resume、repair 与同一 runner 的 Goal continuation 保留投影，新用户任务先清空。每个 coding 请求重新注入当前投影，历史和压缩摘要不能覆盖它；`/tasks` 只读展示，任何清单状态都不授予 verified、Goal complete 或成功 Memory。
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

## 长任务历史与输出恢复

- 原始 `context_append` 保留可追溯历史，四个只读 Session 工具按需搜索当前及同工作区旧会话/直接父子关系，并查找仍保留的输出附件。普通 coding 与 Plan 均可使用；learned Memory 开关独立，不将旧全文自动注入主请求。
- 投影包含用户/助手正文和工具调用/结果，排除 reasoning、加密内容、developer 快照、Memory 结果、历史工具及续读自身结果。直接 `!` 属于 timeline，不能成为模型可查历史。历史只是不可信资料，不恢复文件观察、审批、Goal 或验证权。
- 当前会话边界按逻辑 step 固定且网络重试复用；旧会话在查询开始固定。引用绑定 Session、JSONL 字节位置、条目序号和内容摘要，追加不失效，删除或改写不可用。同工作区比较兼容 Windows 盘符与分隔符，不扩展父子目录和符号链接别名。
- 搜索流式有界：50 个结果、16 KiB 返回、30 秒、64 MiB 扫描、8 MiB 单条缓冲；达到限制或遇损坏记录明确 `incomplete`。不引入数据库或旧 JSONL 迁移。
- 输出正文先脱敏再保留和分页，版式脱敏与 Memory 共享凭据规则；Memory 的空白清理和字段裁剪保持原义。输出附件每份前 2 MiB、每会话最新 16 份，`session_event_read` 在 24 KiB 正文页之外还限制完整 JSON 为 32 KiB，必要时缩小正文页；工具预览 32 KiB、续读正文 24 KiB，超出保留范围标记 `retention_truncated`。旧进程内正文不重建。
- 并行阶段仅准备有界正文并计入背压；附件写入、结果引用追加、淘汰依模型调用顺序进行，并与续读、清理和删除共用 Session 跨进程事务锁。失败走 `PersistenceError`，dispose 保留已提交附件，删除 Session 清理所属附件，启动清理未被日志引用的崩溃遗留。
- 文件搜索、glob、Composer 和 rg 诊断 probe 统一惰性解析固定 `@vscode/ripgrep@1.18.0` 平台 optional package，通过绝对路径和 `--no-config` 运行；不采用系统 `PATH`，缺包或不支持的平台明确 unavailable。供应商参数、权限和验证门槛沿用现有契约。

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

benchmark 只作为协议变更证据，不是自动路由或近期重构理由。hooks、MCP OAuth/elicitation/tasks、Plugin/远端 provider、多 Agent 和外部 app-server 维持明确未实现边界，不用 no-op 或伪造成功暴露。公开 TypeScript SDK 已复用 exec 的生产任务路径，不扩展这些能力。

## 维护约束

- Agent 主循环采用 Codex 核心控制流程的 TypeScript 适配，位于 `agent-loop.ts`；`ReactAgent` 保留为供应商/工具/持久化适配层。逐工具结果持久化，主请求重试由循环控制，明确不等同完整 Codex runtime。来源和差异见 `AGENT_LOOP.md`。

- 功能、行为、接口或验证结果发生变化时，同步更新 `docs/PLAN.md`、本文件及 `docs/HANDOFF.md` 中受影响的内容。
- 根级 `AGENTS.md` 只保存跨 Session 长期有效的项目事实和工作约束；易变化的进度、验证结果及下一步统一记录在 `docs/HANDOFF.md`。


## Agent loop 交叉边界

- `hasPendingSteering` 只查看队列，`applySteering` 只在工具调用全部闭合后提交。guidance 保存成功才出队，响应完成后的 steering 也重建 step 并受同一正常步数上限约束。
- 广告工具、准入和能力来自隔离的 step snapshot；Plan 禁止操作不能通过模型返回未提供的工具绕过。实时权限继续在 dispatch 检查。
- `AgentTurnResult.stopReason` 为预算停止提供独立控制路径，`stopped` 不等同于 `completed`；TUI 不继续 workflow 自动修复或 Goal 自动采样。限额在收到 usage 后生效，不声称能提前预测单次请求消耗。
- 持久化失败使用 `PersistenceError`，不走网络重试，不降级为模型可继续处理的工具错误。存储事件类型保持兼容。
- 供应商 `parallel_tool_calls` 仍默认关闭；生产宿主独立启用内置文件/Skill 安全读取的最多四项调度。MCP 和审批全部串行，远端 metadata 不授予本地并发权限；共享资源键冲突和写调用形成屏障。
- 自动压缩按 step 准备一次；压缩 usage 累计到消耗，替换后的 context 占用标为未知，恢复 Session 也不把压缩消耗当作占用。
- SSE event log 只为 recovery adapter 保留，默认最多 8 MiB；超限释放恢复缓存且放弃当前响应续接，仍完整消费内容，失败走有界整请求重试。

## DeepSeek provider 与请求契约

- 供应商能力由 `ProviderCapabilities` 明确声明，来源与 SDK 方法是否存在分离。官方 DeepSeek、官方 OpenAI 和未知 compatible endpoint 都使用 Responses，但只有官方 OpenAI 声明原生 compact、加密 reasoning 和 prompt-cache 请求字段。
- 官方 DeepSeek 保留普通 reasoning item、function call/output 和 SSE 完整响应，主请求产品默认 `high` 与 32K 输出；供应商硬上限未知，`max` 原样发送。未知 compatible endpoint 不因模型名获得 DeepSeek 能力。
- `createProviderRuntime` 是主 Agent、标题、Skill 草稿、Memory 与摘要请求的统一入口。DeepSeek 请求会移除 `include`、prompt-cache、server-store 和并行参数，不依赖服务端 session、加密上下文或 cursor recovery。
- Session model ref 和模型注册表接受可选 `request_settings`，旧记录继续读取。跨供应商恢复时若 context 含加密 reasoning 或不透明 compaction，拒绝迁移并保留原 Session。

## 长上下文、usage 与终端控制

- 已知窗口的自动阈值取 `min(80%, window-outputBudget-headroom)`；headroom 为窗口 5%、最多 32K。真实 usage 与请求估算不混写为同一观测；阈值压缩在同一 history revision 上只执行一次。
- 官方 OpenAI 使用声明的 native compact；DeepSeek/compatible 使用模型摘要，最多 8K 输出，保留最近两个完整 assistant/tool-result 交互单元，不依赖用户消息数量。摘要明确区分宿主验证证据与模型自述，取消、失败或持久化失败不会替换原 context。明确 context-limit 每轮只恢复一次。
- 进入模型 context 的单项工具结果限制为 32 KiB；超限时返回含首尾、总字节数和持久 Session 附件的续读 ID 的有效 JSON，终端保留输出不因此缩小。
- Usage 独立累计输入、输出、reasoning、cache hit、cache write 和带缓存统计的输入分母。缺少 write 不抹掉 hit；缺失样本使完整性保持 partial。DeepSeek cache miss 不伪装成 cache write。
- `/reasoning` 只在任务间改变下一轮快照并随 Session 保存；`/doctor` 默认仅检查本地 Node、shell、sandbox 和配置，只有 `--live` 发出一次有界模型请求。`/status` 展示实际协议、压缩策略、推理档位及独立 usage。

## 最终验证新鲜度与诊断预算

- Repair attempt 只在宿主启动诊断轮时递增；同轮 patch 或快速检查失败不重复计数。第三个诊断轮后仍失败会阻止全部工具和 Goal 完成，只有新用户任务能重建工作流。
- Git tracker 分开仓库根和工作目录，status path 先按仓库根解释、再映射到当前工作区；兄弟目录不进入摘要。最终 suite 前后比较内容 revision，非忽略文件变化使结果过期，重新发现命令并最多补跑两次。
- 被忽略且未跟踪的构建产物不触发补跑；持续变化、追踪不完整、无检查、取消和环境不可用都保持未验证。退出码 0 只证明该次命令，不单独证明当前文件状态。

## 宿主文件观察、恢复债务与日常工具

- 结构化 update/delete 的写权限来自当前进程维护的文件观察表，而不是模型可选参数或恢复后的聊天文字。模型必须先调用 `read_file`；宿主把全文件 SHA-256 注入 operation，审批 preview 再绑定实际 before hash。Session 恢复清空观察表。create 使用排他写入，不要求模型先证明文件缺失。
- 多文件 patch 失败时只逆序回滚已经成功写入的项目，并先验证当前内容仍为宿主写入的 post-image。用户或其他进程随后改动的文件列入 rollback conflict，不得覆盖；`rolledBack` 只在所有已写文件确实恢复时为 true。
- Session 恢复重建进程内 tracker，但不调用新任务初始化。修复次数、blocked phase、changed paths 与 pending verification 保持；新用户任务可获得新预算，同时保留 prior-unverified 元数据。只有覆盖当前 workspace 的新完整验证可以清除这项债务。
- `/verify` 与自动 suite 使用相同的串行、取消、权限 revision 和 workspace revision 语义。无参数可结算完整 suite；显式单命令永远是 supplemental。无法把结果绑定到 Git 完整快照或当前结构化 checkpoint 时，状态为 unavailable。
- `read_file` 按行分页并返回全文件 SHA-256；搜索和 glob 直接参数化启动 ripgrep。超大 tool result 使用不透明 ID 读取 Session 持久附件，JSONL 仅保存有界 envelope；附件脱敏后每份最多 2 MiB、每会话最多 16 份。后台 shell 仍走现有 sandbox/权限，最多两个、默认十分钟、无交互 stdin，也不跨 Session 恢复。

## DeepSeek 请求 attempt 与压缩终态

- DeepSeek `max` 原样映射到 provider；32K 是产品默认输出预算，不冒充未知的供应商硬上限。主编码、摘要、标题、Skill、Memory 与 doctor 各有用途级 reasoning、输出、超时和终态要求，均关闭 SDK 内部自动重试，由宿主预算控制。
- 发起后失败且没有 usage 的 provider attempt 追加 unknown 样本；后续完整样本只能增加已知用量，不能把 Session 或 benchmark 恢复为 complete。Retry-After 最多接受 60 秒，可被 AbortSignal 中断；stream 连续 60 秒无事件按 incomplete 处理。
- summary cut 使用完整 assistant/function-call-output 边界，不依赖用户消息数量。最近两个完整单元和未闭合工具链保留；status 非 completed、有正文的半截响应、空摘要或序列化后未缩短均拒绝，原 context 只在持久化成功后替换。
- Thinking 只由实际 reasoning delta 开始，正文 delta 或响应结束关闭并显示独立 elapsed；没有可靠事件时继续使用通用 Waiting。

## 可复现对比边界

- 测试 CI 与发布 workflow 分开，在 Windows 和 Linux 上运行安装、typecheck、test、build 与 diff check。benchmark 外部进程 adapter 不使用 shell 拼接；dsh 固定通过 Node 启动已解析的 JS bin，并用 `--profile <reviewed-profile> --json <prompt>` 参数运行，避免 `.cmd` 与 shell 注入。重复运行必须使用 prepare hook 返回的独立 task；内置准备器只写入已确认不存在的目标目录，checkout pinned HEAD 后应用 reviewed seed，证明流程要求同一验收命令 seed 失败且 reference repair 通过。
- live benchmark 必须在每次 implement/diagnose attempt 前拥有正的 remaining token budget；usage 缺失或不完整立即停止后续任务。固定 catalog 的十项 fixture 已具备种子缺陷、参考修复与 pristine/seed/reference 离线证据。固定 dsh adapter 必须核对完整上游 commit，直接启动 checkout 内的 JS entry，并使用内容锁定的专用 profile 在 `llm/stream` 边界校验 coding 请求配置、按 attempt 计量和执行预算准入；不能从 headless 最终文本推测 usage。真实 API 评测未完成前仍不发布模型胜率结论。

## 性能计量与生产闭环

- TUI、公开 exec 和 benchmark 共用生产 factory 与 `CodingTaskRunner` 作为 coding 生命周期的唯一编排层。runner 负责 Agent turn、后台任务收束、最终验证、诊断轮、Goal 完成和 learned-memory outcome；benchmark adapter 标记 `managesRepairs`，评测器不再叠加第二套自动修复循环。
- Live 计量使用进程内 `RequestAttemptLedger`，边界是实际 provider attempt，而不是一次 Agent turn。coding、stream recovery、缓存能力降级和 summary 分开记录；reasoning 作为 output 的明细展示，不重复计入预算。任何已经发出但 usage 不可靠的 attempt 永久把当前账本标为 incomplete，后续成功不能清除，也不能继续发起模型请求。
- `RequestSnapshot` 是实际发送参数、输入估算、输出预留和 request/stable/dynamic 指纹的共同来源。快照在构建时深复制，避免后续输入变化污染测量，同时允许 SDK 在自己的请求对象上做兼容处理；DeepSeek 的固定指令和工具顺序位于历史前，动态权限及项目上下文位于历史后。摘要重放相同固定前缀和工具定义，但以 `tool_choice: none` 禁止工具执行。
- 宿主只读并发不依赖供应商 `parallel_tool_calls`。生产最多四项，只运行明确声明 read-only、idempotent、parallel-safe 且资源不冲突的调用；任一完成即可补位，尚未有序持久化的结果受数量和 4 MiB 总量约束。写入、shell、MCP、审批和未知能力保持串行。
- 性能 trace 只保存阶段耗时、次数和状态类元数据，不保存请求正文、文件内容、验证输出或凭据。记录 sandbox 子进程 spawn 前耗时与 assistant render callback 耗时；它们分别是启动边界和宿主交付成本，不冒充命令总耗时或终端实际绘制完成时间。首个 provider event/text 在 SSE 时来自真实事件；buffered endpoint 的对应时间是完整响应到达时间。
- 正式 fixture 必须同时具备 pinned source、setup、pristine assertion、reviewed seed/reference patch 和 evaluator-owned acceptance。正式 catalog 缺少任一材料即拒绝运行；suite 单独报告 planned、executed、skipped、stop reason 和统计完整性，预算停止或取消不得缩小成功率分母。
- 高频输出使用共享增量有界缓冲；TUI assistant delta 以 40ms 合并刷新，完成和取消立即清空。工作区 Git/显式路径合并后以四个 worker 指纹化，同一 snapshot 不重复读取同一路径。Goal 热路径使用成功持久化后的内存投影，Session 恢复时重新初始化。

## Coding capability 加固边界

- coding task 是后台进程的所有者。`start_background` 在创建时绑定 task signal；取消、权限收紧、预算停止、异常和 Agent dispose 都必须终止并等待进程树。cleanup 未完成时，runner 不得结算成功或开始下一项 benchmark。运行中输出只保留有界 preview，完成记录按数量和总字节淘汰，Session 恢复不伪造进程。
- 后台完成 callback 只携带 job ID、终态、退出码和时间，并受 runner invocation generation 限制；下一普通 step 通过 durable context 保存后才确认通知。运行 job 与未送达通知共用 20 个槽位，任务结束关闭准入并丢弃余项，通知不唤醒 Session，输出仍由 `poll_background` 获取。
- 搜索 continuation 只在 Agent 进程内保留最多 16 个搜索和 8 MiB 序列化 UTF-8 payload，按创建顺序淘汰；读完最后一页或 dispose 立即释放。单次 ripgrep 的 2 MiB 输入限额同时计算未终止记录，`has_more` 与 `incomplete` 保持不同含义。
- `CodingTaskRunner` 是最终结算的唯一入口。验证完成后、Goal/Memory 写入前必须重查取消；异常路径统一拒绝待完成 Goal、停止后台作业并以 failed/stopped 结算学习。benchmark 必须返回 runner 的真实终态、workflow outcome、诊断轮和首次 suite，独立 acceptance 不能把 stopped/预算失败改写成整体成功。
- provider request 通过 `RequestExecutor` 在实际 attempt 边界准入和结算。已发送但没有可靠 usage 的 attempt 使对应 task/campaign 永久 incomplete；被预算或 incomplete ledger 拒绝的 attempt 记录为 rejected，但不伪造 provider 消耗。coding 与 auxiliary 累计分开显示。每个 stream attempt 拥有独立 AbortController，iterator 和 transport 关闭前不得启动 retry。
- 文件版本的规范表示是原始字节 SHA-256。`read_file`、patch preview、执行、审批绑定和 rollback 使用同一摘要；文本编辑解码 UTF-8 后保留 BOM 和原有 LF/CRLF。模型读取到的正文规范化仅用于展示，不能成为并发保护的 hash 来源。
- 项目规则是 workspace root 到目标目录的 `AGENTS.md` chain。宿主保存 scope、content hash、诊断和 target revision；新 scope 或更新未到达模型时拒绝结构化 edit 并要求下一 sampling boundary。规则 revision 通过现有 context channel 持久化，但请求只采用当前 workspace snapshot，历史快照不能在 compaction 后重新取得权威。
- 搜索 continuation 引用进程内有界 snapshot，而不是重复运行可能变化的查询。默认每页 100、最大 200，单次 retained data 最多 2 MiB/5 秒；`has_more` 只表示已有下一页，`incomplete` 要求缩小查询。
- TypeScript semantic navigation 是显式配置的只读能力。未配置 LSP 时不广告工具，也不自动安装；同一 workspace 串行查询当前磁盘文本，使用 1-based UTF-16 坐标，30 秒/100 locations 上限。每次查询通过 pinned native backend 的 dedicated read-only duplex 进程运行，application state/workspace write 不随 full-access 放开；配置的 server 启动前必须在相同策略中通过 direct-socket denial probe，失败时报告 unavailable 并保留 lexical search。取消或权限 revision 变化必须终止并等待清理。所有 server edit/command request 均拒绝，navigation 结果不授予 edit observation。平台 ambient system read 与 temp grant 单独记录，不包装成绝对文件隔离。固定 Windows backend 当前未通过 network probe，因此失败关闭。
- 模型完整变更审阅复用 `/diff` 的结构化 Git 服务，通过进程内 captured snapshot 与 opaque detail reference 分页；staged/unstaged/untracked 分组及 overlap 保留，刷新使旧引用过期。审阅不进入 `read_file` 观察表，不授予写权限，也不建立变更归属。replace 默认精确唯一匹配；显式 line_whitespace 仅在精确未命中时匹配唯一完整行块，容忍边缘空格/Tab，保留行内文本、空行和原字节审批绑定，预览/结果显示实际方式与行范围；不增加模糊匹配或批量同文件替换。
- 项目地图是按需、每次新生成的工作区观察，不是规则、写观察或持久索引。随包 rg 有界枚举并遵守 ignore、不跟随链接；只解析受限 Node manifest 元数据，入口声明和文件名候选分开，其他语言只标记 manifest。共享 coding/Plan 工具无需每轮扫描或注入地图。
- 非 TTY exec 输出在 Windows/Linux 统一隔离到宿主管理的 writer 子进程；每块流写入完成才 ACK，父进程控制停滞/取消，等待 pending write、代理 close 与进程退出后才移除监听器。TTY 保持现有路径，半条 JSONL 不补终态，不以强制宿主退出或放宽回归超时掩盖资源泄漏。
- benchmark campaign 先持久化带 seed 的完整计划，再发出 live request。fixture 必须有 pinned source、setup、pristine assertion、reviewed seed/reference 和 evaluator-owned acceptance；评分在隔离材料上执行。baseline/candidate 使用命名 checkout、revision 与 source/build digest，并由同一个 fresh-process worker 动态导入 production adapter；请求准入固定 raw model ID、high reasoning 和 32,768 output tokens。`--preflight`、`--prove-fixtures`、`--live` 互斥，preflight 不读取 credential storage、不产生 scored result。外部 harness 必须在 LLM boundary 提供结构化 usage 与配置确认，不能从最终文本推断。真实请求仍需要独立显式授权和数值预算。
- 不创建远程 tag/Release 的版本交付使用 Release workflow 专用 `[skip publish]` 提交标记；Test workflow 不读取该标记，仍在 `main` push 上执行 Windows/Linux 门禁。tag push 始终允许 Release workflow 运行。
