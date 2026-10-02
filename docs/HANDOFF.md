# 当前交接

更新日期：2026-10-02。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择专题。本文件只保存当前状态；此前完整记录见 [历史交接](archive/HANDOFF_HISTORY.md)。

## 当前基线与范围

- 产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI，包版本为 `0.3.7`。
- 本轮开发起点为 Everpeace `63b40af5a7896fbfc35c20b1355f4b4910b11bbe`；比较参考为本地 DeepSeek Harness 官方 checkout `639ed015397290b3745d163aafe02ffee4aa3f84`。实验调度与 Agent Teams 不在本轮基线。
- 用户先授权长任务历史与输出恢复，随后明确授权 MCP/随包 rg、公开 exec、Session 分支/关系及压缩前裁剪。实现没有改变模型默认参数、权限或宿主验证规则。
- 新增固定依赖 `@vscode/ripgrep@1.18.0`，并将包与双语 README 的展示版本同步为 `0.3.7`。本轮交付不创建或推送 tag，不创建或更新远程 Release，也未读取模型凭据或发送 live 模型请求。

## 已完成能力

### 历史与持久输出

- [session-outputs](../src/storage/session-outputs.ts) 为每个 Session 保存不可变、脱敏的工具输出附件。模型只见 opaque ID；内联预览最多 32 KiB、每页续读最多 24 KiB、每项保留前 2 MiB、每会话保留最近 16 份，范围外明确 `retention_truncated`。
- [context-limits](../src/agent/context-limits.ts) 在并行阶段只准备有界正文和预览，待提交字节计入背压；按模型调用顺序执行附件写入、日志引用追加和旧附件淘汰。附件或日志失败通过 `PersistenceError` 停止后续工具和 provider 请求。
- Session 队列与跨进程事务锁协调追加、附件提交/读取/淘汰、启动 orphan 清理和删除。Agent dispose 不删除附件；删除 Session 才清理所属正文。重启复用原 ID，已经丢失的旧进程内正文明确不可用。
- [session-history](../src/storage/session-history.ts) 提供 `session_search`、`session_event_search`、`session_event_read` 和 `session_relations`；`read_tool_output` 支持可选 `session_id`。只允许完全相同的规范化工作区，Windows 盘符与分隔符等价，不扩大到父子目录或符号链接别名。
- 历史投影来自原始 `context_append`，排除 reasoning、加密内容、developer 快照、Memory、历史/关系/续读工具结果及直接 `!` 输出。引用绑定 Session、header、日志位置、条目和摘要；追加保持有效，删除、替换、改写或篡改不可读。
- 当前 step 和旧 Session 查询分别冻结已落盘 EOF。扫描最多 50 项、16 KiB 搜索响应、30 秒、64 MiB，单条记录最多 8 MiB；损坏或超限明确 `incomplete`。历史读取不能恢复文件观察、审批、Goal 完成或验证成功。
- 历史和 learned Memory 是独立能力。Memory 开关不影响历史工具，也不会把旧历史自动提升为长期经验或整段注入请求。

### MCP 自动恢复与随包搜索

- [MCP runtime](../src/mcp/runtime.ts) 为每个 server 维护 `connecting / reconnecting / ready / failed`。瞬时启动失败或断连以 500 ms 起步、30 秒封顶的指数退避重试最多十次；连接稳定 30 秒才清零计数。永久配置、认证或 executable 错误直接失败。
- 断连立即从目录移除该 server 的 callable，并先关闭旧 client；五秒内不能确认关闭就停止自动恢复。退出、工作区切换和 `/mcp` refresh 取消旧 generation 及 timer，迟到回调不能复活连接。默认 TUI 在正常退出及启动失败时等待 dependency dispose，关闭活动 Memory runtime 和共享 MCP runtime；清理失败仍恢复终端模式。业务错误、单次超时和用户取消不触发重连；中断的工具调用不自动重放。
- `notifications/tools/list_changed` 以 50 ms 合并，完整分页发现后原子替换目录。刷新失败保留上一份完整目录，真正断连则移除；最多 100 页、1,000 个工具、2 MiB 定义，重复 cursor/name 或超限明确失败。
- `McpSnapshot` 同时冻结定义、annotations/审批 metadata 与连接/定义 binding。普通网络 retry 复用当前 step 快照；工具删除、重连或定义变化后，旧 binding 返回 stale/unavailable，不能在审批等待后转发到新能力。
- [ripgrep resolver](../src/tools/ripgrep.ts) 惰性解析 `@vscode/ripgrep@1.18.0` 的绝对二进制路径，search/glob、Composer `@` 候选和 doctor 都传 `--no-config`，不读取系统 `PATH` 或用户 rg 配置。缺少匹配 optional package 时明确 unavailable；Windows/Linux CI 不再显式安装系统 rg。

### 公开 `everpeace exec`

- [CLI](../src/cli/commands/exec.ts) 暴露 `everpeace exec [prompt] [-C <directory>] [--model <id-or-name>] [--json] [--token-budget <n>] [--timeout-ms <n>] [--max-steps <n>]`。提示词来自一个位置参数或非 TTY stdin，二者同时提供或都缺失均为参数错误；管道输入最多 8 MiB。
- 模型先按注册 ID、再按唯一模型名解析；省略模型只允许恰好一个凭据可用模型。帮助路径在 registry/keyring、MCP 和 TUI 之前返回。
- [production factory](../src/runtime/production.ts) 由 TUI、exec 和 benchmark 共用，统一 Session、历史附件、Memory、MCP、权限、sandbox、workflow、预算、验证和清理。通过启动阶段的 exec 任务创建正常 Session，标题来自首条非空提示行，之后可由 TUI `/resume` 打开。
- exec 读取已有 learned Memory，但固定关闭本次自动 capture。首版不提供 CLI resume、Plan 或自动批准；审批或结构化问题先保存配对结果，再以 `interaction_required` 停止并清理。
- token budget 覆盖主请求、压缩、retry 和 repair；timeout 与 max steps 也跨全部修复轮共享。默认 stdout 只写最终助手文本，stderr 写进度和宿主验证摘要。
- `--json` 在 exec 输出层初始化后输出 schema 1 的脱敏 JSONL：`session_started`、`assistant_message`、`tool_started`、`tool_finished`、`workflow_updated`、`interaction_required`，以及清理后唯一的 `run_finished`。不导出 reasoning 正文或原始 provider response；终态 usage 可含汇总 reasoning tokens。顶层参数语法或模块启动错误发生在 JSONL 启动前；EPIPE 无法补写终态。退出码为 `0` verified/no_changes、`1` 运行/清理/EPIPE、`2` 参数/启动配置、`3` failed/unverified、`4` 预算/usage/step/deadline、`5` 需要交互、`130/143` 信号。

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

## 验证状态

新增和扩展的离线回归位于 [MCP tests](../tests/unit/mcp/runtime.test.ts)、[ripgrep tests](../tests/unit/tools/ripgrep.test.ts)、[exec tests](../tests/unit/exec/)、[CLI tests](../tests/unit/cli/)、[Session tests](../tests/unit/storage/session-store.test.ts)、[history tests](../tests/unit/storage/session-history.test.ts)、[pruning tests](../tests/unit/agent/context-pruning.test.ts) 和 [TUI tests](../tests/unit/tui/app.test.tsx)。fixture 覆盖重连/关闭竞态和不重放、工具目录通知/分页/binding、缺平台 rg、JSONL/退出/信号/EPIPE、父子独立/重启/删除、pending resume、Unicode/CRLF/恢复引用、裁剪持久失败与重启恢复。

最终使用 Windows Node 工具链串行完成门禁：`pnpm typecheck` 通过；`pnpm test` 共 646 项，643 通过、3 跳过、0 失败、0 取消（33,294.8806 ms）；随后 `pnpm build` 通过。构建后的 `node dist\cli\index.js --help` 与 `node dist\cli\index.js exec --help` 均以 0 退出。仓库没有 lint script。

本轮 tracked 差异执行 `git diff --check -- . ':(exclude).gitignore' ':(exclude)LICENSE'` 并以 0 退出；两个排除项是任务开始前已有的 CRLF 差异，因此不把该结果描述成全局 `git diff --check`。文档范围的 diff-check 及本地 Markdown 链接检查也通过。

所有模型路径使用 fake provider 或确定性 fixture；本轮没有真实模型性能证据。真实 Windows Terminal 的恢复、分支、取消、resize/scrollback 和单 prompt 手工验收尚未执行。

## 当前限制与后续

1. `@vscode/ripgrep` 只覆盖 Windows x64/arm64/ia32、macOS x64/arm64 及 Linux x64/arm64/arm/ia32/ppc64/riscv64/s390x；其他平台或禁用 optional dependency 时搜索明确 unavailable。
2. MCP resources/prompts 仍只在连接时探测，`list_changed` 只刷新标准 tools；OAuth、header helper、elicitation、sampling、tasks 和按工具持久审批尚未接入。
3. exec 首版没有 resume、Plan、自动批准或公开 TypeScript SDK。JSONL 是公共自动化面，不等同于 ACP 或通用 app-server。
4. 分支只接受空闲本地 Session；它不克隆审批、观察、undo、Goal 或验证成功。历史/关系读取不会授予写权限。
5. 裁剪要求可用的持久 Session 历史和唯一恢复证据；不满足时沿用现有压缩。离线 fixture 不能证明真实模型质量或 token/速度提升。
6. Windows TypeScript LSP 仍因固定 native backend 的 socket isolation probe 失败而保持 unavailable；独立解决，不回退宿主直跑。
7. 真实 API smoke、正式 dsh 比较和性能/token 统计仍需另行授权及 task/campaign 数值预算。

## 用户已有差异

本轮开始前已有 `.gitignore`、`LICENSE` 未暂存 CRLF 差异，以及未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`。这些内容没有清理、覆盖或纳入本轮实现；下一轮仍须检查实时 Git 状态。
