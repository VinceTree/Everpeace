> 历史归档：下文保留整理前记录，不代表当前状态或执行授权。当前入口见 [知识库](../README.md)、[HANDOFF](../HANDOFF.md) 和 [PLAN](../PLAN.md)。

## 2026-10-02 后续四项功能实施计划（已完成）

在首期历史与输出恢复之后，用户明确授权按以下顺序实施，保持 Windows 优先、单 Agent、Node/TypeScript、inline TUI 及原有模型默认值、权限和宿主验证：

1. MCP 每 server 独立恢复、工具目录热更新和 step binding；断连不重放中断调用。固定 `@vscode/ripgrep@1.18.0`，所有应用内搜索从包内绝对路径以 `--no-config` 运行。
2. 公开 `everpeace exec`，使用 CLI + JSONL、可选 task token budget、deadline 和 step 上限；TUI、exec、benchmark 共用生产 Agent factory 与 `CodingTaskRunner`。
3. 增加空闲本地 Session 的独立 `/fork [title]`、lineage、持久待继续状态及同工作区 `session_relations`。
4. 在自动压缩压力或 context-limit recovery 时，先尝试有持久历史恢复引用的确定性工具结果裁剪；不足时继续既有 provider 压缩。

实施验收要求覆盖 MCP stdio/HTTP 重连、关闭竞态、通知分页和旧 binding；无系统 rg 与缺平台包；exec 修改→验证失败→修复、参数/模型/交互/预算/信号/EPIPE/JSONL；分支父子独立、重启/淘汰/删除、pending resume；裁剪 Unicode/CRLF/幂等/缺失正文/持久失败/重启恢复。最终串行门禁和真实 Windows Terminal 手工验收分别记录，离线 fixture 不作为真实模型性能结论。

这四项的最终机制已写入当前架构文档；本节只保留当时范围，不代表后续授权或验收状态。

## 2026-10-02 后续四项功能实施之前的快照

# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前提交、版本和执行证据见 [HANDOFF](../HANDOFF.md)；过去阶段完整保存在本文件。

## 本轮：长任务历史与输出恢复

比较基线为本轮开始的 Everpeace checkout 与本地固定的 DeepSeek Harness 官方 checkout，具体 revision 见 HANDOFF。目标是压缩或重启后按需找回当前及同工作区旧会话中的决策、操作和保留输出，并继续宿主验证。本轮不改变模型默认参数、权限、压缩策略或宿主验证规则。

- [x] 每会话独立的输出附件，保留 opaque ID；32 KiB 内联预览、最多 24 KiB 续读正文、前 2 MiB 保留、最近 16 份附件。超出保留范围显示 `retention_truncated`。
- [x] 并行阶段只准备有界正文和预览，计入背压；按模型顺序执行附件写入 → 日志引用追加 → 淘汰。保存失败复用 `PersistenceError`，跨进程事务锁保护提交、清理和删除；dispose 不删附件。
- [x] 提供 `session_search`、`session_event_search`、`session_event_read`，从原始 `context_append` 流式建立只读投影并检索仍保留的附件。旧 JSONL 不迁移，不建立数据库。
- [x] 同工作区精确作用域，Windows 盘符和分隔符等价；不扩展到父子目录或符号链接别名。当前 step 固定已落盘 EOF，普通重试复用；旧会话固定查询开始时的 EOF。
- [x] 排除 reasoning、加密内容、developer 快照、Memory、历史检索/续读自身结果和直接 `!` 输出；历史不能恢复观察版本、审批、Goal 完成或验证成功事实。
- [x] 引用绑定会话、日志位置、条目序号及摘要；追加保持有效，删除、改写及篡改返回不可用。扫描限制为 50 个结果、16 KiB 搜索响应、30 秒、64 MiB 扫描、8 MiB 单条缓冲；不完整须提示收窄查询。
- [x] 生产 TUI 与内部 benchmark runner 注入历史和附件服务，coding 与 Plan 都可只读使用。保持 Learned Memory 独立；不自动注入整段旧历史。
- [x] 保存、搜索和分页前使用保留换行/缩进的脱敏；修复 UTF-8 极小页不前进，并约束转义后的完整分页响应不超过内联上限。所有应用内 ripgrep 调用增加 `--no-config`。
- [x] 同步双语 README、架构与交接，补 fake-provider 恢复链路、作用域、旧日志、持久失败、并行/取消、淘汰/竞争、脱敏和扫描边界回归。
- [x] 最终串行 `typecheck → test → build`、本轮差异检查；结果见当时 HANDOFF。
- [ ] 真实 Windows Terminal 验收恢复、取消、resize/scrollback 与单 prompt；自动化不替代此项。

旧会话仍能打开。早期进程内 output ID 已丢失的正文明确不可用；日志本身留有的旧大正文仍可按需读取，但不会凭空重建已失正文。验收不用付费模型；本轮未授权改版本、提交、推送或发布。

## 当时记录的后续顺序

1. MCP 自动恢复、工具快照更新及随包交付 ripgrep。
2. 公开 `everpeace exec`，复用生产 runner、预算、验证与清理。
3. 空闲会话分支，然后扩展历史关系查询。
4. 取得离线证据后的压缩前无模型裁剪。
5. Windows LSP 原生隔离作为独立问题处理。

上述前四项后来在同日获授权并实施；当前状态只看 [PLAN](../PLAN.md) 与 [HANDOFF](../HANDOFF.md)。

## 2026-10-02 首期历史与输出恢复之前的快照

# 当前开发计划

产品目标是 DeepSeek 优先、Windows 优先的个人编码 CLI，以可验证完成率和日常使用效率为首要目标。当前版本、提交和实测结果只见 [HANDOFF](../HANDOFF.md)；机制见 [知识库](../README.md)。旧阶段计划完整归档至 [PLAN_HISTORY](../archive/PLAN_HISTORY.md)，不再作为当前待办。

## 本轮：Daily coding reliability

- [x] 普通 coding 与 Plan 共用阻塞式 `request_user_input`，分别保持活动任务取消和规划取消语义；回答按标准工具结果持久化，不能授予权限。
- [x] 增加 Session 持久化的 `TaskProgress` / `update_plan`、请求动态上下文、状态栏摘要和只读 `/tasks`；repair、Goal continuation 与显式 resume 保留，新用户任务清空，验证权仍归宿主。
- [x] 后台 job 终态以 task generation 隔离并在下一 step 持久送达；运行项和未送达通知合计最多 20，取消先关闭通知准入，正文继续通过 poll 获取。
- [x] 搜索 continuation 最多保留 16 个搜索和 8 MiB 序列化 payload；读完、淘汰和 dispose 释放，未终止超长记录也受单次 2 MiB 输入边界约束。
- [x] 完成本轮串行 `typecheck → test → build`、本轮文件定向空白检查和差异审阅；全局 CRLF 差异及真实 Windows Terminal 验收在 HANDOFF 单独记录。

用户随后明确授权更新版本、提交并推送；交付使用 `[skip publish]`，仅推送分支，不更新 tag/Release。无需依赖升级或付费评测；功能验证使用确定性的 fake provider/process fixture，不发 live 模型请求。

## 已实现的能力里程碑

正确性与长任务机制已接入生产：任务所有的后台进程、统一 runner 结算、attempt 级请求与 usage、超时流关闭、有序有界读取池、原始字节文件版本、nested AGENTS、分页搜索、可选 TypeScript 导航。新的日常能力复用这些边界：附件不授予写权限，人工 diff 不改变模型工具，Session 搜索不创建持久索引，请求检查不从历史伪造快照。具体机制按 [RUNTIME](../architecture/RUNTIME.md)、[TOOLS](../architecture/TOOLS.md) 和 [STATE_AND_UI](../architecture/STATE_AND_UI.md) 理解。

内部评测具有生产 factory、固定 fixtures、seed/reference proof、隔离评分、随机运行计划、固定 dsh instrumentation 和数值预算准入。详见 [BENCHMARKING](../BENCHMARKING.md)。不得用本地模拟或命令退出零宣称模型比较胜出。

## 后续优先顺序

| 顺序 | 工作 | 完成判据 / 前提 |
| --- | --- | --- |
| 1 | 真实 Windows Terminal 验收 | `/tasks`、coding 问题、resize、scrollback、Esc/Ctrl+C、一个 prompt、后台完成通知与 Session 恢复 |
| 2 | 模型可访问的压缩后历史检索 | 先定义不泄露权限/凭据且不让旧历史覆盖当前投影的范围、索引和引用失效契约 |
| 3 | 公开 headless execution | 复用 `CodingTaskRunner`、验证权、预算和清理，不把内部 benchmark adapter 直接当公共 API |
| 4 | Session conversation branching | 定义 timeline/context/Goal/workflow/TaskProgress 的分支所有权及 JSONL 兼容迁移 |
| 5 | 取得可用的 LSP 原生网络隔离 | Windows 固定 backend 仍允许直接 socket，运行时失败关闭；后续 backend/platform 必须通过相同探针 |

这些待办用于规划，不授权付费请求、安装任意扩展、提交或发布。当前保持单 Agent、Responses、inline TUI、现有权限、high/32K 默认和完整最终验证。

持久 undo 是独立恢复项目。LSP pooling/更多 semantic operation、模糊编辑和模型速度/token 调优作为后续工作；固定 dsh preflight 已完成，真实模型比较仍需对应环境及单独预算授权。图片附件、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议继续后置。output-item 提前执行工具仅在供应商和持久化/恢复证据充分时单独评估，当前仍等待完整响应。

## 验收门槛

修改前根据 [PROJECT_MAP](../architecture/PROJECT_MAP.md) 确认对应回归；尤其不得回退文件并发保护、取消清理、验证债务、unknown usage、工具配对和 Session 兼容。交付按 `typecheck → test → build` 串行执行，再运行 `git diff --check`；仓库当前没有 lint script。把无法执行、真实 Windows Terminal 未验收和已有无关差异单独报告。

真实性能实验必须先没有正确性回归，固定样本的独立验收通过次数不低于当前基线；速度/token 实验还需测得双方均成功任务耗时或每成功任务 token 至少 15% 改善才考虑默认开启。campaign 未完成不排名，不把未知缓存状态称为冷缓存。

计划只维护当前目标和验收标准；本轮进展与新证据写 HANDOFF，长期机制更新相应专题，已确定契约变更同步 [DECISIONS](../architecture/DECISIONS.md)。


# Everpeace Current Plan

## DeepSeek Harness capability milestone

The current milestone strengthens correctness before measuring model performance. `CodingTaskRunner` now owns background-process cleanup, final verification, cancellation rechecks, Goal settlement, and learned-memory outcome for both the TUI and the production benchmark adapter. Background writers are cancelled and awaited before a task settles. A shared request executor records coding, recovery, fallback, summary, title, Skill, Memory, and doctor attempts at the provider boundary; task ledgers reject another automatic request after unknown usage or exact budget exhaustion. Streams have attempt-local abort controllers and close their iterator and transport before retry.

File observations and structured edits now use the same raw-byte SHA-256. UTF-8 BOM and existing LF/CRLF style survive update and rollback, while a real concurrent byte change still rejects the write. The host read pool continues to run four safe reads concurrently, but completed out-of-order results are bounded, durably flushed as soon as their contiguous prefix is ready, and released after persistence.

Project understanding now uses a root-to-target `AGENTS.md` chain with fingerprints, diagnostics, refresh-on-access, and a durable revision event. The current snapshot is supplied on every request and survives compaction; a newly discovered nested scope defers a structured edit until the next sampling boundary. Search and glob retain bounded result snapshots with opaque continuation references. Optional `code_navigation` provides read-only TypeScript definition, references, implementation, and hover through an explicitly configured local LSP; no server is installed or trusted to edit files.

The ten Node fixtures now include pinned source revisions, setup commands, evaluator-owned assertions, and reviewed seed/reference patches. Each fixture has been proven offline as pristine pass → seeded failure → reference pass. `pnpm benchmark:campaign` can either repeat that proof or run a recorded, randomized campaign. Live mode requires explicit `--live`, a registered model, per-task and campaign token budgets, isolated workspaces, and attempt-boundary usage rather than usage inferred from prose. The production adapter constructs the same Agent, Session, permissions, sandbox, workflow, and runner used by the TUI. The dsh adapter verifies the complete `639ed015` checkout revision, owns a reviewed headless profile, and meters the upstream `llm/stream` boundary.

Remaining evidence is deliberately external: install/build the reviewed dsh checkout and exercise the generated profile without a model call, run the nine smoke comparisons, then the ninety formal comparisons, and separately complete the real Windows Terminal cancellation/restore scenario. Paid API calls are not authorized by this milestone. Until those runs exist, no relative coding-performance claim is made. Fast-check coalescing and other throughput experiments remain disabled until fixed-sample acceptance proves no regression.

## DeepSeek-first personal development CLI

The single-Agent inline terminal product now has host-owned edit observations: update/delete requires a fresh `read_file` version, approval binds the preview hash and permission revision, creation is exclusive, and rollback refuses to overwrite a later user edit. Workflow snapshots combine Git state with explicit edit paths, including ignored files. Session resume preserves repair exhaustion and verification debt; a no-change follow-up cannot erase an earlier unverified result. Automatic verification and `/verify` share cancellation and snapshot semantics; an explicit `/verify <command>` remains supplemental evidence.

Official DeepSeek continues to use Responses with plain reasoning/tool items, `high` reasoning and a 32K product default. `max` is now sent as `max`, while the product default is separate from an unknown provider capability ceiling. Coding, summary, title, Skill, Memory and doctor requests use bounded purpose settings and strict terminal-state checks. Failed request attempts mark usage incomplete, Retry-After and cancellable backoff are honored, and Thinking is shown only after a reliable reasoning event with its own elapsed time.

Summary compaction cuts at complete assistant/tool-result interaction boundaries, including several tool cycles under one user task, and rejects incomplete, empty or non-shrinking summaries before persistence. Actual request-size estimation includes stable instructions, permissions, tools, project rules, Skills, MCP instructions, Memory, Goal and history. Large tool results remain valid JSON and provide a process-local `read_tool_output` continuation instead of becoming malformed through raw truncation.

Daily coding tools now include paged 16 MiB UTF-8 reads with raw-byte SHA-256, traversable parameterized ripgrep search/glob, and at most two sandboxed non-interactive background commands with poll/stop, running previews, bounded finished retention, and a ten-minute bound. Active jobs are task-owned, settled before final verification, and terminated on cancellation, permission tightening, budget stop, failure, or Agent disposal. An explicitly configured local TypeScript LSP adds read-only navigation. `/doctor` probes Git, ripgrep, LSP configuration and a real native-sandbox command, while keeping model access behind `--live`.

An independent Windows/Linux test workflow is present. The benchmark layer has a production factory, randomized campaign runner, fixed-process adapter, and an instrumented dsh headless adapter that invokes the pinned built JS entry without shell interpolation. It clones each pinned source into a fresh per-repetition workspace, applies reviewed seed/reference patches, and proves the same evaluator-owned assertion fails before and passes after the reference repair. Live attempts check the remaining budget before every request, and missing usage stops the whole campaign. All ten reviewed patch pairs, offline proofs, and the fixed upstream dsh instrumentation contract are complete; installing/building the checkout and real API runs remain external acceptance.

Remaining acceptance is external: run the current baseline, optimized tree and fixed dsh three times per task under explicit budgets, then perform the interactive Windows Terminal edit → test pass/build fail → repair → all checks pass flow with Ctrl+C and Session restore. Until those runs exist, no superiority claim is made.

## 个人开发 Agent 可靠闭环

首批个人开发优化以 Node/TypeScript 单包项目和 Windows 为主：默认 Agent 定位为个人软件开发搭档，每个逻辑 step 安全读取工作区根到已访问目标目录的 `AGENTS.md` 链与 `package.json` scripts；Git 工作区使用结构化 NUL status 和内容指纹把任务开始时的既有脏状态与本轮 shell/patch 变化分开。最终验证重新发现当前 manifest，并串行执行所有已声明的 `typecheck`、`lint`、`test`、`build`，首败停止，修复后重跑完整集合。

工作流结果独立记录 `verified`、`unverified`、`failed` 和 `no_changes`。没有检查、文件追踪不完整、取消、审批拒绝、预算停止及修复耗尽均不能成为验证成功；Goal 的完成请求由工作流验证后结算，成功 learned memory 只接受真实 `verified` 结果。Session 仅持久化脱敏检查元数据。首批不覆盖 monorepo 调度、多 Agent、跨项目管理、自动依赖安装、部署或 Git 提交。

## Sandbox 优化路线

对 Codex、oh-my-pi、Grok Build 的固定源码比较、选择依据和验收见 [architecture/SANDBOX.md](../architecture/SANDBOX.md)。第一批已完成 payload 不重放、managed requirements、启动前环境过滤和结构化编辑保护；第二批已完成不可变有效策略、原生 `.everpeace`/全局状态保护、审批 revision 复查、顶层复合命令分析及独立 shell 网络开关。下一步实现隔离文件 worker，并完成 Linux/macOS 网络与文件原生验收，再补进程所有权和诊断/性能基线。保持 Windows 优先、固定原生后端、现有 inline TUI 和直接 `!` 语义。

# Agent Loop 优化路线

## 当前结论

Everpeace 已覆盖 Codex turn 的主要安全边界，但仍是保守的 TypeScript 适配，不是完整 Rust runtime。对照固定上游 revision `e269f2164cbb9f499e4f22301c393500e2a831f3` 的 `session/turn.rs`、`stream_events_utils.rs` 和 `tools/parallel.rs`，当前差异按正确性和收益排序如下：

| 优先级 | 差异 | 当前实现 | 风险/收益判断 |
| --- | --- | --- | --- |
| P0 | durable record 与工具启动时机 | 等 `response.completed` 后记录整批 response，再执行整批 function call | 当前最安全；提前执行只有在 provider 顺序、幂等和 cursor recovery 可证明时才有收益 |
| P1 | 工具并发闸门 | 能力声明、资源冲突检查和默认 4 项有界读取批次；审批、MCP 与写操作串行 | 不跨写操作重排；未引入通用读写锁调度器 |
| P1 | step context | 每个采样 step `prepareStep`，工具 follow-up 重新捕获 MCP/Skill 快照 | 工具定义、准入及能力使用隔离 snapshot；重试复用，guidance 刷新 |
| P2 | turn 收尾编排 | 已有 compaction、steering、重试和取消，但没有上游完整 pending-input、token-budget、stop-hook runtime | 扩展面大，必须逐项显式建模，不能用 no-op 冒充支持 |
| P2 | provider/runtime 扩展 | stream recovery 依赖 typed adapter；未移植 hooks、完整 MCP lifecycle、Plugin/远端 provider、多 Agent | 与核心 loop 解耦，暂不阻塞单 Agent 正确性 |

## 已完成基线

P0 协议基线已完成：`LoopEvent` 报告 incomplete/invalid tool call；响应拒绝、重复/缺失 `call_id`、SSE/buffered、半截流、stream recovery、取消、steering、工具顺序和结果配对均有回归。`prepareStep` 在每个采样 step 开始执行，采样重试复用 snapshot，工具 follow-up 重新捕获 snapshot；dispatch 仍在调用时重新检查权限。

这些验证证明当前整批执行路径的安全不变量，不证明真实 provider 的 item event 或 cursor 语义。现有 `src/benchmark` 只保留为隔离评测基础设施；没有固定任务 manifest 和真实 provider 数据前，不用 benchmark 结果推动协议改变，也不实现 item-level 调度。

本轮新增正常 follow-up step budget：`runAgentLoop` 默认每个 turn 最多 32 个逻辑 sampling step，`ReactAgentOptions.maxSteps` 可覆盖。网络重试在同一 step 内复用 MCP/Skill snapshot，不重复消耗 step；工具执行完成后才进入下一 step。达到上限发出 `step_limit_reached` 诊断事件并失败结束，不执行额外采样、不伪造完成、不新增 Session JSONL 事件。该控制面与 xAI 官方 function-calling 示例中显式 step count 的停止模式一致，但不声称 Grok Build 内部实现已验证。

## 本轮已落实

- [x] P0：在 durable record 前拒绝无效或重复 function call 字段，工具副作用保持 fail-closed。
- [x] P1：以 `readOnly`、`idempotent`、`parallelSafe`、`resourceKeys` 能力声明控制并发；共享资源键拆分批次，未知能力默认串行。
- [x] P1 接入边界：仅内置文件/Skill 读取可获得并发能力；MCP annotations 不授予并发权限，所有 MCP、审批及写操作串行。
- [x] 单 Agent workflow review checkpoint：完整验证成功后检查变更路径仍出现在 Git 状态；review 失败进入 `diagnose` 并把有界错误反馈给下一轮，未配置 review 时保持原有完成路径。
- [x] workflow cancellation boundary：验证器和 Git review 收到 AbortSignal 后立即传播取消，不把用户取消转换成 `diagnose` 或消耗 repair attempt。
- [ ] 后续：固定任务 manifest、真实 provider smoke 和 recovery cursor 证据不足前，不启用 `output_item.done` item-level 工具调度。

## 当前交叉边界修复

- [x] 工具准入与不可变 step snapshot：Plan 和默认模式都拒绝当前请求未提供的工具，执行时重查权限。
- [x] Steering：先补齐 outputs 后追加用户消息，持久化成功才出队，所有重新准备的 step 计入预算。
- [x] Goal：预算及 usage 不完整触发结构化停止，TUI 不进入 workflow 自动修复或目标续跑，不当作成功完成。
- [x] `PersistenceError`：context、usage、Goal 和 workflow 存储失败立即停止，不触发模型重试或后续工具。
- [x] 供应商并行提示与宿主读取调度分离；生产宿主默认最多并发 4 个审定的只读调用，结果有序保存，取消/steering 在调度检查点处理。
- [x] 自动压缩移到 step 准备阶段；压缩消耗与压缩后占用分离，后者未知直到新 response usage 到达。
- [x] 新采样发送 `sampling_started`；SSE 恢复缓存仅在有 adapter 时保留，默认 8 MiB，溢出后退回有界整请求恢复。

## 后续实施计划

### P1：条件式 output-item 执行（后置阶段）

- **前置条件**：固定任务 manifest、真实 provider smoke，并取得 provider 对 `response.output_item.done` 顺序、durable record 和 recovery cursor 的证据。
- **范围**：`src/agent/react-agent.ts` SSE consumer、`src/agent/agent-loop.ts` 可选 item/future 接口、Responses 类型与 stream 回归。
- **动作**：只对明确声明 capability 的端点开启；在对应 item durable record 后排队工具 future；未收到 `response.completed` 不发送 follow-up；buffered 或未知端点继续当前整批路径。
- **验收**：连接中断恢复不会重复记录或执行副作用；item 顺序、结果配对、取消和 steering 可重放；能力拒绝不改变整批 fallback。

### P2：显式 turn 编排扩展

- **范围**：`src/agent/agent-loop.ts`、`src/agent/react-agent.ts`、隔离测试和架构文档。
- **顺序**：在现有 pending input drain、Goal budget 闸门和 typed recovery 基础上，再单独评估 stop/after hooks 与 provider-specific 扩展；每项都定义持久化点、预算、取消和错误分类。
- **验收**：每个预算独立且可观测；compaction 不重复副作用工具；hook 的阻止/继续输入有明确 context 记录；未实现能力不暴露伪成功接口。
- **明确不做**：本阶段不重构外部 app-server，不引入多 Agent，不以 benchmark 促成自动路由。

## Benchmark 门槛

benchmark 只用于在协议变更前建立证据，不是当前实现路线的前置开发目标。后续如要启用 P1 item-level 执行，必须先准备 15–20 个固定 commit、人工审核验证命令和受信任准备步骤，并在临时 clone/worktree 中运行。阻断指标为工具重复执行、未配对 output、取消后脏状态和 unsafe action；通过率与首个工具启动延迟仅在安全指标不退化后比较。


## Model shell reliability

模型 Bash 不是无限等待的后台任务。生产 Agent 通过 `DEFAULT_MODEL_BASH_TIMEOUT_MS` 使用 120 秒有界执行时间；超时会终止子进程树，并向模型返回 `timed_out: true` 与结构化错误。用户直接 `!` 命令继续保持无默认超时，由用户负责取消。该边界不改变权限 profile、sandbox 映射或 Session JSONL schema。

模型 sandbox Bash 与 `runCodexCli` 现在共享同一条 Codex CLI 进程执行边界，模型 payload 不按 helper 输出文案重试；仅无 payload 的 helper 调用保留最多一次重试，最终仍失败关闭。权限 profile 之上增加持久化 command prefix rules，最长前缀优先，`deny > ask > allow`；用户策略写入平台配置，项目 `.everpeace/permissions.json` 只能收紧，不影响直接 `!`。

默认聊天新增兼容 provider 的 `apply_patch` function tool。它只接受工作区相对路径、受限 unified diff 或完整文件内容，支持可选 SHA-256 防陈旧、原子多文件应用和失败回滚；Plan 模式仍为只读。工作流只向 Session JSONL 追加可恢复的阶段与验证元数据，不保存文件快照。

## Coding workflow loop

已加入单 Agent 的 Codex 风格 coding loop：普通请求按 `understand -> implement -> verify_fast -> diagnose -> verify_full -> review -> done` 推进；Plan 请求保持只读并在批准后回到同一 Session 执行。工作流自动发现常见 Node/Python/Rust/Go 检查，patch 成功后先运行快速检查，回合结束再运行完整检查；失败输出作为下一次模型输入，最多三次修复尝试，超过上限进入 `blocked`。

模型可调用只读 `workspace_status`/`workspace_diff` 查看 Git 状态，用户可用 `/diff` 查看有界 diff、`/verify` 执行发现的检查或显式命令。最新 Agent 回合使用进程内检查点支持 `/undo`；只有文件仍匹配 Agent 写入后的 SHA-256 才恢复，检测到用户并发修改时跳过冲突文件。新 Session、`/clear`、`/resume` 会隔离检查点，重启后不提供文件内容回滚。

## Coding task benchmark foundation

已加入独立 `src/benchmark` 评测层：任务定义包含 prompt、隔离工作区、标签、超时、验证命令和有界修复次数；harness 通过 adapter 接入，运行期间转发既有 `LoopEvent`/phase 并收集响应、工具失败、重试、stream recovery、compaction、steering 和取消指标。验证失败会进入 `diagnose` adapter 调用并重新验证，runner 记录每次尝试、workspace 前后 Git 快照和可选脱敏 artifact。Provider capability profile 只记录事实，不自动路由模型。

该层不进入 Session JSONL、不改变 TUI 或 Agent loop 语义，也不自动 reset/checkout/delete 工作区。公开 issue benchmark 必须固定 commit 和人工审核的验证命令，并使用临时 clone/worktree；日常 coding task 保持当前目录加显式检查点。第一阶段目标是用 15-20 个公开 issue 建立多模型 baseline，再以独立 adapter 比较其他 harness；自动路由、多 Agent、云端、多用户和 IDE 集成不属于本阶段。

## Plan 与 Goal

## Session deletion

`/resume` 的 Session 列表支持进入删除模式，用 `MultiSelect` 勾选多个本地 Session，二次确认后永久删除对应 JSONL；删除当前 Session 会解除当前会话并回到聊天界面，删除其他 Session 只刷新列表。

## Context compaction

已加入 Codex 风格的 `/compact`：手动命令调用供应商原生 Responses `/responses/compact`，将其返回的完整 context window 原样作为后续模型输入；可见 transcript 与旧 JSONL timeline 不删除。压缩事件持久化为 `context_compacted`，并按普通模型请求累计 input/output/total token usage。

已知模型 context window 达到 80% 时，Agent 会在所有工具结果持久化后的下一次采样前自动压缩；未知 window 不自动触发。模型轮次或直接命令运行期间拒绝手动压缩，Esc/取消会中止请求。供应商不支持原生压缩时明确报错，不执行本地摘要回退。

模型明确返回 context-limit 错误时，当前 turn 最多额外调用一次原生 compaction 并恢复采样；普通 400 不触发压缩，压缩失败不重试。SSE 必须收到 `response.completed`，能力拒绝只在首个事件前回退 buffered；网络中断、异常 EOF 和半截响应不执行工具，按现有两次采样重试边界处理。

Agent Loop 平衡优化：采样错误现在按连接、超时、限流、服务端、半截流、上下文超限和永久错误分类，采样、stream recovery、context compaction 预算彼此隔离。Responses client 可显式提供 event-cursor recovery adapter；成功续接只返回一个完整响应，失败回到有界整轮重试。`parallelToolCalls` 默认关闭，只有显式开启时才发送 `parallel_tool_calls: true`；`read_file`、`list_directory`、`read_skill` 使用有界滑动任务池并按原始顺序落盘，Bash、MCP、网页、审批和 Goal/Plan 写操作保持串行屏障。`step_limit` 与可选 `deadline_exceeded` 使用结构化停止结果，并记录不含内容的采样、退避、压缩和工具耗时。

## Prompt cache

主 Agent 使用 Responses API 服务端 prompt caching：官方 OpenAI endpoint 的主采样和原生 compaction 请求使用按 Session ID 延迟解析的 `everpeace:v2:session:<id>` key，并同步发送 `session-id` 会话亲和性 header；不缓存完整响应，不改变工具循环或 Session context。GPT-5.6 及以后型号额外发送隐式缓存模式和 `30m` TTL，旧模型只使用基础 key。高级字段被兼容端点拒绝时，当前 Agent 只降级重试一次。

固定系统指令和工具定义保持稳定顺序，动态权限、Plan/Skill/MCP、memory 和 goal 内容位于动态尾部；GPT-5.6+ 请求使用 request-local developer 前缀和显式 breakpoint，且不把缓存标记写入 Session。缓存 usage 详情会累计到 Session，并在 `/status` 显示 cached input、cache writes 和 cache hit rate；旧 Session、兼容端点或 provider 未返回详情时保持兼容并显示 `N/A`。

已加入 Codex 风格的严格 `/plan` 和持久化 `/goal`：Plan 模式只开放工作区读取、网页、Skill 读取及结构化问题/计划审批工具，禁止 Bash/MCP 等副作用；网页开关开启时，Plan 的公共 web 请求不要求逐次确认，关闭网页工具仍拒绝访问。`/plan` 可持续进入规划模式，`/plan <需求>` 直接开始，批准后回到 Default 并在同一 Session 执行。Goal 绑定创建它的 Session，使用 `get_goal`、`create_goal`、`update_goal` 工具及 JSONL goal 事件保存状态；`/goal <目标> [--tokens N]` 确认后立即运行，active goal 每轮自动续跑，恢复原 Session 后继续，支持 complete/blocked/paused/budget_limited/usage_limited 状态。


## 历史显示上限

已读取 `openai/codex` 源码并采用其 terminal resize-reflow 行数上限：VS Code 1,000、Windows Terminal 9,001、WezTerm 3,500、Alacritty 10,000、未知终端 1,000。普通 Codex transcript 没有全局记录数上限；其 5 turn / 100 item 参数只用于分页的远端 thread API，不能替代本项目完整本地 JSONL 恢复。Everpeace 删除自定义 200 条记录窗口，改按当前宽度估算源文本行数选择重放尾部；完整存档、context、输入导航和 outputs 不裁剪。


状态快照：2026-09-19。

## Learned 经验记忆

已接入独立的 learned memory 两阶段本地流水线：workflow 验证后的轮次先形成带来源候选，再确定性去重、冲突审查并按需调用普通模型合并，最后写入兼容旧格式的 Markdown。任务持久化并在五分钟真实空闲后单并发运行，支持重启恢复、租约回收、幂等提交、取消和存储代次防迟到回写。每个逻辑 step 按问题、中文/英文词、路径和实际访问文件刷新 `MemorySnapshot`，普通网络重试复用快照；主 prompt 注入短索引，只读 `memory_lookup` 按 ID 提供脱敏证据详情。聊天级读写策略随 Session JSONL 保存，Memory usage 独立展示，不引入远程后端或向量检索。详细边界见 `architecture/MEMORY.md`。

## 实时 Agent 进度与运行中纠正

已完成 Responses SSE 优先、严格 completed 边界、能力拒绝的 sticky buffered fallback、半截流有界重试、实时 assistant delta/工具状态、运行中 safe-checkpoint steering 及分段耗时显示。流式增量和阶段状态只存在当前 TUI，不写入 Session JSONL；采样中的 guidance 会中止当前采样，工具执行中的 guidance 在结果落盘后生效，未执行的调用补齐 `steered` output。Ctrl+C 时已提交的待处理 guidance 会持久化到模型 context。

## 当前目标

Codex 核心 Agent Loop TypeScript 适配已接入：独立轮次控制、逐工具结果持久化、采样重试和取消、完成判断、并发 turn 防护。上游来源与未移植模块见 `architecture/AGENT_LOOP.md`。

完成终端交互改进：Ctrl+C 取消、跨重启输入历史、Shift+Enter 配置、统一紧凑命令输出与 `/outputs`。仍不实现 Ctrl+R、任务队列或外部编辑器。

完成英文优先的运行界面和富文本层：供应商感知等待状态、Agent 阶段切换、Markdown/代码高亮、命令卡片以及 Git 风格 unified diff；保持 inline、scrollback、首五/尾五实时预览和既有 Session schema。

Codex sandbox、MCP 与 Skills 接入：模型 shell 通过固定版本 Codex CLI 进入平台原生 sandbox，MCP 从 `codex mcp` 配置发现并连接 stdio/Streamable HTTP tools，Skills 按项目/用户根发现并渐进加载；`/mcp` 提供瞬时状态窗口，`/skills` 提供创建、公开 URL 安装、查看和显式调用管理向导。实现与完整 Codex runtime 的边界见 `architecture/CODEX_CAPABILITIES.md`，权限映射见 `architecture/PERMISSIONS.md`。

提供可持久化、可恢复、可继续对话的本地 Session：

- 每个 session 使用独立 JSONL 文件保存可见 transcript 和模型 context。
- 首次普通提问自动创建 session，并由当前模型在后台生成名称。
- `/new` 立即创建并进入一个新 session；第一次提问后替换临时名称。
- `/resume` 列出本机全部 session，恢复模型、工作目录、历史和上下文。
- `/clear` 只退出当前 session，下一次普通提问时再创建新记录。
- `/status` 在独立命令窗口中显示当前模型、provider、context 和 session token usage；窗口隐藏原会话内容，Esc 原子恢复原 Session，usage 累计持久化，窗口不进入 session。
- 为 DeepSeek、OpenAI 和自定义兼容端点提供普通 function call 形式的网页搜索和公共页面读取，使模型可以回答依赖最新网络信息的问题。

## 已完成

- [x] `/resume` 从会话恢复输入导航并清空草稿，召回斜杠命令不抢占方向键。
- [x] 修复恢复上下文中的缺失工具结果；工具异常返回结构化结果，避免后续请求出现缺失 output 的 400。

- [x] Ctrl+C 取消模型请求、审批等待和运行命令；取消后的工具调用补齐结果，下一轮可继续。
- [x] 全局输入历史、上下键草稿恢复、多行粘贴和 `/history` 清理。
- [x] `/terminal-setup` 显式确认、JSONC 保留、冲突拒绝、备份及过期预览检查。
- [x] 模型 Bash 运行时有界保留并展示真实首五行/尾五行，矮终端自适应缩减；直接 `!` 保持尾部预览，完成后折叠并由 `/outputs` 提供分页详情。
- [x] TUI 宿主文案统一为英文，等待模型时按 provider 显示计时和中断提示，工具阶段显示 `Working`；旧系统/工具文案只在显示层翻译。
- [x] 模型回复支持 GFM Markdown，代码围栏及 Bash/PowerShell 命令使用语法高亮，并为超大输入和未知语言提供纯文本降级。
- [x] 命令使用 Running/Ran/You ran 分层卡片；标准 unified diff 在 transcript、实时输出和 `/outputs` 中显示新旧行号及增删高亮，并适配真彩、ANSI 与 `NO_COLOR`。
- [x] `src/tui` 按应用编排、命令、输入、渲染、终端操作及 conversation/feedback/navigation/screens/wizards 组件职责分层，目录调整不改变运行语义。
- [ ] 真实 Windows Terminal 手动验收键位、复制、缩放、resize 和带凭据模型的完整流程。

- [x] 应用层 ask/read-only/full-access 模式，完全访问二次确认，网页工具独立开关。
- [x] Codex 风格 workspace-write 默认档位；read-only/ask 对模型 shell 和网页请求逐项审批，workspace-write 的已开启公共网页工具免逐次确认，MCP 使用独立审批面。
- [x] `read_file` / `list_directory` 路径校验、内容上限、结构化失败返回。
- [x] 权限独立窗口；切换不清空 context、不向 JSONL 写入授权。
- [x] 模型 shell 映射 Codex `:read-only`、`:workspace`、`:danger-full-access`，sandbox 不可用时失败关闭；直接 `!` 保持原生 PTY。
- [x] 模型 Bash 与 Codex CLI 共享 bounded process executor；模型 payload 不根据 helper 文案重试；无 payload helper 保留有界重试，取消/超时仍失败关闭。
- [x] 兼容 provider 的结构化 `apply_patch` function tool：工作区边界、unified diff、SHA-256 陈旧检查、多文件原子应用和失败回滚。
- [x] 单 Agent coding workflow：patch 后快速验证、回合结束完整验证、失败诊断循环和有界 repair budget。
- [x] `workspace_status` / `workspace_diff` 只读工具与 `/diff`、`/verify`、`/undo` 命令；检查点检测用户冲突且不持久化文件内容。
- [x] 持久化 command prefix rules：最长前缀优先，冲突按 `deny > ask > allow`；用户策略写入平台配置，项目策略只能收紧，不影响直接 `!`。
- [x] MCP stdio/Streamable HTTP 工具、resources、prompts 的发现、命名空间、调用、超时、取消、单服务器故障隔离和独立审批；`/mcp` 可刷新状态。
- [x] Codex 主机 Skill roots、frontmatter 校验、metadata catalog、同名冲突隔离、显式 `$name`、隐式 `read_skill` 与相对资源约束。
- [x] `/skills` 管理向导：项目/用户作用域、AI 单文件创建与校验、完整手动编辑、公开 GitHub/Git/SKILL.md/ZIP 暂存预览、显式安装确认、带作用域/状态/两行描述的已安装 Skill 目录、完整内容查看和 `$name` 回填。
- [x] Skill 安装安全边界：仅公开 HTTPS、逐重定向公共地址校验、Git 重定向关闭、超时和大小/条目上限、路径穿越/符号链接/特殊文件拒绝、无覆盖暂存安装。
- [x] 大型 Git Skill 来源先无检出克隆并检查有界仓库树，只检出按名称去重后的候选目录；Windows 长路径不再被无关仓库副本触发，单个受限 Skill 可包含最多 5,000 个条目。
- [x] Git 仓库的原始 `SKILL.md` 清单上限与去重后的 100 个不同候选上限分离；包含大量同名平台/评审镜像副本的来源不会在名称去重前被错误拒绝。
- [ ] 后续单独设计 MCP OAuth/elicitation/sampling/tasks/list-changed、Codex Plugin/远端 Skill provider 和 managed policy；当前不得宣称完整 runtime 等价。

- [x] SessionStore、跨平台存储路径、串行追加和损坏文件隔离。
- [x] Agent context 导入及增量持久化。
- [x] 后台模型命名、标题清洗及失败回退。
- [x] `/resume` 选择器、原模型恢复、替代模型和跨目录恢复。
- [x] `/new` 立即建档、切换界面和 `title_pending` 首问命名。
- [x] JSONL 旧格式兼容：缺少 `title_pending` 时按已命名处理。
- [x] 中英文 README、CLI/TUI help 和 docs 同步。
- [x] 根级 `AGENTS.md` 汇总新 Session 必读的长期项目知识和工作约束。
- [x] 输入开头的 `/` 打开实时前缀筛选菜单，最多显示八项并支持键盘选择、执行和补全。
- [x] 主 Agent Responses usage 采集、JSONL 增量持久化和 `/resume` 恢复。
- [x] `/status` Codex 风格状态方格、官方 base URL/model context 映射及兼容端点安全降级。
- [x] 信息型命令和选择型 picker/wizard 使用独立命令窗口，隐藏 banner、历史、composer 和全局状态栏，并通过 Esc 原子恢复 Session。
- [x] 异步命令使用独立加载窗口；Esc 返回后忽略迟到结果，resize 时继续保持历史隐藏。
- [x] 所有独立命令窗口使用共享的水平、垂直居中布局，最大 80 列，并在窄终端自适应安全边距。
- [x] Slash command 界面与可恢复 transcript 分离，不写入 JSONL 或模型 context。
- [x] 新增 `web_search` 和 `web_fetch`，支持搜索结果摘要、网页正文提取、来源 URL、失败降级和取消信号。
- [x] 网页读取限制为公共 HTTP/HTTPS，逐次验证重定向并阻止 localhost、内网和链路本地地址。
- [x] 搜索采用 Bing 优先、DuckDuckGo 回退，不额外要求搜索服务 API Key。
- [x] 模型轮次运行期间保留 guidance composer；补充消息立即写入 transcript，并在采样/工具安全检查点应用。
- [x] Responses 流式文字和工具进度即时显示；不支持流式的兼容端点回退到 buffered 阶段/审批/命令预览。
- [x] 运行中 guidance 在 safe checkpoint 应用并保留完整 function output 配对；计时显示 `s`、`m s`、`h m s`。

## 验收与后续

- 自动验证目标：完整测试、类型检查、构建和 diff 检查全部通过；最新实际结果记录在 `HANDOFF.md`。
- 待在真实 Windows Terminal 中验证 `/new` → 首问命名 → 退出 → `/resume` → 继续聊天。
- 待使用真实 OpenAI、DeepSeek 和自定义兼容端点复验 `/status` usage 返回、context 映射、居中与窄终端排版，以及 Esc 返回原 Session。
- v0.1.28 已发布：发布提交、远端 annotated tag、Release workflow `35444192023` 和非 draft/prerelease GitHub Release 均已确认。

## 文档规则

后续每次修改功能、行为、接口或测试状态时，必须在同一批改动中更新相关 `docs/` 文档；至少检查本文件、`architecture/DECISIONS.md` 和 `HANDOFF.md` 是否需要同步。


---

## 2026-10-08 连续性优化前的计划快照

# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据见 [HANDOFF](../HANDOFF.md)，稳定机制见 [知识库](../README.md)，已完成阶段见 [PLAN_HISTORY](PLAN_HISTORY.md)。

## 当前里程碑：可靠性、MCP 资源访问与长会话成本

用户明确授权本轮 P0／P1／P2／P3 实施。比较参考继续固定为 DeepSeek Harness 官方 checkout `639ed015397290b3745d163aafe02ffee4aa3f84`，不扩大为全部 MCP 协议或实验调度。既有历史/附件、exec、fork、重连、裁剪继续复用；模型默认值、权限和宿主验证不变。

- [x] MCP 使用 SDK 公共 request/result schema，宿主持有完整定义和独立 output validator；完整发现与编译成功后原子发布，binding 覆盖 outputSchema/execution。required-task 不广告，状态明确 unsupported；资源/提示专用 server 可 ready。
- [x] MCP 资源、模板、提示使用一次一页的 cursor 接口；单页最多 1,000 项／1 MiB，超限不给部分条目或跳项续点，二进制投影不注入 base64。真实 SDK stdio/HTTP fixture 覆盖目录更新、调用校验和失效会话恢复。
- [x] LSP 宿主输入和返回位置校验 denied roots；验证 UTF-16 与 open/close 能力，hover 安全截断，production factory 统一 permission revision。
- [x] Windows 固定后端门禁加入宿主正对照与 allowed/denied/inconclusive 证据。实测仍 allowed，保持 unavailable；通用 registry/pool 按批准的条件后移。
- [x] exec 可等待输出贯通 Agent loop，工具/工作流在执行或提交边界交付。schema 1 助手正文完整分块转义写出，其他事件整行最多 64 KiB 且明确截断，编码缓冲有界，30 秒无进展取消清理。
- [x] Windows 非 TTY 输出由 CLI host 拥有的 writer 子进程处理，避免标准 pipe 同步写阻塞取消；真实子进程 fixture 验证慢消费者、断管、不读、信号边界和回收。
- [x] Session load/list/search 流式解析记录，保留旧 JSONL 和 crash tail 语义；历史输出定位使用 256 项只含 metadata 的 LRU，命中仍验证记录与调用来源。
- [x] v1 附件按 header＋范围读取，保留文件身份、精确长度、锁、取消、淘汰、UTF-8 continuation 与转义后响应上限，无存储迁移。
- [x] 集成审查、Windows 串行 typecheck → test → build、差异/链接检查与最终交接。
- [ ] 真实 Windows Terminal 手工验收恢复、fork→Plan→coding→取消→再次 coding、resize/scrollback、单 prompt 与退出清理。

## 验收与边界

验收使用 fake provider、本地真实 SDK/server 和临时工作区，不读用户凭据或发送付费模型请求。真实 stdout/process 集成与 fake host 回归分别报告；Windows 管道信号 handler fixture 不等同于 Windows Terminal Ctrl+C。半条 JSONL frame 已写出后通道失败或取消时不能补写可靠终态，Session 仍按持久化/清理规则收束。

长会话 fixture 固定为 128 MiB replay、100 个 Session 冷/热列表/搜索，以及 2 MiB 附件连续 16 个 24 KiB 页面。门禁使用解析/读取字节与结果等价，耗时/堆只作离线诊断。附件读取量最多 512 KiB，日志来源重验另计，不宣称整个调用只读一页。原格式没有正文 hash，本轮不新增该保证。

Test CI 的 Windows/Linux 矩阵执行新增 fixture 并设置有界超时；本机原生 sandbox 和真实终端体验单列。没有 lint script 时不臆造检查。文档与 README 只说明已实现能力，版本和测试数量只在 HANDOFF 维护。

## 独立后续

1. 固定 Windows native backend 的网络隔离仍受阻；本轮不更换 sandbox、不关闭门禁、不回退宿主执行。后续候选是上游共同 Windows backend 的网络拒绝修复，先以独立分支审查具体 revision，不能只因版本变新就放行。升级回归必须保持宿主正对照、明确拒绝证据，并分别记录 IPv4/IPv6 和其他实际测试传输，重验工作区写入、应用状态读取、shell/patch 权限、取消及进程树确认退出。只有原生门禁通过后再实现用户 lsp.json、通用 registry 与四实例池及其生命周期。
2. MCP OAuth/header helper、elicitation、sampling/tasks、持久审批和资源订阅仍需独立场景与方案。
3. 持久 undo、item-level 提前执行、图片、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议不进入本轮。
4. 真实模型比较需要另行明确授权与 task/campaign 数值预算；离线宿主 I/O、进程数和耗时证据不代表模型成功率、质量或 token 提升。

用户随后明确授权更新版本、提交并推送。交付只推送 `main`，使用 `[skip publish]` 保持 Test CI 并阻止分支发布，不创建或推送 tag，不创建或更新远程 Release。
