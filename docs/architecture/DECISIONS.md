# Architecture Decisions

状态快照：2026-09-17。

## 权限管理

权限第一阶段详见 [PERMISSIONS.md](./PERMISSIONS.md)：`/permissions` 默认逐条审批 Bash；只读模式拒绝所有模型 Bash；完全访问经二次确认后免审批。文件工具始终限定工作目录，网页工具独立开关。权限仅存在当前进程，跨 new/clear/resume 保留，重启恢复默认，不从 JSONL 恢复；变更权限不重建 Agent 或丢失 context。这是应用层权限，不是 OS 沙箱。直接 `!` 保持原语义。

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

## 联网工具

- 联网能力使用 Responses API 普通 `function` 工具 `web_search` 和 `web_fetch`，不依赖供应商私有 built-in tool，因此 DeepSeek 和自定义 OpenAI-compatible 端点可复用同一 ReAct 循环。
- `web_search` 先请求 Bing HTML 搜索，失败或无结果时回退 DuckDuckGo HTML 搜索；每次最多返回五条标题、URL 和摘要，不需要额外搜索 API Key。
- `web_fetch` 只执行公共 HTTP/HTTPS GET，请求前解析 DNS，每次重定向重新校验，拒绝凭据 URL、localhost、本地域名、内网、链路本地和其他非公共 IP。
- 搜索页和目标页都有限时及响应体上限；页面正文最多向模型返回 30,000 字符。网络、解析和页面错误序列化为 function output，让模型可以解释失败或换用其他来源。
- 网页内容是提示注入边界之外的不可信数据；系统指令要求模型不得执行网页中的指令，并在最终回答中列出实际采用的来源 URL。
- 搜索和页面读取无需 Bash 确认，简短工具动作写入可恢复 timeline；完整 function call/output 继续按既有规则写入 Responses context。

## 任务取消与输入输出

- `/resume` 的输入导航从所选 timeline 中的 user 条目及 source=user 的命令输出恢复，不依赖新增全局历史文件；不将模型命令混入用户输入。不带来源的旧 tool 条目不能可靠区分用户与模型，故不推断。恢复成功清空草稿和导航索引，`/new`、`/clear` 回到全局输入导航。召回斜杠命令不自动打开候选菜单，编辑后恢复正常筛选。
- Agent 构造及每轮开始时修复不完整 function call/output 配对：在后续用户消息前补 interrupted/结果未知，不重新执行工具，不伪造成功。修复仅用于内存请求上下文，不重写旧 JSONL；再次恢复会幂等修复。工具执行异常转为错误 output，取消仍停止整轮。

- Ctrl+C 优先取消活动任务（含审批和子进程）；空闲有草稿时清空，否则退出。模型取消时为剩余 function calls 追加取消结果后停止，不留下未匹配调用。
- Ink 独占 TUI stdin，通过 writer 将输入转发给直接 `!` PTY；模型 Bash 使用非交互管道。Windows Bash 取消使用 taskkill 进程树；PTY 先发送 ETX，500ms 后通过 node-pty 关闭。Unix Bash 当前使用进程组强制终止，PTY 先 ETX 后强制终止。
- 输入历史独立于 Session 和模型 context，保存于 state 目录 input-history.json；保留最近 1,000 条、4 MiB，临时文件原子替换及跨进程文件锁。只记录主输入区提交，不记录登录向导字段；用户手输机密不自动脱敏。
- output timeline 增加可选 command 元数据而不新增事件类型，兼容旧无元数据输出。运行时末尾五行，完成超过六行时展示前二后四；/outputs 在独立窗口分页查看保留输出，不能找回超限截断内容。
- /terminal-setup 仅支持已识别的稳定版 Windows Terminal 设置路径。用户确认后备份并追加 Shift+Enter sendInput LF，不覆盖已有绑定；提示全局影响。Preview/其他安装布局暂不自动配置。
- pnpm 对 node-pty 1.1.0 应用局部补丁：处理关闭控制台时进程枚举竞争，并在自然退出后释放输入 socket 和 conout worker。使用 pnpm 安装本仓库以应用补丁；发布前需另验打包安装，普通 npm 下游安装不会自动继承根项目 pnpm 补丁。

## 维护约束

- 功能、行为、接口或验证结果发生变化时，同步更新 `docs/PLAN.md`、本文件及 `docs/HANDOFF.md` 中受影响的内容。
- 根级 `AGENTS.md` 只保存跨 Session 长期有效的项目事实和工作约束；易变化的进度、验证结果及下一步统一记录在 `docs/HANDOFF.md`。
