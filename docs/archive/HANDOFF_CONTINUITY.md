# 任务连续性与工具反馈：历史交接

归档日期：2026-10-08。对应已推送提交 `77b3cb5dcb36247e5dba3f1425546ca9c2a9cf2b`。以下是上一轮交接与计划，历史验证不能替代新一轮证据。

# 当前交接

更新日期：2026-10-08。新 Session 先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 选择专题。本文件只保存当前状态；此前完整记录见 [历史交接](HANDOFF_HISTORY.md)。

## 当前基线与范围

- 产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI；包版本为 `0.3.9`，双语 README 展示同步。
- 本轮开始时 `main` 的实际 HEAD 为 `0052d4b7e292b9176a796f770d449582645de090`；比较参考固定为 DeepSeek Harness `639ed015397290b3745d163aafe02ffee4aa3f84`。旧交接中的提交、授权和验证证据已归档，不能作为本轮证据。
- 用户授权结构化压缩交接、当前工作流上下文和内置工具失败反馈，仅离线优化；随后明确授权更新版本、提交与推送，但不更新 Release。只推送 `main`，使用 `[skip publish]` 保持 Test CI 并跳过分支发布 job，不创建或推送 tag，不创建或更新 GitHub Release。不调用真实模型；默认 `high`／32,768 输出预算、原生 sandbox 和宿主验证规则不变。
- TUI、exec、SDK 和 benchmark 复用共享 production factory／runner；MCP、LSP、多 Agent 和新协议不扩展。

## 已完成能力

### 编码任务连续性与工具反馈

- [conversation-checkpoint](../../src/agent/conversation-checkpoint.ts) 规定八章摘要交接，assistant 背景回注；旧 developer 摘要仅在请求投影中转换，Session 原日志不改写。`/context` 以 `model_checkpoints` 计数和英文模型交接标签展示。
- 连续压缩指令要求合并旧交接与新证据、淘汰过时内容，保留精确路径、命令、错误和恢复引用。保留最近两个完整交互单元，不拆并行工具 batch。缺章／重章／乱序／空章、空白／未完成／未缩小摘要以及取消或落盘失败保留原 context，不追加模型修复请求；已发出 usage 仍结算。
- [workflow model context](../../src/workflow/model-context.ts) 从共享 production IO 提供每 step 冻结的任务来源、phase/result、待验证和 tracking 状态、修复次数。coding retry 和自动压缩复用快照，手动压缩读取当前宿主事实。历史债务也投影为待验证；缺字段不推断成功，摘要和清单不能改变结算。不新增 Session 事件或保存敏感 workflow 正文。
- [tool feedback](../../src/tools/tool-feedback.ts) 为内置文件／搜索、shell／后台和 patch 的已知失败提供错误码与修正提示。参数检查先于目标读取／进程启动；权限拒绝不得绕过；超时保留部分输出，先检查副作用。分类仅用显式类型／状态，不猜测未知异常、不自动重放。

### 历史与持久输出

- [session-outputs](../../src/storage/session-outputs.ts) 为每个 Session 保存不可变、脱敏的工具输出附件。模型只见 opaque ID；内联预览最多 32 KiB、每页续读最多 24 KiB、每项保留前 2 MiB、每会话保留最近 16 份，范围外明确 `retention_truncated`。
- [context-limits](../../src/agent/context-limits.ts) 在并行阶段只准备有界正文和预览，待提交字节计入背压；按模型调用顺序执行附件写入、日志引用追加和旧附件淘汰。附件或日志失败通过 `PersistenceError` 停止后续工具和 provider 请求。
- Session 队列与跨进程事务锁协调追加、附件提交/读取/淘汰、启动 orphan 清理和删除。Agent dispose 不删除附件；删除 Session 才清理所属正文。重启复用原 ID，已经丢失的旧进程内正文明确不可用。
- [session-history](../../src/storage/session-history.ts) 提供 `session_search`、`session_event_search`、`session_event_read` 和 `session_relations`；`read_tool_output` 支持可选 `session_id`。只允许完全相同的规范化工作区，Windows 盘符与分隔符等价，不扩大到父子目录或符号链接别名。
- 历史投影来自原始 `context_append`，排除 reasoning、加密内容、developer 快照、Memory、历史/关系/续读工具结果及直接 `!` 输出。引用绑定 Session、header、日志位置、条目和摘要；追加保持有效，删除、替换、改写或篡改不可读。
- 当前 step 和旧 Session 查询分别冻结已落盘 EOF。扫描最多 50 项、16 KiB 搜索响应、30 秒、64 MiB，单条记录最多 8 MiB；损坏或超限明确 `incomplete`。历史读取不能恢复文件观察、审批、Goal 完成或验证成功。
- 历史和 learned Memory 是独立能力。Memory 开关不影响历史工具，也不会把旧历史自动提升为长期经验或整段注入请求。
- Session 恢复、列表和搜索投影逐条解析 JSONL 并折叠状态，避免整份字符串、split 数组及全部事件数组重复物化。旧记录、有效无换行末行、损坏中间记录及未完成尾行语义保留；恢复不新增 8 MiB 记录限制，历史查询仍保留自己的扫描限制。
- 历史输出定位使用最多 256 项 metadata LRU，不缓存正文。缓存命中仍检查固定 EOF、工作区、header、文件身份、原结果摘要及完整 call→result 区间；来源覆盖、Memory/历史排除、损坏和扫描预算不能由缓存绕过。追加保留旧定位，删除、替换、改写及读取期间变化触发重验或失效。
- v1 附件不迁移。范围读取先读最多 4 KiB header，核对引用 metadata、文件身份和精确文件长度，再读取所需页与 UTF-8 边界余量；事务锁、取消、期限、淘汰/删除竞争及 24 KiB 正文／32 KiB 转义后响应限制不变。脱敏仍发生在保存前，不对分页重新脱敏。

### MCP 自动恢复与随包搜索

- [MCP runtime](../../src/mcp/runtime.ts) 为每个 server 维护 `connecting / reconnecting / ready / failed`。瞬时启动失败或断连以 500 ms 起步、30 秒封顶的指数退避重试最多十次；连接稳定 30 秒才清零计数。永久配置、认证或 executable 错误直接失败。
- 断连立即从目录移除该 server 的 callable，并先关闭旧 client；五秒内不能确认关闭就停止自动恢复。退出、工作区切换和 `/mcp` refresh 取消旧 generation 及 timer，迟到回调不能复活连接。默认 TUI 在正常退出及启动失败时等待 dependency dispose，关闭活动 Memory runtime 和共享 MCP runtime；清理失败仍恢复终端模式。业务错误、单次超时和用户取消不触发重连；中断的工具调用不自动重放。
- `notifications/tools/list_changed` 以 50 ms 合并，完整分页发现后原子替换目录。刷新失败保留上一份完整目录，真正断连则移除；最多 100 页、1,000 个工具、2 MiB 定义，重复 cursor/name 或超限明确失败。
- `McpSnapshot` 同时冻结定义、annotations/审批 metadata 与连接/定义 binding。普通网络 retry 复用当前 step 快照；工具删除、重连或定义变化后，旧 binding 返回 stale/unavailable，不能在审批等待后转发到新能力。
- 分页工具发现使用 SDK 公共 `request` 和 result schema，宿主持有整份定义、独立 output validator 和 execution 支持判定，完整发现及编译成功后原子发布。binding 覆盖输入/输出 schema、description、annotations 和 execution；刷新失败保留旧目录与校验器，已发送调用按 dispatch 时冻结的定义校验，失败不重连或重放。完整发现共享一个总 deadline。
- required-task 工具不广告，`/mcp` 明确显示不支持；optional-task 可以普通调用。initialize capabilities 分别决定 tools/resources/prompts，resources-only、prompts-only 和 instructions-only server 可以 ready。
- `list_resources(cursor?)`、`list_resource_templates(cursor?)`、`list_prompts(cursor?)` 每次实时请求一页，返回来源及 `next_cursor`。单页最多 1,000 项／1 MiB；超限返回明确范围错误且不给部分条目或跳项续点。游标原样传递，返回相同非空游标拒绝；过期游标要求重新列举，不承诺跨页快照一致。read/get 保留文本、来源和 mimeType，图片/音频/blob 仅返回类型说明，不注入 base64；无资源订阅或目录缓存。
- [ripgrep resolver](../../src/tools/ripgrep.ts) 惰性解析 `@vscode/ripgrep@1.18.0` 的绝对二进制路径，search/glob、Composer `@` 候选和 doctor 都传 `--no-config`，不读取系统 `PATH` 或用户 rg 配置。缺少匹配 optional package 时明确 unavailable；Windows/Linux CI 不再显式安装系统 rg。

### Agent runtime identity

- 每个 coding request 的动态 instructions 都包含宿主确认的 Everpeace agent 身份、实际 provider、模型原始 ID、Responses 协议和当前 workspace/cwd；模型用这些事实做自我定位，工作区文本不能重新定义这些身份字段；这些值不是工作区内容，不改变权限，也不进入 Session JSONL。
- provider、model 和 cwd 在插入 instructions 前以 JSON 字符串编码，换行和控制文本不能伪装成新的宿主指令。
- ReactAgent 将传入的 workspace/cwd 规范为绝对路径后再用于工具、规则加载和 runtime identity，避免相对工作目录造成自我定位歧义。
- `/context` 的最近请求快照复用同一份宿主事实，显示 runtime agent、协议和 workspace/cwd，帮助用户核对模型看到的 checkout；快照仍是内存诊断，不从历史恢复。

### 公开 `everpeace exec`

- [CLI](../../src/cli/commands/exec.ts) 暴露 `everpeace exec [prompt] [-C <directory>] [--model <id-or-name>] [--json] [--token-budget <n>] [--timeout-ms <n>] [--max-steps <n>]`。提示词来自一个位置参数或非 TTY stdin，二者同时提供或都缺失均为参数错误；管道输入最多 8 MiB。
- 模型先按注册 ID、再按唯一模型名解析；省略模型只允许恰好一个凭据可用模型。帮助路径在 registry/keyring、MCP 和 TUI 之前返回。
- [production factory](../../src/runtime/production.ts) 由 TUI、exec 和 benchmark 共用，统一 Session、历史附件、Memory、MCP、权限、sandbox、workflow、预算、验证和清理。通过启动阶段的 exec 任务创建正常 Session，标题来自首条非空提示行，之后可由 TUI `/resume` 打开。
- exec 读取已有 learned Memory，但固定关闭本次自动 capture。`--resume <session-id>` 把同工作区 Session 分支为独立子副本并恢复其 context、workflow、TaskProgress 与已保存模型（`--resume` 与 `--model` 互斥，模型注册变化或凭据缺失属于参数错误）；子副本在续跑结算为 `verified`/`no_changes` 后清除 `fork_pending_resume`。支持只读 --plan，并将提交计划作为输出，绝不自动批准执行；审批或结构化问题先保存配对结果，再以 `interaction_required` 停止并清理。
- token budget 覆盖主请求、压缩、retry 和 repair；timeout 与 max steps 也跨全部修复轮共享。默认 stdout 只写最终助手文本，stderr 写进度和宿主验证摘要。
- `--json` 在 exec 输出层初始化后输出 schema 1 的脱敏 JSONL：`session_started`、`assistant_message`、`tool_started`、`tool_finished`、`workflow_updated`、`interaction_required`，以及清理后唯一的 `run_finished`。不导出 reasoning 正文或原始 provider response；终态 usage 可含汇总 reasoning tokens。顶层参数语法或模块启动错误发生在 JSONL 启动前；EPIPE 无法补写终态。退出码为 `0` verified/no_changes、`1` 运行/清理/EPIPE、`2` 参数/启动配置、`3` failed/unverified、`4` 预算/usage/step/deadline、`5` 需要交互、`130/143` 信号。

exec 本轮进一步增加可等待的助手和工具交付：工具开始在 dispatch 前、结束在结果落盘后交付，provider 流式进度回调仍同步。输出失败停止后续工具与请求，但补齐已落盘调用的取消/跳过结果；持久化失败保持停止语义。

stdout/stderr 使用有序 writer，编码块最多 16 KiB、待写编码总量有界于 1 MiB，处理 callback、drain/error/close 与 30 秒无进展。助手完整脱敏后增量 JSON 转义写出，移除 64 KiB 正文截断；其他事件整行最多 64 KiB，省略展示字段时给出 `truncated`、总数等信息。Windows 非 TTY pipe 由 CLI host 拥有的惰性 writer 子进程写入，有界 IPC 确认使父进程保持取消/计时可用，退出等待回收。半条 JSONL frame 已写出后的通道失败或取消不能补写可靠终态；清理后且通道可用时才输出一次 `run_finished`。

### Session 分支与关系

- TUI 增加 `/fork [title]`，只在当前本地 Session 完全空闲且源模型仍可用时接受。[SessionStore.fork](../../src/storage/session-store.ts) 在父锁内固定 EOF，流式复制日志和最近最多 16 份附件到隐藏 staging；先发布独立子附件目录，最后原子发布子 JSONL，失败或取消不切换 UI 且清理未发布内容。
- 子 Session 保留模型、timeline/context、聊天 Memory policy、带继承标记的 TaskProgress、changed paths 和未验证债务。它生成新 task ID，usage/repair 归零，清除 Goal、审批、undo、文件观察和旧验证成功证据；同名 opaque output ID 对应父子各自拥有的附件。
- lineage 保存父 ID、fork 时间、源 EOF 和 header 摘要。`session_relations(session_id?)` 在同工作区返回直接父子并重新验证这些字段；父被删除、替换或缩短时标记 `available: false`，子副本及附件继续独立可用。
- 子 Session 持久保存 `fork_pending_resume`。首次及任何未结算后的普通 coding 输入使用 `session_resume` 语义；只有任务以 `verified` 或 `no_changes` 结算才清除。Plan、查看命令、取消、异常、限制停止及 failed/unverified 都不消耗该状态，也不会续跑已清除的父 Goal。

### 压力触发的无模型裁剪

- [ReactAgent](../../src/agent/react-agent.ts) 在自动压缩压力或一次 context-limit recovery 时，先冻结当前 step 历史 EOF，并至多尝试一次裁剪。低压力、手动 `/compact` 和普通网络 retry 不触发。
- 候选必须是较早、闭合、超过 8,192 个 Unicode 码点的工具结果，并由持久 Session 历史按 `(call_id, tool_name, 脱敏正文 SHA-256)` 唯一解析。最近两个完整交互单元、open chain、非工具/reasoning/opaque、Memory、Session 历史/关系及 `read_tool_output` 结果受保护；来源歧义、日志损坏或扫描不足时跳过。
- 替代 JSON 保留前 4,096、后 1,024 个码点、`session_event_read` 引用及已有截断 envelope 的恢复字段，总量最多 32 KiB，并且必须实际缩小完整请求。
- `context_pruned` 必须先写入 Session，成功后才替换有效 context。原始 `context_append`、timeline 和附件不改写；累计 usage 不变，只有当前 `context_tokens` 设为 unknown。重新估算后足够小则跳过 provider summary/native compact，否则继续既有压缩。

### LSP 宿主边界与原生门禁

- [code-navigation](../../src/tools/code-navigation.ts) 在读取输入及接受返回位置前检查规范工作区与 denied roots，包括 symlink/junction 和 Windows 路径等价；导航不产生写观察，不接受 server 编辑或命令请求。
- 校验 UTF-16 坐标、操作 capability 与 open/close 同步，不支持则明确不可用；hover 截断保持有效 UTF-8，production factory 与 TUI 统一 permission revision。
- 固定 Windows backend 的原生 fixture 加入宿主正对照。实测正对照通过，隔离进程也能连接非 loopback 的 TCP/IPv4，结果为 `allowed / connection_succeeded`；工作区写入及应用状态读取仍被拒绝。doctor 显示结构化证据，不把任意 socket error 当作拒绝证明。
- 网络门禁失败，Windows LSP 继续 unavailable；未更换 sandbox 或宿主直跑，未实施条件后置的 lsp.json、通用 registry/pool。实际覆盖仅为 TCP/IPv4，不声称 IPv6 或全部网络协议受阻。

## 验证状态

本轮定向离线回归已覆盖摘要结构、最新纠正、连续压缩、并行工具边界、旧摘要投影、无效摘要／取消／落盘失败、workflow retry 冻结、恢复债务／预算停止和工具错误反馈。共享 production 集成场景贯通规则刷新 → 盲写拒绝 → 快速检查失败 → 压缩 → fork／重启 → 重新读取 → 修正 → runner 完整验证；父 Session 保持失败，子 Session 独立结算。

更新展示版本后的交付检查使用 Windows Node `v22.19.0`／`pnpm@10.22.0`，按 typecheck → lint → test → build 顺序执行：`pnpm typecheck` 通过；实际 scripts 中没有 lint，明确记为缺项；`pnpm test` 共 743 项，740 通过、0 失败、3 跳过，耗时 52,566.8104 ms；`pnpm build` 通过。跳过项分别为当前文件系统不允许的 file symlink、由 clean-checkout CI 覆盖的 Windows 临时目录 alias 和 Unix-only timeout。`git diff --check` 与本轮新增文件空白检查、本轮文档链接检查通过。

默认外层隔离进程不能初始化两个 Windows 原生 backend fixture，首次全量检查首败后停止，没有继续构建。诊断同时修正 Composer 对字段化参数错误的兼容提示、project-context 的旧 free-text fake 摘要，以及 benchmark 将 Git 快照时间计入 90 ms 墙钟阈值的不稳定断言；新的 timeout 测试直接证明 runner 在 adapter 未完成时返回超时，不修改生产超时逻辑。定向兼容回归 42 项全部通过；随后在获准的宿主进程中执行原生 sandbox 回归，10 项全部通过，再重新执行上述完整门禁；模型 shell 的 sandbox 路径与失败关闭规则不变。

最终全量测试日志位于本机临时目录 `everpeace-continuity-0.3.9-delivery-test.log`，不纳入仓库。交接消息的 assistant 文本输入通过本地 Responses SDK 的 `EasyInputMessage` 类型检查。补齐压缩请求的工作流事实后，摘要／工作流／production 连续性定向回归 9 项全部通过，再执行最终完整门禁。定向启动时 `pnpm exec tsx` 在当前 Windows shim 环境未解析成功，已使用同一 Node 22 工具链的 `node --import tsx --test` 执行；没有修改依赖或工具链配置。

交付提交使用 `feat: preserve task continuity and actionable tool feedback [skip publish]`。已核对 [Release workflow](../../.github/workflows/release.yml) 仅在分支提交不含该标记时运行发布 job；tag push 不受标记保护，因此本轮只推送 `main`。独立 [Test workflow](../../.github/workflows/test.yml) 不读取该标记。推送前已通过 GitHub API 保存现有 Release 元数据基线，以便核对没有新增或修改 Release。

所有模型请求使用 fake provider，不读取用户 keyring／模型凭据、不发送 live 请求；离线机制验收不能证明真实 DS 成功率、缓存命中或 token 成本改善。真实 Windows Terminal 恢复、分支、取消、resize／scrollback 与单 prompt 仍待手工验收。旧 native sandbox／benchmark preflight／fixture proof 与宿主性能结果见 [历史交接](HANDOFF_HISTORY.md)，不作为本轮新验证。

## 当前限制与后续

1. `@vscode/ripgrep` 只覆盖 Windows x64/arm64/ia32、macOS x64/arm64 及 Linux x64/arm64/arm/ia32/ppc64/riscv64/s390x；其他平台或禁用 optional dependency 时搜索明确 unavailable。
2. MCP 资源/模板/prompt 已支持按需分页，但没有订阅、目录缓存或跨页快照保证；OAuth、header helper、elicitation、sampling、task execution 和按工具持久审批尚未接入。
3. exec 已有 `--resume` Session 分支续跑、只读 `--plan`（提交计划作为输出，绝不自动批准执行）和 `--permission-mode` 单层收紧覆盖（永不 `full-access`）；公开的 `everpeace/sdk` TypeScript 入口 `runTask()` 复用同一 exec runtime 与默认系统 registry/SessionStore，不提供自动交互批准。JSONL 是公共自动化面，不等同于 ACP 或通用 app-server。
4. 分支只接受空闲本地 Session；它不克隆审批、观察、undo、Goal 或验证成功。历史/关系读取不会授予写权限。
5. 裁剪要求可用的持久 Session 历史和唯一恢复证据；不满足时沿用现有压缩。离线 fixture 不能证明真实模型质量或 token/速度提升。
6. Windows LSP 因固定 native backend 实测允许 TCP/IPv4 而保持 unavailable；共同后端升级候选与网络回归须独立处理，门禁通过后才实施配置和通用池，不回退宿主直跑。
7. 真实 API smoke、正式 dsh 比较和性能/token 统计仍需另行授权及 task/campaign 数值预算。

## 用户已有差异

本轮开始时 tracked 差异为空；已有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，不纳入实现或清理。



# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据见 [HANDOFF](../HANDOFF.md)，机制见 [知识库](../README.md)，此前计划见 [PLAN_HISTORY](PLAN_HISTORY.md)。

## 当前里程碑：个人开发任务连续性与工具反馈

用户授权离线实施，参考固定 DeepSeek Harness `639ed015397290b3745d163aafe02ffee4aa3f84`；随后明确授权更新展示版本、提交与推送，但不更新 Release。只推送 `main` 并使用 `[skip publish]`，不创建或推送 tag；不调用真实模型，已有未跟踪内容保留。默认模型参数、Responses、原生 sandbox 和 runner 成功判定不变。

- [x] 固定八章摘要交接，assistant 背景回注，旧摘要请求投影兼容与 /context 展示。
- [x] 完整交互边界、连续压缩及无效摘要保留原 context；不追加摘要修复请求。
- [x] 共享 production IO 提供当前工作流事实，每 step 冻结、retry 复用，保留恢复与历史验证债务。
- [x] 文件／搜索、shell／后台和 patch 的显式错误分类及修正提示，保留超时部分输出与不重放边界。
- [x] fake provider 和临时 Git 工作区验证失败反馈 → 压缩 → fork／重启 → 重新读取 → 修正 → 完整宿主验证。
- [x] 更新运行时、工具、决策和双语说明，修正 exec Plan 矛盾，归档旧交接证据。
- [x] 最终重新发现并串行执行现有 typecheck → lint → test → build，首败停止；记录缺少 lint，并检查差异／本地链接。

## 验收与独立后续

回归证明宿主机制与持久化边界，不证明 DS 摘要语义完整性、真实编码质量或 token 节省。真实 Windows Terminal 手工验收继续独立待办；Windows LSP 不可用原因仍为固定 backend 网络隔离门禁失败。MCP 扩展、LSP backend 升级、多 Agent、新协议不在本轮。

真实模型 smoke 和 dsh 对照仍需另行明确授权及 task／campaign 数值预算。Goal 与成功 Memory 只由宿主验证结算，不以摘要或执行清单代替。
