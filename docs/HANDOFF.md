# 当前交接

更新日期：2026-10-05。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择专题。本文件只保存当前状态；此前完整记录见 [历史交接](archive/HANDOFF_HISTORY.md)。

## 当前基线与范围

- 产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI，包版本为 `0.3.8`。
- 本轮开发起点为已交付的 `main`，commit `411ea9f681d9766cc6bebf8a649b4b2929baee9f`；比较参考仍固定为本地 DeepSeek Harness 官方 checkout `639ed015397290b3745d163aafe02ffee4aa3f84`。实验调度与 Agent Teams 不在本轮基线。
- 用户授权本轮可靠性、MCP 资源访问、Windows LSP 原生门禁与长会话成本优化；既有历史/附件、exec、分支、重连和压力裁剪继续复用。模型默认参数、权限和宿主验证规则保持不变。
- 用户随后明确授权更新版本、提交并推送，包与双语 README 同步为 `0.3.8`，依赖版本未变。交付 commit 以 Git `HEAD` 为准；仅推送 `main`，提交使用 `[skip publish]`，不创建或推送 tag、不创建或更新远程 Release。已核对 Release workflow 的分支跳过条件及独立 Test CI；未读取模型凭据或发送 live 模型请求。
- 本轮继续按用户授权自动提交并推送；新增的 agent runtime identity 优化只改变动态请求 instructions，不改变权限、Session schema 或模型注册。真实 dsh coding-task 比较仍未执行，不能据此宣称质量领先。

## 已完成能力

### 历史与持久输出

- [session-outputs](../src/storage/session-outputs.ts) 为每个 Session 保存不可变、脱敏的工具输出附件。模型只见 opaque ID；内联预览最多 32 KiB、每页续读最多 24 KiB、每项保留前 2 MiB、每会话保留最近 16 份，范围外明确 `retention_truncated`。
- [context-limits](../src/agent/context-limits.ts) 在并行阶段只准备有界正文和预览，待提交字节计入背压；按模型调用顺序执行附件写入、日志引用追加和旧附件淘汰。附件或日志失败通过 `PersistenceError` 停止后续工具和 provider 请求。
- Session 队列与跨进程事务锁协调追加、附件提交/读取/淘汰、启动 orphan 清理和删除。Agent dispose 不删除附件；删除 Session 才清理所属正文。重启复用原 ID，已经丢失的旧进程内正文明确不可用。
- [session-history](../src/storage/session-history.ts) 提供 `session_search`、`session_event_search`、`session_event_read` 和 `session_relations`；`read_tool_output` 支持可选 `session_id`。只允许完全相同的规范化工作区，Windows 盘符与分隔符等价，不扩大到父子目录或符号链接别名。
- 历史投影来自原始 `context_append`，排除 reasoning、加密内容、developer 快照、Memory、历史/关系/续读工具结果及直接 `!` 输出。引用绑定 Session、header、日志位置、条目和摘要；追加保持有效，删除、替换、改写或篡改不可读。
- 当前 step 和旧 Session 查询分别冻结已落盘 EOF。扫描最多 50 项、16 KiB 搜索响应、30 秒、64 MiB，单条记录最多 8 MiB；损坏或超限明确 `incomplete`。历史读取不能恢复文件观察、审批、Goal 完成或验证成功。
- 历史和 learned Memory 是独立能力。Memory 开关不影响历史工具，也不会把旧历史自动提升为长期经验或整段注入请求。
- Session 恢复、列表和搜索投影逐条解析 JSONL 并折叠状态，避免整份字符串、split 数组及全部事件数组重复物化。旧记录、有效无换行末行、损坏中间记录及未完成尾行语义保留；恢复不新增 8 MiB 记录限制，历史查询仍保留自己的扫描限制。
- 历史输出定位使用最多 256 项 metadata LRU，不缓存正文。缓存命中仍检查固定 EOF、工作区、header、文件身份、原结果摘要及完整 call→result 区间；来源覆盖、Memory/历史排除、损坏和扫描预算不能由缓存绕过。追加保留旧定位，删除、替换、改写及读取期间变化触发重验或失效。
- v1 附件不迁移。范围读取先读最多 4 KiB header，核对引用 metadata、文件身份和精确文件长度，再读取所需页与 UTF-8 边界余量；事务锁、取消、期限、淘汰/删除竞争及 24 KiB 正文／32 KiB 转义后响应限制不变。脱敏仍发生在保存前，不对分页重新脱敏。

### MCP 自动恢复与随包搜索

- [MCP runtime](../src/mcp/runtime.ts) 为每个 server 维护 `connecting / reconnecting / ready / failed`。瞬时启动失败或断连以 500 ms 起步、30 秒封顶的指数退避重试最多十次；连接稳定 30 秒才清零计数。永久配置、认证或 executable 错误直接失败。
- 断连立即从目录移除该 server 的 callable，并先关闭旧 client；五秒内不能确认关闭就停止自动恢复。退出、工作区切换和 `/mcp` refresh 取消旧 generation 及 timer，迟到回调不能复活连接。默认 TUI 在正常退出及启动失败时等待 dependency dispose，关闭活动 Memory runtime 和共享 MCP runtime；清理失败仍恢复终端模式。业务错误、单次超时和用户取消不触发重连；中断的工具调用不自动重放。
- `notifications/tools/list_changed` 以 50 ms 合并，完整分页发现后原子替换目录。刷新失败保留上一份完整目录，真正断连则移除；最多 100 页、1,000 个工具、2 MiB 定义，重复 cursor/name 或超限明确失败。
- `McpSnapshot` 同时冻结定义、annotations/审批 metadata 与连接/定义 binding。普通网络 retry 复用当前 step 快照；工具删除、重连或定义变化后，旧 binding 返回 stale/unavailable，不能在审批等待后转发到新能力。
- 分页工具发现使用 SDK 公共 `request` 和 result schema，宿主持有整份定义、独立 output validator 和 execution 支持判定，完整发现及编译成功后原子发布。binding 覆盖输入/输出 schema、description、annotations 和 execution；刷新失败保留旧目录与校验器，已发送调用按 dispatch 时冻结的定义校验，失败不重连或重放。完整发现共享一个总 deadline。
- required-task 工具不广告，`/mcp` 明确显示不支持；optional-task 可以普通调用。initialize capabilities 分别决定 tools/resources/prompts，resources-only、prompts-only 和 instructions-only server 可以 ready。
- `list_resources(cursor?)`、`list_resource_templates(cursor?)`、`list_prompts(cursor?)` 每次实时请求一页，返回来源及 `next_cursor`。单页最多 1,000 项／1 MiB；超限返回明确范围错误且不给部分条目或跳项续点。游标原样传递，返回相同非空游标拒绝；过期游标要求重新列举，不承诺跨页快照一致。read/get 保留文本、来源和 mimeType，图片/音频/blob 仅返回类型说明，不注入 base64；无资源订阅或目录缓存。
- [ripgrep resolver](../src/tools/ripgrep.ts) 惰性解析 `@vscode/ripgrep@1.18.0` 的绝对二进制路径，search/glob、Composer `@` 候选和 doctor 都传 `--no-config`，不读取系统 `PATH` 或用户 rg 配置。缺少匹配 optional package 时明确 unavailable；Windows/Linux CI 不再显式安装系统 rg。

### Agent runtime identity

- 每个 coding request 的动态 instructions 都包含宿主确认的 Everpeace agent 身份、实际 provider、模型原始 ID、Responses 协议和当前 workspace/cwd；这些值不是工作区内容，不改变权限，也不进入 Session JSONL。
- `/context` 的最近请求快照复用同一份宿主事实，显示 runtime agent、协议和 workspace/cwd，帮助用户核对模型看到的 checkout；快照仍是内存诊断，不从历史恢复。

### 公开 `everpeace exec`

- [CLI](../src/cli/commands/exec.ts) 暴露 `everpeace exec [prompt] [-C <directory>] [--model <id-or-name>] [--json] [--token-budget <n>] [--timeout-ms <n>] [--max-steps <n>]`。提示词来自一个位置参数或非 TTY stdin，二者同时提供或都缺失均为参数错误；管道输入最多 8 MiB。
- 模型先按注册 ID、再按唯一模型名解析；省略模型只允许恰好一个凭据可用模型。帮助路径在 registry/keyring、MCP 和 TUI 之前返回。
- [production factory](../src/runtime/production.ts) 由 TUI、exec 和 benchmark 共用，统一 Session、历史附件、Memory、MCP、权限、sandbox、workflow、预算、验证和清理。通过启动阶段的 exec 任务创建正常 Session，标题来自首条非空提示行，之后可由 TUI `/resume` 打开。
- exec 读取已有 learned Memory，但固定关闭本次自动 capture。首版不提供 CLI resume、Plan 或自动批准；审批或结构化问题先保存配对结果，再以 `interaction_required` 停止并清理。
- token budget 覆盖主请求、压缩、retry 和 repair；timeout 与 max steps 也跨全部修复轮共享。默认 stdout 只写最终助手文本，stderr 写进度和宿主验证摘要。
- `--json` 在 exec 输出层初始化后输出 schema 1 的脱敏 JSONL：`session_started`、`assistant_message`、`tool_started`、`tool_finished`、`workflow_updated`、`interaction_required`，以及清理后唯一的 `run_finished`。不导出 reasoning 正文或原始 provider response；终态 usage 可含汇总 reasoning tokens。顶层参数语法或模块启动错误发生在 JSONL 启动前；EPIPE 无法补写终态。退出码为 `0` verified/no_changes、`1` 运行/清理/EPIPE、`2` 参数/启动配置、`3` failed/unverified、`4` 预算/usage/step/deadline、`5` 需要交互、`130/143` 信号。

exec 本轮进一步增加可等待的助手和工具交付：工具开始在 dispatch 前、结束在结果落盘后交付，provider 流式进度回调仍同步。输出失败停止后续工具与请求，但补齐已落盘调用的取消/跳过结果；持久化失败保持停止语义。

stdout/stderr 使用有序 writer，编码块最多 16 KiB、待写编码总量有界于 1 MiB，处理 callback、drain/error/close 与 30 秒无进展。助手完整脱敏后增量 JSON 转义写出，移除 64 KiB 正文截断；其他事件整行最多 64 KiB，省略展示字段时给出 `truncated`、总数等信息。Windows 非 TTY pipe 由 CLI host 拥有的惰性 writer 子进程写入，有界 IPC 确认使父进程保持取消/计时可用，退出等待回收。半条 JSONL frame 已写出后的通道失败或取消不能补写可靠终态；清理后且通道可用时才输出一次 `run_finished`。

### Session 分支与关系

- TUI 增加 `/fork [title]`，只在当前本地 Session 完全空闲且源模型仍可用时接受。[SessionStore.fork](../src/storage/session-store.ts) 在父锁内固定 EOF，流式复制日志和最近最多 16 份附件到隐藏 staging；先发布独立子附件目录，最后原子发布子 JSONL，失败或取消不切换 UI 且清理未发布内容。
- 子 Session 保留模型、timeline/context、聊天 Memory policy、带继承标记的 TaskProgress、changed paths 和未验证债务。它生成新 task ID，usage/repair 归零，清除 Goal、审批、undo、文件观察和旧验证成功证据；同名 opaque output ID 对应父子各自拥有的附件。
- lineage 保存父 ID、fork 时间、源 EOF 和 header 摘要。`session_relations(session_id?)` 在同工作区返回直接父子并重新验证这些字段；父被删除、替换或缩短时标记 `available: false`，子副本及附件继续独立可用。
- 子 Session 持久保存 `fork_pending_resume`。首次及任何未结算后的普通 coding 输入使用 `session_resume` 语义；只有任务以 `verified` 或 `no_changes` 结算才清除。Plan、查看命令、取消、异常、限制停止及 failed/unverified 都不消耗该状态，也不会续跑已清除的父 Goal。

### 压力触发的无模型裁剪

- [ReactAgent](../src/agent/react-agent.ts) 在自动压缩压力或一次 context-limit recovery 时，先冻结当前 step 历史 EOF，并至多尝试一次裁剪。低压力、手动 `/compact` 和普通网络 retry 不触发。
- 候选必须是较早、闭合、超过 8,192 个 Unicode 码点的工具结果，并由持久 Session 历史按 `(call_id, tool_name, 脱敏正文 SHA-256)` 唯一解析。最近两个完整交互单元、open chain、非工具/reasoning/opaque、Memory、Session 历史/关系及 `read_tool_output` 结果受保护；来源歧义、日志损坏或扫描不足时跳过。
- 替代 JSON 保留前 4,096、后 1,024 个码点、`session_event_read` 引用及已有截断 envelope 的恢复字段，总量最多 32 KiB，并且必须实际缩小完整请求。
- `context_pruned` 必须先写入 Session，成功后才替换有效 context。原始 `context_append`、timeline 和附件不改写；累计 usage 不变，只有当前 `context_tokens` 设为 unknown。重新估算后足够小则跳过 provider summary/native compact，否则继续既有压缩。

### LSP 宿主边界与原生门禁

- [code-navigation](../src/tools/code-navigation.ts) 在读取输入及接受返回位置前检查规范工作区与 denied roots，包括 symlink/junction 和 Windows 路径等价；导航不产生写观察，不接受 server 编辑或命令请求。
- 校验 UTF-16 坐标、操作 capability 与 open/close 同步，不支持则明确不可用；hover 截断保持有效 UTF-8，production factory 与 TUI 统一 permission revision。
- 固定 Windows backend 的原生 fixture 加入宿主正对照。实测正对照通过，隔离进程也能连接非 loopback 的 TCP/IPv4，结果为 `allowed / connection_succeeded`；工作区写入及应用状态读取仍被拒绝。doctor 显示结构化证据，不把任意 socket error 当作拒绝证明。
- 网络门禁失败，Windows LSP 继续 unavailable；未更换 sandbox 或宿主直跑，未实施条件后置的 lsp.json、通用 registry/pool。实际覆盖仅为 TCP/IPv4，不声称 IPv6 或全部网络协议受阻。

## 验证状态

新增和扩展的离线回归位于 [MCP tests](../tests/unit/mcp/runtime.test.ts)、[ripgrep tests](../tests/unit/tools/ripgrep.test.ts)、[exec tests](../tests/unit/exec/)、[CLI tests](../tests/unit/cli/)、[Session tests](../tests/unit/storage/session-store.test.ts)、[history tests](../tests/unit/storage/session-history.test.ts)、[pruning tests](../tests/unit/agent/context-pruning.test.ts) 和 [TUI tests](../tests/unit/tui/app.test.tsx)。fixture 覆盖重连/关闭竞态和不重放、工具目录通知/分页/binding、缺平台 rg、JSONL/退出/信号/EPIPE、父子独立/重启/删除、pending resume、Unicode/CRLF/恢复引用、裁剪持久失败与重启恢复。

版本同步后使用 Windows Node 22 工具链串行完成 `pnpm typecheck → pnpm test → pnpm build`，三项均通过；测试共 709 项，706 通过、3 跳过、0 失败、0 取消（48,146.5421 ms）。三个既有跳过分别是文件 symlink 权限、Windows 临时目录别名和 Unix child timeout 场景；原生 Windows sandbox fixture 在本机实际执行，不能把 CI 的平台跳过当成同一证据。构建后 CLI 与 exec 的 `--help` 都以 0 退出。上一轮验证已移到历史归档，仓库没有 lint script。

本轮 tracked 差异使用 `git diff --check -- . ':(exclude).gitignore' ':(exclude)LICENSE'` 并以 0 退出；两个排除项是任务开始前已有的 CRLF 差异，不把结果描述成全局检查。11 个新增实现/fixture 的独立空白检查通过；13 份变更 Markdown 的 500 个本地目标路径检查通过。Windows/Linux Test CI 继续完整门禁并增加有界超时；发布标记不跳过 Test CI。远程执行状态需按实际 push 后的 workflow 核对，不将本机结果当作 Linux 或 hosted runner 证据。


所有模型路径使用 fake provider 或确定性 fixture；本轮没有真实模型性能证据。真实 Windows Terminal 的恢复、分支、取消、resize/scrollback 和单 prompt 手工验收尚未执行。

开发专用 [离线 TUI fixture](../tests/fixtures/tui-offline.ts) 可从真实 Windows Terminal 运行 `pnpm exec tsx tests/fixtures/tui-offline.ts --root <绝对空目录>`。它在指定根下独立保存工作区、Session 和输入历史，不加载用户 keyring、模型配置、MCP、Memory、Skills 或导航。`large` 检查中文/emoji 长输出，`wait` 检查取消；`Offline debt seed` 可测试恢复、分支及待验证债务，具体步骤见 [开发指南](DEVELOPMENT.md)。帮助和非 TTY 拒绝启动已自动检查，不能代替真实终端验收。

### 离线宿主性能证据

同一台 Windows Node 22、独立 worker、同一份 134,461,921 字节日志（2,048 次 64 KiB 追加、64 次压缩，最终 context 一项、timeline 空）对照上一提交与当前实现：

| 操作 | 原实现耗时／进程峰值 RSS | 当前实现耗时／进程峰值 RSS |
| --- | --- | --- |
| load | 421.44 ms／391,636 KiB | 401.03 ms／114,052 KiB |
| list | 361.83 ms／389,116 KiB | 255.77 ms／86,756 KiB |

两实现读取相同日志字节且最终投影一致。当前最大单记录 65,649 字节、原始输入保留上界观测 131,185 字节；load 结束 GC 前 heap 从原实现 280,235,768 字节变为 16,221,280 字节，异步抽样 heap 峰值为 27,445,824 字节。耗时是一次离线诊断；heap 抽样可能漏过同步峰值，RSS 为进程高水位，且空 timeline 的 fixture 不能证明所有长会话恒定内存。临时对照模块与工作区已清理。

历史附件 16 页 fixture 观测：首次历史扫描 3,213,801 字节，累计历史来源 I/O 4,212,951 字节，附件 I/O 458,816 字节，定位缓存一 miss／十五 hit。后续页不从日志起点重定位，仍重验来源区间。实施阶段门禁中的 100 个含附件 Session：启动/冷列表 315.01 ms，热列表 77.29 ms，冷/热搜索 106.51／11.04 ms；启动引用扫描与列表日志各 2,931,690 字节，热列表新增相同日志读取而不重复启动引用扫描，冷搜索再新增相同日志读取，热搜索命中 100 项缓存。全程附件正文读取为 0，orphan 正确清理。确定性门禁以最终状态、原始缓冲和读取量为准，耗时仅作诊断，不据此宣称真实模型速度、质量或 token 提升。

## 当前限制与后续

1. `@vscode/ripgrep` 只覆盖 Windows x64/arm64/ia32、macOS x64/arm64 及 Linux x64/arm64/arm/ia32/ppc64/riscv64/s390x；其他平台或禁用 optional dependency 时搜索明确 unavailable。
2. MCP 资源/模板/prompt 已支持按需分页，但没有订阅、目录缓存或跨页快照保证；OAuth、header helper、elicitation、sampling、task execution 和按工具持久审批尚未接入。
3. exec 首版没有 resume、Plan、自动批准或公开 TypeScript SDK。JSONL 是公共自动化面，不等同于 ACP 或通用 app-server。
4. 分支只接受空闲本地 Session；它不克隆审批、观察、undo、Goal 或验证成功。历史/关系读取不会授予写权限。
5. 裁剪要求可用的持久 Session 历史和唯一恢复证据；不满足时沿用现有压缩。离线 fixture 不能证明真实模型质量或 token/速度提升。
6. Windows LSP 因固定 native backend 实测允许 TCP/IPv4 而保持 unavailable；共同后端升级候选与网络回归须独立处理，门禁通过后才实施配置和通用池，不回退宿主直跑。
7. 真实 API smoke、正式 dsh 比较和性能/token 统计仍需另行授权及 task/campaign 数值预算。

## 用户已有差异

本轮开始前已有 `.gitignore`、`LICENSE` 未暂存 CRLF 差异，以及未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`。这些内容没有清理、覆盖或纳入本轮实现；下一轮仍须检查实时 Git 状态。
