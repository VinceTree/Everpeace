# 当前交接

更新日期：2026-10-02。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择当前任务专题；本文件只保存最新状态。旧记录位于 [历史交接](archive/HANDOFF_HISTORY.md)。

## 当前基线

- 产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript 单包、Responses 与 inline TUI。
- 本轮开发起点为 `25105bf48683b88dafda1be4812ac44abbc2961d`；用户随后明确授权更新版本、提交并推送，包版本与双语 README 已同步为 `0.3.6`。交付 commit 以当前 Git `HEAD` 为准。
- 交付使用 `[skip publish]` 标记，仅推送 `main`，不推送 tag 或更新 GitHub Release；已核对 Release workflow 的分支 push 跳过条件与独立 Test workflow。本轮没有升级依赖、运行 live benchmark 或发送付费模型请求。

## 本次完成：Daily coding reliability

### Coding 结构化问题

- `request_user_input` 从 Plan 专用交互拆为共享 question interaction；宿主提供回调时，Plan 和普通 coding 都广告同一 1–3 问题、每题 2–3 选项加自由文本的 schema，`submit_plan` 仍只在 Plan 模式存在。
- 等待答案期间不发模型请求；答案通过普通 function-call/output 配对持久化后继续。问题不能批准 shell、patch、MCP 或其他权限操作。
- Plan Esc 保持原取消语义；coding Esc/Ctrl+C 中止活动任务并走 runner 的后台清理。已取消 signal 不打开窗口，迟到答案在继续执行前再次检查 signal；同批后续调用不会在取消后运行。

### 持久执行清单

- 新增 [TaskProgress](../src/workflow/task-progress.ts) 与 `update_plan`：每次整体替换，最多 20 个唯一非空步骤，单项最多 240 个 Unicode 字符，状态为 `pending / in_progress / completed`，且最多一个 in-progress；空数组明确清除。
- Session 增加 additive `task_progress_updated` 事件和独立最新投影。写入成功后才发布 UI；写入失败停止后续 provider 请求。旧 Session 无字段保持兼容。
- checklist 属于顶层 coding task：repair 和同一 runner 的 Goal continuation 保留；显式 `session_resume` 恢复；新用户任务在首个请求前持久清空。当前投影每次请求重新注入，context compaction 后也不会被旧历史覆盖。
- 状态栏显示完成数/总数，新增只读 `/tasks` 展示完整清单与最新宿主 workflow result。全部 completed 仍不能跳过验证、完成 Goal 或触发成功 Memory。

### Task-local 后台完成通知

- [BackgroundJobManager](../src/tools/background-jobs.ts) 在终态建立后回调 job ID、状态、退出码和完成时间，不携带命令或输出，也不让 observer 异常改变 cleanup。
- 每次 runner invocation 分配 generation；完成项只进入当前 task 队列，在下一普通 step 通过既有 durable context 保存，成功后才确认出队。持久化失败可重试且不会重复成功通知；到达持久化期间的新项留待下一次。
- 运行 job 与未送达通知合计最多 20 项，仍最多同时运行两个命令。任务取消先关闭准入，再停止并等待进程；任务结束丢弃余项并忽略迟到 callback。通知不唤醒空闲 Session，输出继续用 `poll_background` 读取。

### 有界搜索保留

- `FileSearchSession` 最多保留 16 个搜索和 8 MiB 序列化 UTF-8 payload，超限按创建顺序淘汰并使所有旧 continuation 过期；读完最后一页和 Agent dispose 都释放状态。
- 单次 ripgrep 2 MiB 上限同时计算已完成行、pending 文本和新 chunk，超长未终止记录不能绕过边界。`has_more` 仍只表示已保留后页，`incomplete` 表示搜索收集不完整。

## 本次完成：DeepSeek Harness preflight 与 Windows benchmark 可执行性

- 在仓库外准备并固定 checkout DeepSeek Harness `639ed015397290b3745d163aafe02ffee4aa3f84`，完成 `pnpm install --frozen-lockfile` 与 `pnpm build`；生成的 `apps/cli/lib/bin.js` 可由 benchmark adapter 直接启动。
- 修正 dsh preflight 合成 stream chunk，使其符合 `text-delta` 的 `index/text` 契约；新增回归覆盖 preflight chunk、usage 和 completed attempt。
- 真实 Windows cold start 暴露 dsh profile composition 会超过原 30 秒 deadline；改为 Windows 60 秒、其他平台 30 秒，并在本机重新通过完整 preflight。
- Windows benchmark verification 与 fixture preparation 不再直接 spawn `npm.cmd`；通过 Node 安装内的 `npm-cli.js` 保持 `shell: false`，并为临时 checkout 清理增加有限 EBUSY/EPERM 重试；新增 Windows command resolution 回归。
- 当前 Everpeace checkout 与 pinned dsh 的 credential-free preflight 均通过，未读取 keyring、未发送 provider 请求；证据位于本地 `.everpeace-benchmark/artifacts/preflight-result.json`。
- 十项 Chalk、Commander、Day.js fixture 已在本机重新完成 pristine pass → seed fail → reference pass；campaign 输出位于本地 `.everpeace-benchmark/runs/deepseek-fixtures-2026-10-02/`。

## 主要实现与回归入口

| 领域 | 实现 | 回归 |
| --- | --- | --- |
| questions / checklist | [react-agent.ts](../src/agent/react-agent.ts)、[plan runtime](../src/plan/runtime.ts)、[task-progress.ts](../src/workflow/task-progress.ts) | [react-agent.test.ts](../tests/unit/agent/react-agent.test.ts)、[task-progress.test.ts](../tests/unit/workflow/task-progress.test.ts) |
| Session / runner scope | [session-store.ts](../src/storage/session-store.ts)、[task-runner.ts](../src/workflow/task-runner.ts) | [session-store.test.ts](../tests/unit/storage/session-store.test.ts)、[task-runner.test.ts](../tests/unit/workflow/task-runner.test.ts) |
| background notices | [background-jobs.ts](../src/tools/background-jobs.ts)、[react-agent.ts](../src/agent/react-agent.ts) | [background-jobs.test.ts](../tests/unit/tools/background-jobs.test.ts)、[react-agent.test.ts](../tests/unit/agent/react-agent.test.ts) |
| search retention | [files.ts](../src/tools/files.ts) | [files.test.ts](../tests/unit/tools/files.test.ts) |
| benchmark / dsh | [campaign-cli.ts](../src/benchmark/campaign-cli.ts)、[runner.ts](../src/benchmark/runner.ts)、[preparation.ts](../src/benchmark/preparation.ts)、[dsh instrumentation](../docs/benchmark/dsh-instrumentation/index.mjs) | [runner.test.ts](../tests/unit/benchmark/runner.test.ts)、[dsh.test.ts](../tests/unit/benchmark/dsh.test.ts) |
| TUI | [App](../src/tui/app/app.tsx)、[task surface](../src/tui/components/screens/task-progress-surface.tsx)、[question surface](../src/tui/components/screens/plan-surface.tsx) | [app.test.tsx](../tests/unit/tui/app.test.tsx)、[daily-use-surfaces.test.tsx](../tests/unit/tui/daily-use-surfaces.test.tsx) |

中英文 README、OVERVIEW、PLAN、PROJECT_MAP、RUNTIME、TOOLS、STATE_AND_UI 和 DECISIONS 已同步；OVERVIEW 中“LSP 直接运行于宿主”的旧说明已改为当前 native sandbox + probe fail-closed 契约。

## 验证证据

版本同步后再次使用 Windows Node 工具链，按实际存在的脚本串行执行最终门禁：

- `pnpm typecheck`：通过。
- lint：`package.json` 没有 lint script，未运行。
- `pnpm test`：482 项，480 通过、2 跳过、0 失败/取消。计数包含本轮新增 benchmark 回归和工作区现有未跟踪测试，不能作为 clean checkout 固定数量。
- `pnpm build`：通过。
- `pnpm benchmark:campaign -- --config .\\.everpeace-benchmark\\compare-2026-10-02.json --preflight`：Everpeace checkout 与 pinned dsh 均通过，provider boundary 均被观察，network calls 为 0，usage complete 为 true。
- `pnpm benchmark:campaign -- --config .\\.everpeace-benchmark\\full-proof-2026-10-02.json --prove-fixtures`：十项 fixture 全部 `seed=1 reference=0`；首次执行暴露 Windows `npm` shim 和短暂文件锁问题，修复后全量通过。
- 本轮 tracked 文件定向 `git diff --check -- . ':(exclude).gitignore' ':(exclude)LICENSE'`：通过；本轮修改文件的 trailing-whitespace `rg` 扫描无匹配。
- 全局 `git diff --check`：退出 2，只报告任务开始前已有 `.gitignore` 与 `LICENSE` CRLF 差异；两文件分别显示 143/143 与 201/201 行替换，本轮未修改或规范化它们。

定向 fixture 覆盖两种 question mode、缺少 host interaction、回答配对、Esc/Ctrl+C 既有任务取消链、already-aborted/迟到响应防护、同批后续调用；TaskProgress schema/恢复/清空/repair/Goal/compaction/持久失败与验证权；后台四种终态、顺序送达、失败重试去重、队列饱和、取消与 observer 隔离；搜索数量/UTF-8 字节淘汰、消费 cursor 和超长未终止记录。没有运行真实模型或付费调用。

## 已知限制与下一步

1. 在真实 Windows Terminal 中验收 `/tasks`、coding question、resize、scrollback、Esc、Ctrl+C、一个 prompt、后台完成通知及 Session resume；自动 Ink fixture 不能替代真实终端行为。
2. 后台 job 若在最终回答期间才完成，按设计不会触发额外请求，通知可能在 task end 被丢弃；runner 仍等待进程并执行最终验证。
3. 真实 API smoke、九十次正式 dsh 比较和配对性能/token 统计仍未执行；没有 task/campaign token budget 与明确付费授权前不得启动 `--live`。
4. 后续候选依次为模型可访问的压缩后历史检索、公开 headless execution 和 conversation branching。持久 undo 是独立恢复项目。
5. Windows TypeScript LSP 仍取决于能通过现有 write/state/network isolation probes 的 native backend；当前固定 backend 因 socket probe 失败而保持 unavailable。

## 用户已有差异

本轮开始前已有 `.gitignore`、`LICENSE` 未暂存 CRLF 差异，以及未跟踪 `.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`。这些内容均未清理、覆盖或纳入本轮实现。

交接只是快照；下一轮仍须查看实时 Git 状态。
