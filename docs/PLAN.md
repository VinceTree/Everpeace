# Everpeace Current Plan

## Plan 与 Goal

## Session deletion

`/resume` 的 Session 列表支持进入删除模式，用 `MultiSelect` 勾选多个本地 Session，二次确认后永久删除对应 JSONL；删除当前 Session 会解除当前会话并回到聊天界面，删除其他 Session 只刷新列表。

## Context compaction

已加入 Codex 风格的 `/compact`：手动命令调用供应商原生 Responses `/responses/compact`，将其返回的完整 context window 原样作为后续模型输入；可见 transcript 与旧 JSONL timeline 不删除。压缩事件持久化为 `context_compacted`，并按普通模型请求累计 input/output/total token usage。

已知模型 context window 达到 80% 时，Agent 会在所有工具结果持久化后的下一次采样前自动压缩；未知 window 不自动触发。模型轮次或直接命令运行期间拒绝手动压缩，Esc/取消会中止请求。供应商不支持原生压缩时明确报错，不执行本地摘要回退。

已加入 Codex 风格的严格 `/plan` 和持久化 `/goal`：Plan 模式只开放工作区读取、网页、Skill 读取及结构化问题/计划审批工具，禁止 Bash/MCP 等副作用；网页开关开启时，Plan 的公共 web 请求不要求逐次确认，关闭网页工具仍拒绝访问。`/plan` 可持续进入规划模式，`/plan <需求>` 直接开始，批准后回到 Default 并在同一 Session 执行。Goal 绑定创建它的 Session，使用 `get_goal`、`create_goal`、`update_goal` 工具及 JSONL goal 事件保存状态；`/goal <目标> [--tokens N]` 确认后立即运行，active goal 每轮自动续跑，恢复原 Session 后继续，支持 complete/blocked/paused/budget_limited/usage_limited 状态。


## 历史显示上限

已读取 `openai/codex` 源码并采用其 terminal resize-reflow 行数上限：VS Code 1,000、Windows Terminal 9,001、WezTerm 3,500、Alacritty 10,000、未知终端 1,000。普通 Codex transcript 没有全局记录数上限；其 5 turn / 100 item 参数只用于分页的远端 thread API，不能替代本项目完整本地 JSONL 恢复。Everpeace 删除自定义 200 条记录窗口，改按当前宽度估算源文本行数选择重放尾部；完整存档、context、输入导航和 outputs 不裁剪。


状态快照：2026-09-19。

## Learned 经验记忆

已接入独立的 learned memory：实质且正常完成的回合由当前模型后台提炼项目经验；显式长期偏好进入用户级文档。经验存放在平台应用状态目录，不进入 Session JSONL 或仓库；新 Agent 实例首轮读取一次，并以不可信背景注入。`/memory` 提供状态、暂停/恢复、分别清理和显式记忆入口。首版使用 Markdown、原子写入、脱敏、去重和 100 条上限，不引入远程后端或向量检索。

## 实时 Agent 进度与运行中纠正

已完成 Responses SSE 优先、buffered fallback、实时 assistant delta/工具状态、运行中 safe-checkpoint steering 及分段耗时显示。流式增量和阶段状态只存在当前 TUI，不写入 Session JSONL；采样中的 guidance 会中止当前采样，工具执行中的 guidance 在结果落盘后生效，未执行的调用补齐 `steered` output。Ctrl+C 时已提交的待处理 guidance 会持久化到模型 context。

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
- [x] MCP stdio/Streamable HTTP 工具发现、命名空间、调用、超时、取消、单服务器故障隔离和独立审批；`/mcp` 可刷新状态。
- [x] Codex 主机 Skill roots、frontmatter 校验、metadata catalog、同名冲突隔离、显式 `$name`、隐式 `read_skill` 与相对资源约束。
- [x] `/skills` 管理向导：项目/用户作用域、AI 单文件创建与校验、完整手动编辑、公开 GitHub/Git/SKILL.md/ZIP 暂存预览、显式安装确认、带作用域/状态/两行描述的已安装 Skill 目录、完整内容查看和 `$name` 回填。
- [x] Skill 安装安全边界：仅公开 HTTPS、逐重定向公共地址校验、Git 重定向关闭、超时和大小/条目上限、路径穿越/符号链接/特殊文件拒绝、无覆盖暂存安装。
- [x] 大型 Git Skill 来源先无检出克隆并检查有界仓库树，只检出按名称去重后的候选目录；Windows 长路径不再被无关仓库副本触发，单个受限 Skill 可包含最多 5,000 个条目。
- [x] Git 仓库的原始 `SKILL.md` 清单上限与去重后的 100 个不同候选上限分离；包含大量同名平台/评审镜像副本的来源不会在名称去重前被错误拒绝。
- [ ] 后续单独设计 MCP OAuth/resources/prompts/elicitation、Codex Plugin/远端 Skill provider、managed policy 和 prefix rules；当前不得宣称完整 runtime 等价。

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
