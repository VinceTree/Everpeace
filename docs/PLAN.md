# Everpeace Current Plan
# Agent Loop 优化路线

## 当前结论

Everpeace 已覆盖 Codex turn 的主要安全边界，但仍是保守的 TypeScript 适配，不是完整 Rust runtime。对照固定上游 revision `e269f2164cbb9f499e4f22301c393500e2a831f3` 的 `session/turn.rs`、`stream_events_utils.rs` 和 `tools/parallel.rs`，当前差异按正确性和收益排序如下：

| 优先级 | 差异 | 当前实现 | 风险/收益判断 |
| --- | --- | --- | --- |
| P0 | durable record 与工具启动时机 | 等 `response.completed` 后记录整批 response，再执行整批 function call | 当前最安全；提前执行只有在 provider 顺序、幂等和 cursor recovery 可证明时才有收益 |
| P1 | 工具并发闸门 | 仅按连续工具名白名单并行，未建共享资源读写锁 | 混合读写和同资源访问无法表达；应先保守串行，再引入能力声明 |
| P1 | step context | 每个采样 step `prepareStep`，工具 follow-up 重新捕获 MCP/Skill 快照 | 已满足基本快照边界；后续需让工具能力和资源键成为同一不可变 snapshot |
| P2 | turn 收尾编排 | 已有 compaction、steering、重试和取消，但没有上游完整 pending-input、token-budget、stop-hook runtime | 扩展面大，必须逐项显式建模，不能用 no-op 冒充支持 |
| P2 | provider/runtime 扩展 | stream recovery 依赖 typed adapter；未移植 hooks、完整 MCP lifecycle、Plugin/远端 provider、多 Agent | 与核心 loop 解耦，暂不阻塞单 Agent 正确性 |

## 已完成基线

P0 协议基线已完成：`LoopEvent` 报告 incomplete/invalid tool call；响应拒绝、重复/缺失 `call_id`、SSE/buffered、半截流、stream recovery、取消、steering、工具顺序和结果配对均有回归。`prepareStep` 在每个采样 step 开始执行，采样重试复用 snapshot，工具 follow-up 重新捕获 snapshot；dispatch 仍在调用时重新检查权限。

这些验证证明当前整批执行路径的安全不变量，不证明真实 provider 的 item event 或 cursor 语义。现有 `src/benchmark` 只保留为隔离评测基础设施；没有固定任务 manifest 和真实 provider 数据前，不用 benchmark 结果推动协议改变，也不实现 item-level 调度。

## 本轮已落实

- [x] P0：在 durable record 前拒绝无效或重复 function call 字段，工具副作用保持 fail-closed。
- [x] P1：以 `readOnly`、`idempotent`、`parallelSafe`、`resourceKeys` 能力声明控制并发；共享资源键拆分批次，未知能力默认串行。
- [x] P1 接入边界：仅内置文件/Skill 读取和同时声明 MCP read-only/idempotent 的工具可获得并发能力；Bash、patch、web、写 MCP 与工作流工具不变。
- [ ] 后续：固定任务 manifest、真实 provider smoke 和 recovery cursor 证据不足前，不启用 `output_item.done` item-level 工具调度。

## 分阶段实施计划

### P0：守住现有整批路径（当前阶段）

- **范围**：`src/agent/agent-loop.ts`、`src/agent/react-agent.ts`、`tests/unit/agent/agent-loop.test.ts`、`tests/unit/agent/react-agent.test.ts`。
- **动作**：保持 `response.completed` 为采样成功边界；保持响应 durable record 先于任何副作用；继续为每个已启动/未启动调用补齐结果；明确采样、stream recovery、compaction 的独立预算。
- **不变量**：半截 response、`response.failed`、缺失/重复 `call_id` 不执行工具；工具结果按模型顺序持久化；重试不重跑已完成工具；取消和持久化失败 fail-closed。
- **验收**：定向 loop/stream/context/取消回归；类型检查、构建和 diff 检查；不增加 Session JSONL 事件。

### P1：能力声明与共享资源闸门

- **范围**：`src/agent/agent-loop.ts`、工具定义/目录、MCP tool metadata、`src/agent/react-agent.ts` 及 loop 回归。
- **动作**：为内置工具和可信本地工具声明 `read_only`、`idempotent`、`parallel_safe` 与资源键；以共享资源键实现读锁/写锁 admission；MCP 声明默认不授予本地并发权限。
- **迁移**：先把现有 `read_file`、`list_directory`、`read_skill` 白名单映射为显式能力；未声明工具继续串行；保留结果按模型顺序落盘。
- **验收**：不同只读资源可并行；同资源读/写及任意写操作互斥；Bash、`apply_patch`、MCP、网页、审批和 Goal/Plan 写操作默认串行；stop、steering、取消和落盘失败不丢 output。

### P1：条件式 output-item 执行（后置阶段）

- **前置条件**：固定任务 manifest、真实 provider smoke，并取得 provider 对 `response.output_item.done` 顺序、durable record 和 recovery cursor 的证据。
- **范围**：`src/agent/react-agent.ts` SSE consumer、`src/agent/agent-loop.ts` 可选 item/future 接口、Responses 类型与 stream 回归。
- **动作**：只对明确声明 capability 的端点开启；在对应 item durable record 后排队工具 future；未收到 `response.completed` 不发送 follow-up；buffered 或未知端点继续当前整批路径。
- **验收**：连接中断恢复不会重复记录或执行副作用；item 顺序、结果配对、取消和 steering 可重放；能力拒绝不改变整批 fallback。

### P2：显式 turn 编排扩展

- **范围**：`src/agent/agent-loop.ts`、`src/agent/react-agent.ts`、隔离测试和架构文档。
- **顺序**：先建 pending input drain 和 token budget 状态，再评估 stop/after hooks，最后接入 provider-specific recovery；每项都定义持久化点、预算、取消和错误分类。
- **验收**：每个预算独立且可观测；compaction 不重复副作用工具；hook 的阻止/继续输入有明确 context 记录；未实现能力不暴露伪成功接口。
- **明确不做**：本阶段不重构外部 app-server，不引入多 Agent，不以 benchmark 促成自动路由。

## Benchmark 门槛

benchmark 只用于在协议变更前建立证据，不是当前实现路线的前置开发目标。后续如要启用 P1 item-level 执行，必须先准备 15–20 个固定 commit、人工审核验证命令和受信任准备步骤，并在临时 clone/worktree 中运行。阻断指标为工具重复执行、未配对 output、取消后脏状态和 unsafe action；通过率与首个工具启动延迟仅在安全指标不退化后比较。


## Model shell reliability

模型 Bash 不是无限等待的后台任务。生产 Agent 通过 `DEFAULT_MODEL_BASH_TIMEOUT_MS` 使用 120 秒有界执行时间；超时会终止子进程树，并向模型返回 `timed_out: true` 与结构化错误。用户直接 `!` 命令继续保持无默认超时，由用户负责取消。该边界不改变权限 profile、sandbox 映射或 Session JSONL schema。

模型 sandbox Bash 与 `runCodexCli` 现在共享同一条 Codex CLI 进程执行边界，Windows helper setup/refresh 的瞬时错误最多重试一次，最终仍失败关闭。权限 profile 之上增加持久化 command prefix rules，最长前缀优先，`deny > ask > allow`；用户策略写入平台配置，项目 `.everpeace/permissions.json` 只能收紧，不影响直接 `!`。

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

Agent Loop 平衡优化：采样错误现在按连接、超时、限流、服务端、半截流、上下文超限和永久错误分类，采样、stream recovery、context compaction 预算彼此隔离。Responses client 可显式提供 event-cursor recovery adapter；成功续接只返回一个完整响应，失败回到有界整轮重试。`parallelToolCalls` 默认关闭，只有显式开启时才发送 `parallel_tool_calls: true`，并只允许 `read_file`、`list_directory`、`read_skill` 进入按原始调用顺序落盘的并行批次；Bash、MCP、网页、审批和 Goal/Plan 写操作保持串行。

## Prompt cache

主 Agent 使用 Responses API 服务端 prompt caching：官方 OpenAI endpoint 的主采样和原生 compaction 请求使用按 Session ID 延迟解析的 `everpeace:v2:session:<id>` key，并同步发送 `session-id` 会话亲和性 header；不缓存完整响应，不改变工具循环或 Session context。GPT-5.6 及以后型号额外发送隐式缓存模式和 `30m` TTL，旧模型只使用基础 key。高级字段被兼容端点拒绝时，当前 Agent 只降级重试一次。

固定系统指令和工具定义保持稳定顺序，动态权限、Plan/Skill/MCP、memory 和 goal 内容位于动态尾部；GPT-5.6+ 请求使用 request-local developer 前缀和显式 breakpoint，且不把缓存标记写入 Session。缓存 usage 详情会累计到 Session，并在 `/status` 显示 cached input、cache writes 和 cache hit rate；旧 Session、兼容端点或 provider 未返回详情时保持兼容并显示 `N/A`。

已加入 Codex 风格的严格 `/plan` 和持久化 `/goal`：Plan 模式只开放工作区读取、网页、Skill 读取及结构化问题/计划审批工具，禁止 Bash/MCP 等副作用；网页开关开启时，Plan 的公共 web 请求不要求逐次确认，关闭网页工具仍拒绝访问。`/plan` 可持续进入规划模式，`/plan <需求>` 直接开始，批准后回到 Default 并在同一 Session 执行。Goal 绑定创建它的 Session，使用 `get_goal`、`create_goal`、`update_goal` 工具及 JSONL goal 事件保存状态；`/goal <目标> [--tokens N]` 确认后立即运行，active goal 每轮自动续跑，恢复原 Session 后继续，支持 complete/blocked/paused/budget_limited/usage_limited 状态。


## 历史显示上限

已读取 `openai/codex` 源码并采用其 terminal resize-reflow 行数上限：VS Code 1,000、Windows Terminal 9,001、WezTerm 3,500、Alacritty 10,000、未知终端 1,000。普通 Codex transcript 没有全局记录数上限；其 5 turn / 100 item 参数只用于分页的远端 thread API，不能替代本项目完整本地 JSONL 恢复。Everpeace 删除自定义 200 条记录窗口，改按当前宽度估算源文本行数选择重放尾部；完整存档、context、输入导航和 outputs 不裁剪。


状态快照：2026-09-19。

## Learned 经验记忆

已接入独立的 learned memory：实质且正常完成的回合在 idle grace period 后由当前模型后台提炼项目经验；显式长期偏好进入用户级文档。经验存放在平台应用状态目录，不进入 Session JSONL 或仓库；新 Agent 实例首轮按当前问题召回相关条目，并以不可信背景注入。条目包含兼容旧 Markdown 的 metadata、来源 evidence、状态和置信度，召回使用可解释的本地评分与字符预算，不引入远程后端或向量检索。`/memory` 提供全局暂停/恢复、当前聊天读写策略、归档最新条目、分别清理和显式记忆入口。

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
- [x] 模型 Bash 与 Codex CLI 共享 bounded process executor；Windows sandbox helper 瞬时 setup/refresh 错误最多重试一次，取消/超时仍失败关闭。
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
