# 状态、持久化与终端交互

这份文档回答“状态归谁所有、哪些内容可以恢复、UI 修改必须守住什么”。先按 [项目路由表](PROJECT_MAP.md) 找到入口；只有修改对应行为时才读取相关源码和测试。当前交付证据、环境限制和待办见 [HANDOFF](../HANDOFF.md)。

## 状态所有权

| 状态 | 所有者与存储 | 不得混入的内容 |
| --- | --- | --- |
| API Key | [AuthStorage](../../src/storage/auth-storage.ts) 与系统 keyring | models JSON、Session、日志、UI、测试快照 |
| 模型注册 | [ModelRegistry](../../src/storage/model-registry.ts)，平台配置中的 `models.json` | 明文 Key；只保存 `auth_ref` |
| 对话、context、主请求 usage | [SessionStore](../../src/storage/session-store.ts)，每 Session 一个 JSONL | 从历史恢复的权限授权 |
| 当前视图、审批、运行状态 | [TUI App](../../src/tui/app/app.tsx) 及依赖 | 临时命令窗口不能变为聊天历史 |
| coding 结果与验证债务 | [workflow runtime](../../src/workflow/runtime.ts)，Session 只保存元数据 | 验证 stdout/stderr/error、文件检查点 |
| Goal | [GoalRuntime](../../src/goal/runtime.ts)，Session 绑定 | 无宿主验证的编码完成状态 |
| Learned memory | [LearnedMemoryRuntime/Store](../../src/memory/learned-memory.ts)，独立平台目录 | 原始凭据、未经验证的成功事实 |
| 权限 | [PermissionPolicy](../../src/permissions/policy.ts)，当前用户策略与项目限制交集 | JSONL 中历史授权、项目自提权 |
| 文件观察、undo、工具输出续读、后台进程 | 当前进程内工具与 workflow runtime | 恢复后凭历史文本重新获得写权限或假装进程仍活着 |

模型 `model_name` 保留服务端原始 ID；应用内部注册 `id` 不等于模型名称。可选 `request_settings` 同时存在于模型注册和 Session 模型引用中，旧记录使用供应商默认设置。切换设置在任务边界应用，不能在同一任务内悄悄改变请求预算。

## 存储位置与凭据

- Windows：配置、Session 等默认位于 `%APPDATA%/Everpeace/`，Session 子目录为 `sessions/`。
- macOS：默认位于 `~/Library/Application Support/Everpeace/`。
- Linux：模型配置使用 `$XDG_CONFIG_HOME/everpeace/`（默认 `~/.config/everpeace/`）；Session 使用 `$XDG_STATE_HOME/everpeace/sessions/`（默认 `~/.local/state/everpeace/sessions/`）。
- 系统 keyring 不可用时报告故障，不降级为明文 Key 文件；注册表只用 `auth_ref` 关联凭据。
- 普通输入历史由 [InputHistory](../../src/storage/input-history.ts) 单独保存，不能记录登录向导的凭据字段。

这些是默认路径，测试应注入临时目录与 AuthStorage 替身，不依赖真实用户的凭据或 Session。

## JSONL 契约

每个 Session 使用带格式字段的逐行事件文件，同一文件追加串行化。`timeline` 是人看到的历史，`context` 是发给 Responses 的输入；两者独立恢复，不能互相推导。

| 事件 | 含义 |
| --- | --- |
| `session_created` | Session ID、标题、工作目录、无凭据模型引用、标题待生成与 usage 跟踪标记 |
| `title_updated` | 修改标题并清除待生成标记 |
| `timeline_entry` | 用户/助手/工具/输出等可见记录；兼容旧 status 快照 |
| `context_append` | 追加模型交互项，保持工具调用与结果配对 |
| `context_compacted` | 替换有效 context，保留是否自动压缩标记及 usage；不改写可见历史 |
| `model_selected` | 模型引用及是否保留 context |
| `usage_recorded` | 主请求的 usage 或明确 unknown |
| `goal_updated` | Session Goal 状态、预算及已用量 |
| `workflow_updated` | 修改路径、任务来源、验证债务、检查状态与文件 revision 等元数据 |
| `memory_policy_updated` | 当前聊天的 `readExisting` 与 `captureFuture` |

`workflow_updated` 序列化会清空验证输出并去掉错误正文；这不代表普通 `timeline/context` 不保存用户消息或工具交互。不要将新的请求正文、文件快照或凭据塞入诊断元数据。压缩内容继续使用既有 context 通道。

旧记录缺少 `title_pending` 按 false；缺少 usage、workflow 或新字段不能补推“统计完整”“已验证”。只允许忽略损坏且没有换行终止的最后一行，其余 JSONL 错误按文件隔离，列表跳过坏文件而不是吞掉中间事件。持久化失败走 `PersistenceError`，不能当网络错误重试模型或继续成功结算。

## 创建、切换与恢复

| 操作 | 固定语义 |
| --- | --- |
| 第一条普通消息 | 先创建 Session，再请求模型与追加记录 |
| `/new` | 必须已有模型；立即进入标题为 `New Session`、`title_pending: true` 的空 Session |
| 第一条新 Session 问题 | 先生成可靠回退标题，再异步命名；不能阻塞回答 |
| `/clear` | 清屏并解除当前 Session，保留模型；下一条普通消息才创建新 Session |
| `/resume` | 全局按最近活动列出；恢复 timeline、context、模型、工作目录、Goal、workflow 和聊天 Memory 策略，继续原文件 |
| 模型切换 | 保留累计 usage，重置或标记未知的新模型 context 占用 |
| Session 删除 | 使用选择/确认流程；任务或直接命令运行期间不得删除 |

恢复前先检查工作目录；目录不存在时保持当前会话不变。原模型缺失可选择替代，但含供应商专属加密/不透明 context 时不得跨供应商静默迁移。旧“新 Session”标题只在显示层翻译。

恢复后重新读取项目规则与文件观察；权限读取当前配置，不从 JSONL 复活。`session_resume` 和 Goal 自动续跑必须保留修复计数与未验证债务，不能通过新的 `no_changes` 清除失败。后台命令和进程内 undo 检查点不可恢复。

## Usage、Goal 与 Memory

- [model-status](../../src/status/model-status.ts) 分别累计 input、output、reasoning、cache hit 与 cache write；reasoning 不重复加到已经包含它的 output 上。
- 缺失 usage 或缓存字段保留不完整状态，后来的完整样本不能掩盖缺口。缓存命中率仅用有对应统计的输入作分母；context 占用和累计消费不同，压缩后占用设为未知。
- 主 coding/压缩 usage 随 Session 保存；标题、Skill、Memory、doctor 的辅助请求通过共享 executor 计量，`/status` 分栏显示。当前辅助总数由 TUI dependency 实例持有，不伪称为恢复后的完整历史辅助账目。
- Goal 仅按用户明确意图建立，预算仅在明确指定时设置。`paused`、`blocked`、`complete` 与预算/usage 停止各有独立语义；停止条件不得被 UI 的“本轮结束”覆盖。
- 编码完成意图先暂存，由 [CodingTaskRunner](../../src/workflow/task-runner.ts) 在完整、未过期验证通过并再次检查取消后结算。取消、预算停止、无检查和修复耗尽均不提交成功 Memory。
- 新指令可开启新任务预算，但旧未验证事实仍须保留；Goal 续跑不构成新任务授权。
- Memory 是不可信背景，低于用户指令和项目规则；全局开关控制读写，聊天策略随 Session 恢复。成功学习、明确长期偏好、候选审核及后台队列的完整边界见 [MEMORY](MEMORY.md)。

## Inline TUI 与独立命令窗口

详细目录职责见 [TUI_STRUCTURE](TUI_STRUCTURE.md)。界面始终 inline，使用终端原生 scrollback，不切换 alternate screen。主状态机拥有视图切换；展示组件不得自己创建 Agent、写 Session 或启动新任务。

- 宿主界面英文；模型正文按其原始语言展示。Markdown、代码、shell 和严格 unified diff 分层高亮，超大或未知内容安全退回纯文本。
- 等待状态包含 provider、耗时与 Ctrl+C 提示；`/status` 显示模型、供应商、实际协议、压缩/推理设置、context 占用和累计 token/cache，缺失数据明确显示未知或不完整。
- `/status`、`/outputs`、`/history`、`/terminal-setup`、信息窗口及 picker/wizard 使用独立命令窗口；`/new`、`/clear`、`/exit` 是立即动作。
- 命令窗口隐藏 banner、历史、composer 与全局状态栏，进入时同步清屏，Esc 从内存原子重放原 Session。窗口本身不得写入 `Static`、timeline 或 context。
- 只有命令造成的真实变更进入对应状态存储。可取消加载使用操作身份检查，关闭窗口后忽略迟到结果。
- 所有命令窗口共享居中布局，外框最多 80 列，窄屏有左右安全边距，字段左对齐；resize 后重新居中且不得泄露底层历史。
- `/` 前缀菜单最多显示八项，保留方向键选择、Enter 执行、Tab 补全和 Esc 关闭。
- resize 保留历史、单一 prompt 与输入的自动换行安全单元格；不得破坏滚轮或 Ctrl+滚轮缩放。

## 取消、Steering 与终端输出

- Ctrl+C 在任务活动时取消；空闲且有草稿时清空；空闲且无草稿时退出。
- 活动 coding turn 保留 guidance composer；支持 steering 的 Agent 即时记入可见 transcript，在采样/工具结果安全边界应用。未开始工具补 `steered` 结果；取消时仍保存已提交 guidance。不支持 steering 的替身保留 FIFO。
- 取消、权限收紧、预算停止和异常都必须收束 task 拥有的后台进程树；清理完成前不能启动下一任务。最终检查期间也可取消，不能在取消后完成 Goal。
- 用户直接 `!` 使用交互 PTY，由 Ink 单一 stdin 入口转发并独占输入；禁止同时注册原始 stdin 监听器。它由用户主动执行，不进模型 sandbox，也不进入模型 context，但可进入可恢复输出历史。
- 原始 PTY 控制序列不能直接写入 Ink stdout；保持清洗、流式显示与终端模式复位。
- SSE 可用时实时显示正文、审批与工具状态；否则显示 buffered 等待。只有实际 reasoning 事件才显示 Thinking，其耗时与整段请求耗时区分。
- 模型 shell 展示有界首五行/尾五行，随高度缩减；直接 `!` 优先最近五行。最终折叠与 `/outputs` 保留原始有界输出语义。
- 修改终端按键设置必须预览、明确确认和备份，不能静默覆盖用户配置。

## 修改入口与最低回归范围

| 修改类型 | 先读与必须考虑的回归 |
| --- | --- |
| Session schema、恢复、usage | [Session 测试](../../tests/unit/storage/session-store.test.ts)、[status 测试](../../tests/unit/status/model-status.test.ts)、[App 测试](../../tests/unit/tui/app.test.tsx)；旧缺字段、损坏尾行、串行追加 |
| UI 命令或布局 | [命令目录](../../src/tui/commands/slash-commands.ts)、[command surface 测试](../../tests/unit/tui/command-surface.test.tsx)、[App 测试](../../tests/unit/tui/app.test.tsx)；Esc、resize、迟到结果、历史重放 |
| Goal/Memory 结算 | [task runner 测试](../../tests/unit/workflow/task-runner.test.ts)、[Goal 测试](../../tests/unit/goal/runtime.test.ts)、[Memory 测试](../../tests/unit/memory/learned-memory.test.ts)；取消和验证债务 |
| 权限与审批 | [PERMISSIONS](PERMISSIONS.md)、[SANDBOX](SANDBOX.md)；运行时权限 revision、取消、原生启动失败关闭 |

新增状态前先决定它属于持久化事实、临时视图还是进程内资源；不要把三者共用一个布尔“成功”字段。增加持久字段必须同时补解析、序列化、缺字段默认与恢复测试，并更新本页和 [DECISIONS](DECISIONS.md)。
