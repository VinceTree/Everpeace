# Architecture Decisions

状态快照：2026-09-17。

## Session 持久化

- 每个 session 使用一个版本化 JSONL 文件，存放于平台应用状态目录；API Key 仍只进入系统 keyring。
- 可见 timeline 与 Responses API context 分开记录，保证恢复界面完整，同时不把直接 `!` 命令错误加入模型上下文。
- 写入按 session 串行追加；不完整末行可忽略，其他损坏只隔离对应文件。
- `session_created` 保存模型引用、工作目录及 usage tracking 能力；`model_selected` 表达模型变化及是否重置 context；`usage_recorded` 保存每次主 Agent 响应的 token 增量。

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

## Session 生命周期

- 默认采用延迟创建：没有活动 session 时，第一次普通提问先建档再请求模型。
- `/new` 是显式立即创建：要求已有活动模型，写入临时标题“新 Session”并立刻切换到新 timeline/context；创建提示只显示在当前 UI。
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

## 维护约束

- 功能、行为、接口或验证结果发生变化时，同步更新 `docs/PLAN.md`、本文件及 `docs/HANDOFF.md` 中受影响的内容。
- 根级 `AGENTS.md` 只保存跨 Session 长期有效的项目事实和工作约束；易变化的进度、验证结果及下一步统一记录在 `docs/HANDOFF.md`。
