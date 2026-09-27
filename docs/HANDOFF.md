# 最新执行：P0 基线、step snapshot 与协议回归

状态快照：2026-09-27。本轮完成 P0 loop 基线和 follow-up step snapshot。`runAgentLoop` 在每个采样 step 开始调用 `prepareStep`；采样重试复用同一 snapshot，工具结果后的 follow-up 重新捕获 MCP/Skill 状态；dispatch 仍重新检查当前权限。运行时继续在 `response.completed` 后统一执行工具，item-level 工具执行未启用。

已清理未接通的 item-level capability/recovery 草稿，恢复接口只保留已有 typed `recovery` adapter。新增与保留的回归覆盖 response rejection、重复/缺失 call_id、采样重试、SSE/buffered、stream recovery、取消、工具顺序、MCP dispatch 和 benchmark 指标。定向 Agent/benchmark 测试 54 项全部通过。

本轮修复 learned-memory 回归中固定延时造成的异步写入竞态：测试现在等待真实 `capture.state === "succeeded"` 状态，不改变运行时行为。版本提升至 `0.2.18`；本轮只提交并推送代码，不创建 tag 或更新远程 Release。

最终验证：`pnpm test` 为 274 项，273 通过、0 失败、1 项按平台跳过；`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。

下一步先用固定 15-20 个 coding task 和真实 provider 采集 baseline，再决定是否实现 P1 item-level 工具执行；必须先证明 `output_item.done` 顺序、durable record 和 cursor recovery 能阻止重复副作用。真实 provider、Windows Terminal 和 live benchmark 仍未验证。


## 最新优化：持久化权限策略与 MCP resources/prompts

状态快照：2026-09-26。本轮在现有单 Agent 核心上继续补齐 Codex 对齐缺口：`/permissions` 的用户策略现在按平台写入版本化配置文件，项目可选 `.everpeace/permissions.json` 以 fail-closed 方式合并；项目策略只能收紧 mode、关闭 web 或追加 deny/ask command rule，不能通过仓库内容提升权限。新增 MCP resources/prompts 的分页 function-call 映射（`list_resources`、`read_resource`、`list_prompts`、`get_prompt`），沿用 MCP 审批、超时、取消、有界结果和 context 持久化边界。工作流验证命令现在正确传递命令级 timeout。

- 新增权限路径、版本化原子写入、项目策略降权合并及不写入凭据的回归测试；用户策略从平台配置目录恢复，项目策略不会覆盖用户拒绝。
- stdio MCP fixture 和 runtime 回归覆盖资源读取、prompt 获取及 `enabled_tools` 过滤；OAuth、elicitation、sampling、tasks 和 list-changed 仍未接入。
- 工作区展示号同步升至 `0.2.17`；本次只提交并推送代码，不创建 tag 或更新远程 Release。
- 当前验证：`pnpm test` 为 272 项，271 通过、0 失败、1 项按平台跳过；`pnpm typecheck` 与 `pnpm build` 已通过，`git diff --check` 仅有 Windows 换行提示。仍需补真实 Windows Terminal / live provider smoke。
- 后续优先补 MCP OAuth/elicitation/tasks 与 managed policy 边界，再评估 hooks/plugins 和多 Agent；不重构为外部 app-server，也不把当前实现描述为完整 Codex runtime。

# 最新优化：单 Agent coding workflow 闭环

状态快照：2026-09-26。本轮在现有 Agent 下加入 Codex 风格的单 Agent coding workflow：普通 coding turn 维护 understand/implement/verify/diagnose/review/done 状态；`apply_patch` 成功后先执行自动发现的快速检查，回合结束执行完整检查，失败输出会反馈给模型，最多三次修复尝试后进入 blocked。新增只读 `workspace_status`、`workspace_diff` 工具，以及 `/diff`、`/verify`、`/undo` 命令。

- `/undo` 使用当前进程内的最新回合检查点和 after SHA-256 做冲突检测，用户改动的文件不会被覆盖；新 Session、`/clear`、`/resume` 和新一轮 turn 都会隔离检查点，重启后不恢复文件内容。
- Session JSONL 以兼容的 `workflow_updated` 事件保存 phase、changed paths、repair 次数和最后一次验证结果；持久化快照清空验证 stdout/stderr/error，不写入 before/after 文件快照，旧 session 继续按无 workflow 元数据兼容读取。
- 验证发现器覆盖 Node package scripts、Python pytest、Rust Cargo 和 Go test，并识别 `packageManager`/锁文件；输出最多保留 1 MiB。结构化 patch 预览会在 ask 权限下展示实际 diff。
- 新增 workflow、checkpoint、verifier、workspace、patch preview 和 Session workflow 回归；当前 `pnpm test` 为 268 项通过、无失败、1 项按平台跳过，`pnpm typecheck` 与 `pnpm build` 通过，`git diff --check` 通过。idle-memory 定时用例此前出现过时序抖动，本次复跑通过。
- 工作区展示号提升至 `0.2.16`；本轮提交并推送代码，提交使用 `[skip ci]` 跳过发布工作流，不创建 tag 或更新远程 Release。后续优先做真实 Windows Terminal 的 `/verify`、patch 审批、冲突撤销和 live provider smoke，再考虑 multi-agent orchestration。

# 最新功能：Coding task benchmark 基础层

## 最新优化：Codex sandbox 执行链与结构化编辑

状态快照：2026-09-26。模型 Bash 现在与 Codex CLI JSON 请求共享 bounded process executor；Windows sandbox helper setup/refresh/unknown 错误最多重试一次，取消和超时保留输出并最终 fail-closed。新增进程内 command prefix rules 和兼容 provider 的 `apply_patch` function tool：工作区边界、符号链接、大小、SHA-256 陈旧检查和多文件原子回滚均在执行前验证。Session JSONL schema、直接 `!`、Plan 只读语义保持不变。工作区展示号同步升至 `0.2.15`；本次只提交并推送代码，不创建 tag 或远程 Release。

- 新增 `apply_patch` create/update/delete、unified hunk、stale hash、路径安全和 Agent context 回归；新增 sandbox Bash 实际走 helper retry 的 Windows 用例。
- 后续优先做真实 Windows Terminal/sandbox smoke、patch 后验证闭环和 benchmark 指标；再设计 hooks/plugins/MCP resources，不立即重构为多 Agent orchestrator。

## 最新优化：模型 Bash 有界执行

状态快照：2026-09-26。模型 Bash 现在由 TUI 依赖层设置 120 秒默认超时；超时会终止子进程树，保留已捕获输出，并向模型返回 `timed_out: true` 与结构化错误。用户直接 `!` 命令不受该默认超时影响。权限 profile、Codex sandbox 映射、Session JSONL 和直接命令语义保持不变。

- 新增 Bash timeout 序列化回归和 Windows PowerShell 默认 shell/取消回归；Unix 超时进程测试按平台执行。
- 工作区展示号同步升至 `0.2.14`；本次只提交并推送代码，不创建 tag 或远程 Release。
- 下一步继续在当前自有 Agent 核心上推进：真实 Windows Terminal/sandbox 验收、Codex 权限缺口和 coding task benchmark baseline；不 fork 外部 Harness。

状态快照：2026-09-26。benchmark 层新增有界 `implement -> diagnose -> verify` 修复闭环：验证失败后默认最多 3 次 adapter 尝试，context 会收到 attempt、phase 和 previousVerification。runner 记录每次验证、前后 workspace Git 快照、尝试/修复次数，并支持独立脱敏 artifact sink；新增 provider capability profile，只记录事实，不自动路由模型。仍不改 Session JSONL、TUI 或 Agent loop。

- 新增 `docs/BENCHMARKING.md`，说明任务格式、adapter 接入和结果语义。
- 新增只解析不执行命令的公开 issue catalog manifest、benchmark 指标、验证失败、任务超时、unsafe action、修复循环、workspace snapshot、artifact 脱敏和 capability profile 回归；benchmark 定向测试 14/14 通过。
- `pnpm typecheck` 和 `pnpm build` 通过；本轮全量 `pnpm test` 为 255 项通过、无失败、1 项按平台跳过；benchmark 定向 14/14 通过。
- 工作区展示号同步升至 `0.2.13`；本次只提交并推送代码，不创建 tag 或远程 Release。
- 下一步：固定 15-20 个公开 issue 任务的 commit、准备脚本和审核后的验证命令，使用临时 worktree 生成多模型 baseline；日常目录继续使用显式检查点，不自动回滚。

# 最新优化：Codex 对齐型 prompt cache

状态快照：2026-09-24。Prompt cache 已从工作区级 key 优化为按 Session ID 延迟解析的 `everpeace:v2:session:<id>` key。官方 OpenAI 主采样和原生 compaction 请求同时携带 `prompt_cache_key` 与 `session-id` header；GPT-5.6 及以后型号使用隐式缓存、`30m` TTL 和 request-local developer 前缀 breakpoint。旧模型继续使用基础 key，DeepSeek、未知兼容端点不发送新增缓存参数。

- 固定系统指令和静态 tool definitions 保持稳定顺序，动态权限、Plan/Skill/MCP、memory 和 goal 内容放在动态尾部。
- 高级 prompt-cache 字段被官方端点明确拒绝时，当前 Agent 生命周期内只降级重试一次；Session JSONL schema、context、工具循环和 `/status` 统计兼容保持不变。
- 新增 session key、模型能力判断、请求 header、动态 key 生命周期、compaction 共享 key 和高级字段降级回归；定向 Agent/provider 测试 41/41 通过，`pnpm typecheck`、`pnpm build` 和 `git diff --check` 通过。
- 本轮 `pnpm test` 为 224 项通过、1 项取消、无失败；取消项仍是 Windows Bash abort 用例在 15 秒超时，单独复跑仍可复现，与本轮 prompt-cache 改动无关。

# Session Handoff

## 最新优化：Agent Loop 平衡恢复与能力标记并行

状态快照：2026-09-24。Agent Loop 新增采样错误分类及独立预算：普通采样默认最多两次重试，provider 明确提供 event-cursor recovery 时当前 turn 最多续接一次，context-limit 仍最多触发一次原生 compaction；半截响应在 `response.completed` 前不会进入模型 context 或执行工具，续接失败回退到有界整轮重试。`retrying` 事件增加可选分类字段，并新增仅供当前 TUI/诊断的 `tool_batch_*`、`stream_recovery_*` 事件。

`ReactAgentOptions.parallelToolCalls` 默认关闭；显式开启时 Responses 请求才发送 `parallel_tool_calls: true`，且 loop 只为 `read_file`、`list_directory`、`read_skill` 启用并行批次。批次内部并发执行，结果按模型原始顺序持久化，guidance/stop/取消在整批落盘后统一处理；Bash、MCP、网页、审批和 Goal/Plan 写操作保持串行。Session JSONL、工具结果格式、默认串行 provider 请求形状和公开命令均未改变。

工作区展示号提升至 `0.2.11`。新增 Agent Loop/ReactAgent 回归覆盖并行顺序、混合边界、stream recovery 成功与预算耗尽回退，以及默认/显式 `parallel_tool_calls` 请求标记。验证结果：`pnpm test` 为 231 项通过、1 项取消（既有 Windows Bash abort 15 秒超时）；`pnpm typecheck`、`pnpm build` 和 `git diff --check` 通过。已完成隔离本地 SSE 端到端冒烟：半截流重试、两个只读工具并行且按原序落盘、工具 follow-up、Ctrl+C 取消均通过。真实 `deepseek-flash` Windows Terminal 冒烟暂未执行，因为当前系统凭据存储将已注册模型标记为 missing；TUI 已验证能正确提示并退出。本次只提交并推送代码，不创建 tag 或远程 Release。

## Prompt cache 基础能力

Responses usage 中的 `cached_tokens` / `cache_write_tokens` 继续通过现有 usage 事件累计并在 `/status` 显示读取量、写入量和命中率。不缓存完整模型回答；旧 Session、DeepSeek、未知兼容端点及缺少缓存详情的 provider 保持兼容并显示 `N/A`。Session JSONL 事件类型保持不变。

## 最新优化：Agent Loop 可靠性恢复边界

状态快照：2026-09-23。Agent Loop 现在只把带 `response.completed` 的 SSE 响应视为成功；stream 在首个事件前明确拒绝时才切换到 buffered，并在当前 Agent 生命周期内记住该能力结果。连接中断、异常 EOF 和半截响应从最后一个已持久化 context 有界重试，不启动半截工具。明确的 context-limit 错误每个 turn 最多触发一次原生 Responses compaction 和恢复采样，普通 400、压缩失败和第二次超限不会进入该恢复路径。

- 新增响应错误分类、stream transport 状态和模型失败详情；Session JSONL schema、工具串行语义、审批和现有 `LoopEvent` 保持兼容。
- 新增响应恢复与边界回归；Agent 定向测试当前为 38/38，通过 typecheck、build 和 `git diff --check`。
- 全量 `pnpm test` 为 217 项通过、1 项取消、无失败；唯一取消项是既有 Windows Bash abort 用例在 15 秒超时，单独复跑仍可复现，与本轮 Agent Loop 改动无关。
- 真实流式/兼容端点 Windows Terminal 冒烟仍待完成；本轮未改变 Session JSONL schema、工具串行语义或公开命令。
- 工作区展示号同步升至 `0.2.10`；本次使用 `[skip ci]` 推送代码，不创建 tag 或远程 Release。

## 最新优化：memory 分层、召回与聊天级策略

状态快照：2026-09-23。learned memory 现在支持兼容旧 Markdown 的 `id/kind/confidence/status/evidence/source session` metadata；项目条目按当前问题和工作区关键词进行可解释召回，过滤 archived/superseded 条目并使用独立字符预算。生产 Agent capture 使用 5 分钟 idle grace period，capture 状态会记录 queued/running/succeeded/skipped/failed；当前聊天可分别关闭已有 memory 读取或未来 capture，且 `/memory` 可以归档最新条目。旧 Session JSONL schema、Session context 和 Responses compaction 语义保持不变。工作区展示号同步升至 `0.2.8`；本次提交使用 `[skip ci]`，不更新远程 Release。

- 新增 memory store/runtime archive/delete、policy 和 idle capture 回归；旧 Markdown 会按兼容默认值读取。
- 更新 `DECISIONS.md`、`PLAN.md`、中英文 README，明确 learned memory 只是不可信 recall，不替代 `AGENTS.md`、当前指令、工具结果或 compaction。

## 最新功能：`/resume` 批量删除 Session

状态快照：2026-09-20。`/resume` 的 Session 列表现在支持 `MultiSelect` 批量勾选并永久删除本地 JSONL 记录，删除前显示二次确认；删除当前活动 Session 会清理内存状态并返回聊天界面，其他 Session 只刷新列表。新增 SessionStore 和 TUI 回归；完整 `pnpm test` 206/206、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。展示号同步升至 `0.2.7`；本次提交使用 `[skip ci]`，不更新远程 Release。

## 最新修复：Banner 長安司矩对齐

状态快照：2026-09-20。参考 `question/image.png` 保留金色双线框与“長安 · 司矩”样式，并改用终端单元格宽度计算左右留白；中文双宽字符现在在框内视觉居中。新增 Banner 回归，确认左右留白只差一个单元格。展示号同步升至 `0.2.6`；本批次随 `main` 推送触发自动发布流程。

## 最新功能：Context compaction

状态快照：2026-09-20。已加入 `/compact` 和自动 context 压缩：两者调用供应商原生 Responses `/responses/compact`，不做本地摘要回退；压缩返回的完整 context window 原样进入后续模型请求，完整可见 transcript 和旧 JSONL timeline 保持不变。压缩事件以 `context_compacted` 持久化，并计入 session 累计 token usage。

- 已知模型 context window 达到 80% 时，在下一次采样前自动压缩；未知 window 不自动触发。手动 `/compact` 只接受无参数命令，模型轮次或直接 `!` 命令运行时明确拒绝，Esc 可取消正在进行的压缩。
- 新增 Agent compaction lifecycle、上下文替换回调、TUI transient loading/info、原生 provider client 映射、SessionStore schema 兼容解析及 Agent/Session/TUI/slash command 回归；当前完整 `pnpm test` 为 203/203，`pnpm typecheck`、`pnpm build` 和 `git diff --check` 通过。

## 最新功能：Plan 与 Goal

状态快照：2026-09-20。已加入严格只读 `/plan` 和绑定 Session 的持久化 `/goal`。`/plan` 支持持续模式、`/plan <需求>`、结构化策略问题、Other 自定义答案、计划 review 和批准后同一 Session 执行；Plan 工具列表不包含 Bash/MCP，启用 web 时公共联网请求不逐次确认。`/goal <目标> [--tokens N]` 确认后立即运行，目标通过 `goal_updated` JSONL 事件持久化，恢复原 Session 后 active goal 自动继续，支持 pause/resume/complete/blocked/budget_limited/usage_limited。

- 新增 `src/plan/runtime.ts`、`src/goal/runtime.ts` 和 Plan/Goal transient surfaces；Agent loop 支持工具结果持久化后安全结束当前轮。
- 新增 Goal session schema、lifecycle、跨 Agent 重建仍有效的 blocker streak、Plan 参数边界、Plan mode tool allowlist 回归；现有 TUI/Agent/Session 行为保持兼容。
- 当前验证：完整 `pnpm test` 199/199、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 通过；测试仍会出现既有的 Ink resize listener `MaxListenersExceededWarning`，不影响结果。

## 最新修复：workspace-write 联网审批

状态快照：2026-09-20。修复权限策略错误：默认 `workspace-write` 开启网页工具时，`web_search` 和 `web_fetch` 现在直接执行，不再逐次弹出网页确认；`read-only`、`ask` 仍逐次审批，`full-access` 保持免审批，关闭网页工具仍拒绝联网请求。MCP 不受影响，继续使用独立审批。

- `webPermission()` 将 `workspace-write` 映射为 `allow`，并更新权限选择器、Agent 动态权限说明和中英文用户文档。
- 新增权限策略与普通 Agent 回归，确认 workspace-write 搜索网页不会调用 `confirmWeb`。

## 最新功能：Learned 经验记忆

状态快照：2026-09-20。已加入独立的 learned memory：实质且正常完成的回合由当前模型在后台提炼可复用项目经验；用户明确表达长期偏好或执行 `/memory remember <text>` 时写入用户级经验。项目/用户条目均保存为应用状态目录下的 Markdown，不进入仓库或 Session JSONL；新 Agent 实例只在首个模型请求前读取一次，并以不可信背景块注入。

- 新增 `src/memory/learned-memory.ts`：项目路径哈希隔离、原子写入、串行追加、100 条上限、去重、secret/prompt-tag 脱敏、状态统计和结构化提炼调用。
- `ReactAgent` 正常完成后异步排队提炼；取消、失败和 trivial turn 不写入，提炼失败不影响主对话。当前模型用于提炼，调用使用 `store: false`。
- 新增 `/memory` transient 命令窗口：查看状态与最近条目、用 `/memory view` 查看实际注入快照、暂停/恢复自动积累、分别清理项目/用户经验；`/memory remember <preference>` 保存长期用户偏好。
- 新增 memory store、Agent 首轮注入、TUI surface 和 `/memory` 回归测试；完整 `pnpm test` 为 187/187，`pnpm typecheck`、`pnpm build` 和 `git diff --check` 已通过。测试仍会出现既有的 Ink resize listener `MaxListenersExceededWarning`，不影响结果。
- 工作区展示号已提升至 `0.2.2`；本次只提交并推送代码，不创建 tag 或 GitHub Release。

## 最新优化：已安装 Skill 查看界面

状态快照：2026-09-20。`/skills` 的 View installed Skills 流程已从单行 `Select` 改为可扫描的四行目录：名称与作用域、最多两行描述、ready/conflict/unavailable 状态；列表和详情不再显示路径，把终端空间留给辨识信息。顶部显示总数和当前位置，支持上下翻页、Home/End、Enter 进入详情。详情页先展示 Skill 名称、描述、作用域和状态，再分页阅读完整 `SKILL.md`，原有 `$name` 回填、Esc 返回和冲突保护保持不变。

- 参考 OMP 的轻量 metadata catalog 思路，列表只承担发现和选择，完整 Skill 内容延迟到详情页展示。
- 新增 `installed Skill list presents metadata before opening the full document` 回归；定向 Skill TUI 测试 4/4、完整 `pnpm test` 181/181、typecheck 和 diff 检查通过。
- 工作区展示号已提升至 `0.2.1`；本次只提交并推送代码，不创建 tag 或 GitHub Release。

## 最新整理：TUI 源码职责分层

状态快照：2026-09-19。`src/tui` 原先把应用编排、命令、渲染工具和 18 个不同职责的组件集中在根目录及单一 `components` 目录；现已按职责整理为 `app`、`commands`、`composer`、`rendering`、`terminal`，并把组件划分为 `conversation`、`feedback`、`navigation`、`screens` 和 `wizards`。目录说明和依赖方向见 `architecture/TUI_STRUCTURE.md`。

本批次已把 `package.json` 与中英文 README 展示号提升到 `0.2.0`。提交 `c8f96a06b4d59d2f217c595c1214fbea741c7cf9` 已推送至 `origin/main`；Release workflow `35445879162` conclusion 为 `success`，远端 `v0.2.0` tag 解析到该提交，GitHub Release 已发布且 draft/prerelease 均为 false。

- `index.tsx` 继续作为公开入口，`app/app.tsx` 保留完整状态机；本轮只移动模块、更新内部与测试导入，并为少量底层模块补职责注释，没有改变 Session schema、TUI 行为或用户可见命令。
- 定向 TUI 测试 80/80、完整 `pnpm test` 181/181 通过，`pnpm typecheck`、`pnpm build` 和 tracked/new-file diff 检查均通过；diff 检查仅报告既有 Windows LF/CRLF 提示。

## 最新修复：含镜像副本的 Git Skill 仓库安装

状态快照：2026-09-19。`https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep` 当前 Git tree 包含 189 个 `SKILL.md`：83 个规范 `skills/<name>` 包，以及 `skills/skills-codex*` 下 106 个同名平台/评审镜像副本。旧实现虽然会按 metadata 名称去重并优先规范目录，却在读取 metadata 前把 100 个限制错误地应用到原始清单数，因此直接报 `Git Skill source contains more than 100 candidate Skills`。

- Git 原始清单扫描新增独立 500 项上限；100 项安全限制改为只对按 Skill 名称去重后的不同候选生效，规范 `skills/<name>` 目录仍优先于镜像副本。
- 新增 189 个清单归并为 83 个候选以及 101 个不同候选仍被拒绝的回归测试。已用真实仓库根 URL 完成只暂存不安装的网络冒烟，成功返回 83 个名称唯一的候选。完整 `pnpm test` 为 180/180 通过，`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过；diff 检查仅报告既有 Windows LF/CRLF 提示。

## 最新修复：大型 Git Skill URL 安装

状态快照：2026-09-19。修复 `/skills` 使用 `https://github.com/Imbad0202/academic-research-skills-codex` 时在 Windows 临时目录完整 checkout 5,088 个仓库路径，并因无关的深层打包副本触发 `Filename too long` 的问题。

本批次已把 `package.json` 与中英文 README 展示号提升到 `0.1.28`。发布提交 `29817b995bd83a87b556bfba9084818533078961` 已推送至 `origin/main`；Release workflow `35444192023` conclusion 为 `success`。远端 annotated tag `v0.1.28` 的 tag object 为 `dcdd27bea1565400e8fbd4ec311e466c4913ae28`，解析到该发布提交；GitHub Release 已发布，draft/prerelease 均为 false。

- Git 来源改为 shallow、no-checkout clone，启用 Git long-path 配置；随后读取有界 `ls-tree` 和候选 `SKILL.md`，同名打包副本优先保留规范 `skills/<name>` 路径，预检 symlink/gitlink、文件数量、单文件及总字节数后才 sparse checkout 候选目录。Git stderr 失败信息去除 checkout 进度噪声。
- 远端安全限额按阶段拆分：ZIP 10,000 项、来源遍历 10,000 项、单个 Skill 5,000 项、Git tree 20,000 tracked entries、候选最多 100；继续保留 50 MiB 包总量、10 MiB 单文件、512 KiB `SKILL.md`、60 秒 Git 准备、公开 HTTPS、无认证和无覆盖语义。
- 已用真实网络分别复验仓库根 URL 和 `tree/main/skills/academic-research-suite` URL，均成功返回唯一 `academic-research-suite` 候选并预览 2,531 个文件，不再出现 Windows 长路径错误。当前用户根已经存在同名 Skill，因此未执行覆盖安装；既有无覆盖保护保持不变。
- 新增超过旧 2,000 项但仍在新安全边界内的 ZIP 回归，以及 no-checkout/long-path Git 参数和 NUL 分隔 tree 解析回归。完整 `pnpm test` 为 179/179 通过，`pnpm typecheck`、`pnpm build`、`git diff --check` 均通过；diff 检查仅报告既有 Windows LF/CRLF 提示。

## 最新工作区补充：Codex sandbox、MCP 与 Skills 管理

状态快照：2026-09-19。已按 OpenAI 官方文档和 `openai/codex` 提交 `78245b47af2a7aafcabe025828ceecca69db4df1` 接入三条能力；详细源码映射、支持范围和未覆盖能力见 `architecture/CODEX_CAPABILITIES.md`。

- 固定运行时依赖 `@openai/codex@0.155.1`。所有模型 shell 调用经 `codex sandbox` 执行：read-only → `:read-only`，ask/workspace-write → `:workspace`，full-access → `:danger-full-access`；sandbox 缺失或启动失败时不回退宿主执行。Windows restricted token 下 Git Bash/MSYS 会报 `E_ACCESSDENIED`，因此 Windows 模型命令改用 PowerShell；直接 `!` 仍为原生交互 PTY。
- 新增 MCP runtime：从 `codex mcp list/get --json` 读取同一份配置，以官方 TypeScript SDK 连接 stdio/Streamable HTTP，支持静态/环境 header、bearer env、超时、tool filter、server instructions、命名空间、取消和单服务器错误隔离。除 full-access 外 MCP 调用逐次独立审批；`/mcp` 刷新并显示状态。OAuth 凭据复用、header helper、resources/prompts/elicitation/tasks 尚未接入。
- Codex 主机 Skill catalog 扫描项目逐层 `.agents/skills`、项目 `.codex/skills`、`$CODEX_HOME/skills`、`~/.agents/skills` 和 admin 根；校验 YAML frontmatter，限制扫描/文件/catalog 大小。显式 `$name` 只在本轮注入完整 `SKILL.md`，隐式命中通过 `read_skill` 分页读取并约束相对资源；同名冲突保留在管理列表中，但不会进入模型 catalog，也不能通过 `$name` 或 `read_skill` 静默选择。
- `/skills` 已从只读状态页扩展为管理向导：可逐次选择项目/用户作用域；根据自然语言由当前模型生成单个 `SKILL.md`，并支持 AI 校验改进、完整手动编辑、确认保存；也可从公开 HTTPS GitHub/Git 仓库、直接 `SKILL.md` 或 ZIP 暂存来源，多个 Skill 时选择一个，预览完整内容后选择作用域并明确确认安装；已安装列表可查看全文并回填 `$name`。
- URL 安装限制为公开来源，拒绝 URL 凭据、私网/本机目标、路径穿越、符号链接和特殊文件，限制重定向、超时、下载/解压大小及条目数，并采用目标根内 staging + rename；任一发现根已有同名 Skill 或目标存在时拒绝覆盖。私有认证、更新、删除、Plugin/远端 runtime provider 和 `[[skills.config]]` 尚未接入。
- 没有改变 Session JSONL schema。MCP function call/result 继续进入既有 context；连接 header/token/env 不进入模型 instructions、transcript 或 session。Skill catalog、连接和权限授权均不从 JSONL 恢复。
- 已完成 Windows 本地 sandbox PowerShell 冒烟、空 MCP 配置冒烟、真实 stdio MCP 握手/工具调用测试，以及 sandbox 路由、权限映射、Skill 发现/激活/同名冲突/路径逃逸、创建/远端暂存/安装和 `/skills` 三条 TUI 流程回归。完整测试、typecheck、build 和 diff 检查结果见下方“验证结果”。

## 最新发布确认：v0.1.27

状态快照：2026-09-19。`v0.1.27` GitHub Release 已创建成功。发布提交 `abd7084adfaea58401b1bde8fdef1c1294e09d53` 已推送至 `origin/main`；远端 annotated tag `v0.1.27` 的 tag object 为 `5d330293c610f3e6aedafaaba5ae7ec6f9a9dae6`，解析到该发布提交。Release workflow run ID 尚未记录。

## 最新工作区补充：实时进度、运行中 steering 与分段计时

状态快照：2026-09-18。本轮将 Responses 请求改为 SSE 优先、buffered fallback：支持流式的端点逐步显示 assistant 文字，工具审批、开始/结束、重试和 steering 状态即时进入 TUI；不支持 SSE 的兼容端点继续使用原有阶段和命令预览。增量只在当前 UI 保留，完整 assistant/tool 结果仍按原顺序持久化。

运行中的 Prompt 继续可用。真实 `ReactAgent` 收到 guidance 后会中止当前 sampling，在已落盘上下文上继续；工具已启动时先保存工具结果，未启动的后续 function call 写入 `steered` output，再带着新消息继续。Ctrl+C 时会将已接收的待处理 guidance 保存进 context，避免遗留到下一次无关任务。旧测试替身没有 steering 接口时保留 FIFO 下一轮兼容行为。耗时从 `Ns` 自动切换为 `Nm Ns` 和 `Nh Nm Ns`。

新增 Agent loop、Responses stream、steering、取消保留 guidance、计时格式回归测试。定向 Agent/TUI 测试 58/58（Agent 23/23、TUI 35/35）。最终 `pnpm typecheck`、`pnpm build` 和 `git diff --check` 通过。完整 `pnpm test` 为 157 项通过、1 项取消：既有 Windows Git Bash `Bash abort stops a running child` 15 秒超时；未见本轮新增测试失败。真实 Windows Terminal 与真实流式供应商验收待完成。


## 最新工作区补充：运行中交互与 Codex 风格权限 profile

状态快照：2026-09-18。模型工作期间始终显示 guidance composer。此前普通消息按 FIFO 在当前轮结束后执行；现已由上方最新补充改为真实 Agent 在采样/工具安全检查点执行 steering。Ctrl+C 仍立即取消当前轮次。直接 `!` 运行交互式 PTY 时继续独占 stdin，避免把键盘输入同时送给 composer 和子进程。

`/permissions` 现提供四档 profile：`read-only`（工作区读取直接可用，模型 shell/web 逐项审批）、`ask`（模型 shell/web 每次审批）、`workspace-write`（默认，当前 workspace 内模型 shell 无逐条审批，web 仍逐项审批）和 `full-access`（二次确认后跳过工具审批）。这是 v0.1.27 发布时的历史状态；上方最新工作区改动已补入 Codex OS sandbox 和独立 MCP 审批面。

新增运行中 guidance、四档 profile、网页审批和权限映射回归测试。定向测试 51/51、typecheck 和 build 已通过；完整 `pnpm test` 为 151/152，通过项未见本轮新增失败，唯一取消项仍是既有 Windows Git Bash 进程树终止 15 秒超时。真实 Windows Terminal 验收仍待完成。


## 最新工作区补充：Codex 历史重放行数上限

已读取 `openai/codex` 的 `7498521d288b9b3b96ffba4eedf089d8d6e06a84`：`codex-rs/tui/src/resize_reflow_cap.rs` 为 resize/replay 使用终端行数上限，VS Code 1,000、Windows Terminal 9,001、WezTerm 3,500、Alacritty 10,000、未知终端 1,000；普通 transcript 没有全局记录数上限。`app_server_session/history.rs` 的 5 turn / 100 item / 400 scan 是远端 paginated thread API 的加载参数，不适用于必须完整恢复本地 JSONL 的 Everpeace。

已删除自定义的 200 条 timeline 窗口，改为按 `WT_SESSION`、`TERM_PROGRAM` 和 VS Code 注入环境解析上述行数上限，再依据当前列宽、换行和常见双宽字符估算 source-backed replay 尾部。单条超长记录保持原子显示；完整 Session、context、输入导航和 `/outputs` 不裁剪。窗口起点改变仍通过同步清屏重放，`/clear` 现在抑制由新 banner ID 造成的重复重放。新增环境选择、换行、源数据保留与 TUI 集成回归。

本次 `history-window` 单测 4/4、`app.test.tsx` 32/32、完整 `pnpm test` 148/148、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。首次完整测试的 Bash 取消 15 秒超时未在单独运行或完整重跑中复现；此前 node_modules `EPERM` 也未复现。v0.1.26 已提交、推送和发布，详见下方最新发布。


状态快照：2026-09-18。分支 `main`，v0.1.26 已发布：在既有 Agent Loop、权限、终端交互和恢复会话基础上完成英文优先 TUI、富文本显示和 Codex 对齐的历史重放行数上限。远端 `main` 与现有标签的提交标题已按具体功能语义统一，旧 SHA 不再作为远端分支或标签依据；改写前完整历史保存在本机 `.git/commit-message-rewrite-backup.bundle`。用户原有未跟踪 `.patch-node-pty/`、`benchmark/`、`test-me/` 未改动且不纳入发布。

v0.1.26 候选改动在此基础上完成英文优先 TUI 与富文本显示：宿主界面全部使用英文，Agent sampling/tools phase 分别驱动 provider 感知的 `Waiting for …` 计时状态与 `Working`；assistant 回复支持 GFM Markdown 和代码高亮；Bash/PowerShell 命令使用 Running/Ran/You ran 分层卡片；标准 unified diff 在 transcript、实时预览和 `/outputs` 中显示新旧行号及增删高亮。旧 JSONL 不迁移，已知旧中文 system/tool/error 文案和“新 Session”标题只在显示层翻译，用户与 assistant 内容保持原文。新增 `marked`、`lowlight` 运行时依赖，package 与 README 展示号已调整为 0.1.26。

本轮没有改变 Responses context、Session schema、权限语义、inline/scrollback、直接 PTY 输入或首五/尾五缓冲。新命令不再额外持久化重复的 `! command` 和成功提示；可选 command 元数据继续提供来源、状态、耗时和审计信息，旧记录仍可恢复。

## 最新发布

v0.2.0 修复包含大量镜像 Skill 清单的 Git 仓库被旧候选上限误拒绝的问题，并按应用编排、命令、输入、渲染、终端和组件职责重新组织 TUI 源码目录；用户可见行为与 Session schema 保持不变。

- 提交 `c8f96a06b4d59d2f217c595c1214fbea741c7cf9` 已推送至 `origin/main`；远端 `v0.2.0` tag 解析到该提交。
- Release workflow `35445879162` 已完成且 conclusion 为 `success`；`v0.2.0` Release 已发布，draft/prerelease 均为 false。
- Release: https://github.com/VinceTree/Everpeace/releases/tag/v0.2.0
- 发布前冻结锁文件安装、180 项测试、typecheck、build 和 diff 检查全部通过；真实大型 Git Skill URL 冒烟返回 83 个去重候选。

v0.1.28 增加平台原生 sandbox 路由、MCP tool runtime、Skills 发现/渐进读取及 `/skills` 创建/URL 安装/查看工作流，并修复大型 Git Skill 在 Windows 上因无关深层路径和旧条目上限导致的安装失败。

- 发布提交 `29817b995bd83a87b556bfba9084818533078961` 已推送至 `origin/main`；annotated tag `v0.1.28` 的 tag object 为 `dcdd27bea1565400e8fbd4ec311e466c4913ae28`，解析到该提交。
- Release workflow `35444192023` 已完成且 conclusion 为 `success`；`v0.1.28` Release 已发布，draft/prerelease 均为 false。
- Release: https://github.com/VinceTree/Everpeace/releases/tag/v0.1.28
- 发布前冻结锁文件安装、179 项测试、typecheck、build 和 diff 检查全部通过；真实 GitHub 仓库根 URL 与 folder URL 均完成候选预览冒烟。

v0.1.27 增加 Responses SSE 实时进度、运行中 safe-checkpoint steering、分段耗时显示和 Codex 风格四档权限 profile，并保留兼容端点的 buffered fallback。

- 发布提交 `abd7084adfaea58401b1bde8fdef1c1294e09d53` 已推送至 `origin/main`；annotated tag `v0.1.27` 的 tag object 为 `5d330293c610f3e6aedafaaba5ae7ec6f9a9dae6`，解析到该提交。
- `v0.1.27` GitHub Release 已创建成功；workflow run ID 尚未记录。
- Release: https://github.com/VinceTree/Everpeace/releases/tag/v0.1.27
- 发布记录对应的自动验证为 157 项通过、1 项因既有 Windows Git Bash 取消测试超时而取消；typecheck、build 和 diff 检查通过。

v0.1.26 增加英文优先 TUI、Markdown/代码/命令/diff 的富文本渲染，并将 transcript resize/replay 由固定 200 条记录改为 Codex 对齐的终端行数上限。

- 发布提交 `9f9213718fc0b9d2c3b473d755bd6c0b62ff9445` 已推送至 `origin/main`；annotated tag `v0.1.26` 的 tag object 为 `28e96b77237d2e19d23924b3853ba7f42018de51`，解析到该提交。
- Release workflow `35322141963` 已完成且 conclusion 为 `success`；`v0.1.26` Release 已发布，draft/prerelease 均为 false。
- Release: https://github.com/VinceTree/Everpeace/releases/tag/v0.1.26
- 发布前 148 项测试、typecheck、build 及 diff 检查全部通过。

v0.1.25 为模型 Bash 增加 1 MiB 有界实时缓冲，保留真实首五行和尾五行并按终端高度自适应展示；直接 `!`、完成态折叠、`/outputs`、模型 context 和 JSONL 语义保持不变。

- 发布提交 `8f88cc1d69e2334378a9a3c3e8eb5c71d9270c8d` 已推送至 `origin/main`；annotated tag `v0.1.25` 已解析到该提交。
- Release workflow `35300619208` 已完成且 conclusion 为 `success`；`v0.1.25` Release 已发布，draft/prerelease 均为 false。
- Release: https://github.com/VinceTree/Everpeace/releases/tag/v0.1.25
- 发布前 131 项测试、typecheck、build 及暂存 diff 检查全部通过。

上一版本记录：

v0.1.24 已接入 Codex 核心 Agent Loop 的 TypeScript 适配。详见 `architecture/AGENT_LOOP.md`。保留既有端点、权限、Session 和工具接口，不新增 OS 沙箱或完整 Codex 服务。包含上游 Apache-2.0 许可证及改动说明。

- 发布提交 `fd4b84ced48b9dd2aa06f5f23577fbc39e100466` 已推送至 `origin/main`。
- Release workflow `35232398930` 已完成且 conclusion 为 `success`；`v0.1.24` Release 已发布，draft/prerelease 均为 false。
- Release: https://github.com/VinceTree/Everpeace/releases/tag/v0.1.24
- 发布前 124 项测试、typecheck、build 及暂存 diff 检查全部通过。

- 发布提交 `4ab700f8407c4bb66bcce72f90286c456c9f0b03` 已推送至 `origin/main`。
- Release workflow `35229886201` 已完成且 conclusion 为 `success`；`v0.1.23` GitHub Release 已发布，draft/prerelease 均为 false。
- Release: https://github.com/VinceTree/Everpeace/releases/tag/v0.1.23
- 发布前冻结锁文件安装、118 项测试、typecheck、build 通过；暂存 diff 检查发现补丁上下文空白后已调整补丁 hunk 并重建锁文件，复验 Windows PTY 六项测试及暂存 diff 检查通过。
- 仅发布 GitHub 源码，不发布 npm 包；保留 pnpm 补丁安装要求和真实终端手动验收限制。

## 本轮终端交互改进

- 后续 Bug 修复：`/resume` 原先只恢复 transcript/context，未从会话构建输入导航；现恢复保存的用户输入和带 source=user 元数据的直接命令，并清空导航草稿。召回 `/resume` 等斜杠历史不再触发候选菜单抢占方向键，Down 到末尾回到空输入。
- 400 缺失 tool output 的可复现路径：旧 JSONL 中断后仅有 function_call，或工具执行器抛错导致结果未追加。Agent 现幂等修复旧上下文缺失结果为 interrupted/结果未知，工具异常也返回结构化 output；不自动重跑、不改写旧 Session 文件。新增完整批次保留、旧批次修复及下一轮可用性回归。

- Ctrl+C 取消活动模型请求、审批或命令；空闲时先清草稿，空输入退出。模型取消补齐待处理 function outputs，下一轮仍可使用。
- 全局输入历史跨进程重启保存，支持上下键恢复与草稿还原；`/history` 浏览和明确确认后清理。多行粘贴不会提交，编辑状态和历史导航在 Prompt 重挂载后保留。
- `/terminal-setup` 预览稳定版 Windows Terminal Shift+Enter 设置，明确确认后备份和修改 JSONC，拒绝冲突及过期预览。本轮没有修改用户真实终端设置。
- 模型 Bash 新增独立 1 MiB 有界实时缓冲：即使超大输出也保留真实首五行和尾五行，正常终端显示 5+5 及省略数量，矮终端首尾自适应缩减。用户直接 `!` 仍显示最近五行；完成态前二后四折叠、`/outputs`、最终工具结果、模型 context 和 JSONL 均保持原语义。
- 直接 PTY 支持 Ink 转发交互输入；取消会释放输入所有权。修复 node-pty 1.1.0 Windows 控制台退出竞争和自然退出 worker/socket 泄漏，以 pnpm 补丁形式保存。
- 新增覆盖真实 PTY 取消与 PID 结束、Read-Host 输入、下一轮 TUI 可用、输出截断和 UTF-8 边界、Session 元数据、输入历史并发写入、Shift+Enter 和粘贴、终端设置备份与冲突的测试。
- 采用兼容性可选 output 元数据而非新增 timeline 类型；模型 Bash 非交互，用户 `!` 保留交互；Unix Bash 当前直接终止进程组。Preview/其他 Windows Terminal 安装路径不自动修改。
- 本次 GitHub Release 分发源码，支持仓库 pnpm 安装，以应用 `patches/node-pty@1.1.0.patch`；普通 npm 下游安装不继承根项目 pnpm 补丁，本次不发布 npm 包。中英文安装说明已明确限制。
- `.patch-node-pty/` 是本轮 pnpm 补丁工作目录；自动审批审查两次拒绝递归删除（仅返回 blocked by policy），因此保留，勿误当作产品源码提交。

## 本轮权限管理

- Codex 官方权限、沙箱、规则与 CLI 文档已读取；摘录、来源和实现差异见 `architecture/PERMISSIONS.md`。pi/Grok Build 尚未对标。
- `/permissions` 独立命令窗口保留四档审批语义；模型 shell 现进一步映射 Codex 原生 profile，full-access 仍要求二次确认；网页工具独立开关，MCP 独立审批。
- 新增 `read_file` 和 `list_directory`，工作目录范围校验、realpath 越界检查、UTF-8/大小/目录项上限。结果进入 context，错误返回模型。
- 权限进程内保留，重启复位；不从 JSONL 恢复权限，不重建 Agent，不改变 Session schema。直接 `!` 保持原语义。
- 已接入固定 Codex CLI 的 OS sandbox，但仍不是完整 Codex runtime 或 Codex Auto；命令前缀授权、managed policy、持久权限和网络代理策略未实现。full-access 有宿主用户权限，路径竞态限制仍见安全文档。
- 修正等待 Bash 确认时 Ctrl+C 未解除等待的问题，并在执行工具前检查取消信号。
- 待真实 Windows Terminal 验收权限选择、完全访问确认/取消、只读文件查看、关闭联网，以及跨目录恢复后的文件根目录。

## 1. 当前目标

Everpeace 需要提供完整的本地 Session 工作流：

- 普通首问自动创建 JSONL session。
- `/new` 立即创建并进入一个空 session。
- 首问由当前模型后台概括 session 名称。
- `/resume` 恢复完整历史、模型 context、模型和工作目录，并继续聊天。
- 输入开头的 `/` 显示可筛选、可键盘操作的 slash command 菜单。
- `/status` 使用 Codex 风格独立命令窗口展示当前版本、模型、供应商、Base URL、目录、session 和 token/context 用量，窗口隐藏原会话内容，Esc 原子恢复原 Session。
- 信息型 slash command 和选择型 picker/wizard 都使用独立命令窗口；这些界面只保留在当前 UI，不写入可恢复 session timeline。
- 所有独立命令窗口水平、垂直居中，外框最大 80 列，并在窄终端自适应保留安全边距。
- 保留既有 inline TUI、PTY 流式输出和 resize 稳定性行为。
- 当前 `deepseek-flash` 及其他支持 function call 的兼容模型可主动搜索网页、读取公共页面，并基于来源回答需要最新信息的问题。

## 2. 已完成

- 新增每 session 一个文件的版本化 JSONL SessionStore。
- 保存可见 timeline 和继续请求所需的 Responses context，不保存 API Key 或瞬时 UI。
- Session 文件按 ID 串行追加；列表按最后活动时间倒序；损坏文件隔离，不完整末行容错。
- ReactAgent 支持初始 context 和 context append callback，恢复后可继续完整对话。
- 首次普通提问先创建 session，再并行执行正常回复和标题生成。
- `/resume` 可查看本机全部 session，恢复原模型、原工作目录、timeline 和 context。
- 原模型不可用时可选择替代模型并保留 context；原目录不存在时不破坏当前会话。
- `/new` 要求活动模型，立即创建临时名为“新 Session”的记录、清屏并进入新 session。
- `/new` session 使用持久化 `title_pending`；首次提问或恢复后的首次提问会在同一 session 内完成命名，不重复建档。
- `/clear` 保持延迟创建语义，不作为 `/new` 的别名。
- 中英文 README、CLI/TUI help、PLAN 和架构决定已同步。
- `package.json` 与中英文 README 展示版本已提升至 v0.1.21。
- Release workflow 运行 `35214892486` 成功；`v0.1.21` annotated tag 指向 `28a46aa`，GitHub Release 已发布且不是 draft/prerelease。
- `package.json` 与中英文 README 展示版本已提升至 v0.1.22。
- Release workflow 运行 `35217510744` 成功；`v0.1.22` annotated tag 指向 `d450d0b`，GitHub Release 已发布且不是 draft/prerelease。
- 根级 `AGENTS.md` 已替换临时内容，集中记录新 Session 的启动顺序、架构不变量、关键代码入口和交付规则。
- Slash command 菜单在输入区下方按前缀实时筛选；最多显示八项，支持滚动选择、Enter 执行、Tab 补全和 Esc 关闭。
- 新增 `/status`：官方 Base URL 与 model 映射供应商和 context window；自定义或未知端点安全显示 `N/A`。
- 主 Agent 每次 Responses API 请求的 usage 都会累加并写入 session；工具循环中的中间响应也计入，后台标题请求不计入。
- 切换模型保留 session 累计输入/输出 token，并重置当前 context；旧 session 或兼容端点缺少 usage 时显示为不完整统计。
- `/status` 卡片和其他 slash command 反馈不再写入 JSONL；usage 总量、模型选择等真实状态仍按原语义持久化。
- `/new` 的创建提示只在当前 UI 显示，新 session 的 timeline 在首问前保持为空。
- `/status`、`/models`、`/help`、无数据和命令错误，以及 `/model`、`/login`、`/logout`、`/resume` 等选择界面统一进入独立命令窗口；窗口隐藏 banner、历史、Prompt 和全局状态栏。
- 独立窗口通过同步清屏进入，`Esc 返回 Session` 时从内存原子重放完整 timeline；异步加载被取消后会忽略迟到结果，resize 期间也不会泄露历史。
- 独立窗口统一使用共享 `CommandScreen` 布局；Session 列表按窗口实际宽度截断，resize 后重新居中，窗口内部字段保持左对齐。
- `/new`、`/clear` 和 `/exit` 继续保持立即动作语义。
- 新增供应商无关的 `web_search` 和 `web_fetch` function 工具；DeepSeek Responses API 无需支持私有 built-in web search。
- 搜索通过 Bing 获取最多五条结果并以 DuckDuckGo 作为回退；真实网络冒烟已成功搜索 TypeScript 文档。
- 网页读取提取 HTML 正文或文本/JSON/XML，限制超时、响应体和模型输入长度；真实网络冒烟已成功读取 TypeScript 官方文档。
- 页面读取只允许公共 HTTP/HTTPS，校验每次重定向并阻止本机、内网、链路本地及含凭据的 URL。
- 联网错误作为结构化 function output 返回模型；外部取消信号仍会立即中止整轮请求。
- TUI 会把“搜索网页/读取网页”动作写入可恢复 timeline，完整搜索结果只进入模型 context，避免 transcript 被大段网页内容淹没。

## 3. 关键设计决定

- JSONL 事件包含 `session_created`、`title_updated`、`timeline_entry`、`context_append`、`model_selected` 和 `usage_recorded`。
- timeline 与模型 context 分开保存；直接 `!` 命令可恢复显示，但不进入模型 context。
- usage 在 session 范围内累计；模型切换保留累计输入/输出并重置 context，缺失 usage 的响应会把统计标记为 partial。
- `/status` 只读取当前状态，不会单独创建 session；其 transient `View` 不进入 `Static` timeline，恢复后重新执行可查看持久化的 usage。
- 信息型 slash command 使用 transient `View`，选择型命令使用 picker/wizard；两者都与聊天根视图互斥且不写入 JSONL。旧 JSONL 中已有的状态卡继续兼容恢复。
- 独立窗口保持 inline terminal，不启用 alternate screen；进入与返回复用同步输出和 source-backed replay，返回后定位在会话底部。
- 供应商和 context window 仅按已知的官方 Base URL 与 model ID 映射；自定义兼容端点不猜测上限。
- `/new` 立即建档；默认首问建档；`/clear` 只解除当前 session。
- `title_pending` 缺失时默认 false，以兼容本轮功能早期生成的 JSONL。
- 标题请求使用当前官方 model ID、无工具且 `store: false`；退出 TUI 时取消未完成的标题请求。
- 联网工具使用普通 function call 以兼容 DeepSeek 和自定义端点；网页内容一律视为不可信数据，模型必须引用实际采用的来源 URL。
- Session 恢复仍通过 `onReplayOutput` 原子重放，保持 inline 模式和原生 scrollback。
- 跨目录恢复通过 `process.chdir` 切换；失败时回滚并保留当前会话。
- Slash command 候选复用 `SLASH_COMMANDS` 作为唯一命令源；筛选逻辑保持纯函数，菜单不引入额外 `useInput` 监听器。

## 4. 主要实现位置

- `src/storage/session-store.ts`：JSONL schema、路径、读写、列表、恢复与兼容逻辑。
- `src/agent/react-agent.ts`：初始 context 和增量持久化 callback。
- `src/status/model-status.ts`：Base URL/provider/context 映射、usage 累加与 status snapshot 类型。
- `src/tui/app/app.tsx`：session 生命周期、`/new`、`/resume`、命名和工作目录切换。
- `src/tui/components/screens/command-surface.tsx`：独立命令窗口、80 列自适应居中布局、可取消加载状态、Esc 返回和 `/status` 容器。
- `src/tui/components/screens/status-card.tsx`：共享状态字段、旧 timeline 状态卡兼容、临时面板详情和窄终端截断。
- `src/tui/components/navigation/session-picker.tsx`：名称和时间选择列表。
- `src/tui/app/dependencies.ts`：默认 SessionStore、标题模型请求及目录切换。
- `src/tools/web.ts`：Bing/DuckDuckGo 搜索、网页读取、正文提取、大小/超时限制和 SSRF 防护。
- `src/codex/cli.ts`、`src/tools/bash.ts`：固定 Codex CLI、sandbox profile 路由、平台 shell 与输出/取消。
- `src/mcp/runtime.ts`：Codex MCP 配置、连接、tool catalog、调用和状态。
- `src/skills/catalog.ts`：Codex 主机 Skill roots、frontmatter、同名冲突、catalog、显式激活和资源读取。
- `src/skills/manager.ts`：项目/用户 Skill 写入、公开 GitHub/Git/SKILL.md/ZIP 暂存、校验、预览准备及无覆盖安装。
- `src/tui/components/wizards/skill-wizard.tsx`：`/skills` 创建、安装和查看三入口向导，完整编辑/预览、作用域选择、确认与 `$name` 回填。
- `tests/unit/tools/web.test.ts`：搜索解析、正文提取、重定向验证和私网阻断回归。
- `src/tui/commands/slash-commands.ts`、`src/tui/composer/prompt.tsx`：slash command 筛选、菜单渲染和键盘交互。
- `tests/unit/status/model-status.test.ts`、`tests/unit/tui/status-card.test.tsx`：映射、累计和卡片布局回归。
- `tests/unit/storage/session-store.test.ts`、`tests/unit/agent/react-agent.test.ts`、`tests/unit/tui/app.test.tsx`：存储、usage 回调和完整 TUI 流程回归。

## 5. 验证结果

- `pnpm install --frozen-lockfile`：通过。
- `pnpm test`：最终重跑 179/179 通过；覆盖真实 stdio MCP 握手/调用、Skill catalog 与同名冲突、创建、直接 `SKILL.md`、多 Skill ZIP 选择、超过旧 2,000 项的受限 Skill 包、Git no-checkout/tree 解析、路径逃逸/私网阻断、Codex sandbox 路由、MCP/Skill Agent 路由及 `/skills` 三条 TUI 流程，既有 Bash、PTY、Session、Agent loop、stream、steering 和富文本回归也通过。此前一次运行命中过已知 Windows PTY 取消超时，后续完整重跑均通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `git diff --check`：通过，仅有 Windows LF/CRLF 提示。
- 源码英文扫描仅在 `legacy-translation.ts` 的兼容匹配表中保留中文；这些字符串不用于新 UI。
- 尚未在带真实模型凭据的 Windows Terminal 中手工完成 slash command 独立窗口、`/status`、`/new` 与 `/resume` 全流程验收。
- 尚未在真实 TUI 中让 `deepseek-flash` 自主完成一次 `web_search` → `web_fetch` → 带来源回答的端到端验收；工具执行器的真实网络冒烟已通过。

## 6. 下一步

优先在真实 Windows Terminal 中用真实模型验收 `workspace-write`/`read-only` sandbox、PowerShell 语法提示、`/mcp`、MCP 审批、`/skills` 创建/安装/查看和 `$skill-name`，同时复验英文等待状态、Markdown、长 unified diff、Ctrl+C、交互 `!` 和 `/outputs`。后续对标 pi/Grok Build，并单独设计 MCP OAuth/resources/prompts、私有/认证 Skill 来源、Skill 更新删除、Plugin/远端 runtime provider、managed policy 和 prefix rules；当前实现不得描述为完整 Codex runtime。

1. 在真实 Windows Terminal 中运行 `pnpm dev`。
2. 完成一次真实模型问答后执行 `/status`，确认窗口水平、垂直居中且不显示 banner、历史、Prompt 或全局状态栏，核对各状态字段，并确认 Esc 完整恢复同一个 Session。
3. 触发一次工具调用，确认工具循环的多次响应累计；切换模型后确认总输入/输出保留而 context 重置。
4. 使用自定义兼容端点或缺少 usage 的响应，确认未知 provider/context 显示 `N/A` 且 TUI 不崩溃。
5. 退出并 `/resume`，确认本轮 slash command 面板内容不会恢复；再次执行 `/status`，确认累计 usage 已恢复，同时复验旧版本保存的 status 卡片仍可读取。
6. 验证跨工作目录恢复、原模型缺失时选择替代模型，以及 `/clear` 仍在下一次提问时才建档。
7. 同时复验 Ctrl+滚轮缩放、普通滚轮、`! Get-ChildItem` 尾部流式输出、模型 Bash 的 5+5 首尾预览、单一 prompt 和窄终端 resize。
8. 在真实终端输入 `/`，复验八项候选窗口滚动、逐字筛选、Enter 执行和 Tab 补全；再打开 `/help`、`/models`、`/status` 及各 picker，确认所有独立窗口居中、完全隐藏历史并可用 Esc 返回。
9. 配置一个真实 stdio MCP server，执行 `/mcp` 后让模型调用 tool，确认非 full-access 会审批、拒绝不会重试、结果可恢复；再验证一个需要 bearer env 的 Streamable HTTP server。
10. 用 `/skills` 分别在项目/用户作用域创建 Skill，并从公开 GitHub folder、直接 `SKILL.md` 和多 Skill ZIP 安装；确认预览/确认、重复名称拒绝、Esc 清理以及 View → `$name` 回填，再分别验证显式和 description 隐式匹配、引用资源约束及下一轮不自动延续。
11. 在真实 TUI 中询问一个明确依赖最新信息的问题，确认 `deepseek-flash` 会显示搜索/读取动作、引用来源，并能从单个来源失败中恢复。
12. 后续功能改动继续同步更新版本计划、测试状态和相关 docs。

## 7. 继续遵守的约束

- 保留 dirty worktree，不要 reset、checkout 或覆盖现有修改。
- API Key 继续由 `AuthStorage`/系统 keyring 管理，session 文件和 UI 不显示 key。
- 模型名保持供应商官方 model ID。
- 保持 inline TUI；不要切换 alternate screen，不允许原始 PTY 控制序列写入 Ink stdout。
- 每次修改功能、行为、接口或测试状态后，同步更新相关 `docs/` 文档。
- 每个新 Session 先读根级 `AGENTS.md` 和本文件；长期规则放在 `AGENTS.md`，实时状态只更新本文件。
