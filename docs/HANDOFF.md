# 当前交接

更新日期：2026-10-01。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择当前任务专题；本文件只保存最新状态。旧记录位于 [历史交接](archive/HANDOFF_HISTORY.md)。

## 当前基线

- 产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript 单包、Responses 与 inline TUI。
- 本轮按用户指定以 tracked commit `b226bfcdd5e8421676f9f47454ef68db75370732` 为实现 baseline；交付版本为 `0.3.4`，最终 delivery commit 以当前 Git `HEAD` 为准。
- 本轮没有升级依赖、打 tag、创建 Release 或发送付费模型请求；用户已明确授权更新版本并提交、推送，commit 使用 `[skip publish]` 阻止 Release workflow 发布。

## 本次完成：Coding reliability

### 可复现比较准备

- baseline/candidate 使用名称唯一的 `everpeace-checkout` 配置，在相同 fresh Node worker 中动态导入各 checkout 的 production adapter。每次运行重新核对完整 revision、runtime source digest 与 build entry digest；source identity 包含 `src` 中 tracked、deleted 和未忽略 untracked 内容，以及 manifest/lockfile/TypeScript 配置，不受根目录无关差异影响。
- worker 与 production adapter 强制原始模型 ID、`high` reasoning、32,768 output tokens，不继承个人保存设置。digest mismatch 会同时报告 expected/actual，便于 reviewed 配置更新。
- campaign 模式严格三选一：`--preflight`、`--prove-fixtures`、`--live`。可选有序 `taskIds` 支持 3 task × 3 harness × 1 = 9 次 smoke；完整 10 task × 3 harness × 3 = 90 次正式计划。
- checkout preflight 在 30 秒边界内启动真实 worker 和 production adapter，在真实 provider request boundary 注入合成 SSE response；使用 dummy credential、过滤宿主凭据并用 Node socket guard 阻断网络。它记录 request settings、usage、source/build identity 与 cleanup，不生成 scored result。
- 固定 dsh preflight 启动真实 CLI/profile 并在 `llm/stream` boundary 注入合成 response。instrumentation 对缺失/非法 token usage 永久标记 incomplete 并阻止后续请求；cache 字段缺失保持未观察，取消/失败时在清理前保存 ledger。

### 完整模型变更审阅

- 新增模型只读 `list_workspace_changes` / `read_workspace_change`，共用 `/diff` 的结构化 Git 服务并保留 `workspace_status` / `workspace_diff` 兼容。
- captured index 分开 staged、unstaged、untracked，保留 overlap 与 rename old path；opaque reference 惰性读取 tracked unified diff、untracked UTF-8 preview 或 binary/symlink/submodule summary。
- snapshot/page/result 都有进程内 retention、continuation、取消、containment 和 visible truncation。过期引用要求重新 list；review 不产生文件观察、写权限或变更归属。
- Agent coding instruction 要求总结前检查完整变更。

### 精确编辑与恢复

- `ApplyPatchOperation` update 新增互斥的 `replace: { oldText, newText }`。oldText 必须非空并在统一 CRLF/LF 表示中大小写、空白完全一致且只出现一次；不做 fuzzy match。
- replace 保留 UTF-8 BOM 与原换行风格，并沿用 512 KiB file/batch、fresh read observation、nested rules、approval revision、并发版本和 rollback safeguards。
- 解析、预览与执行返回稳定原因与修复提示：invalid arguments、missing observation、stale version、unmatched/ambiguous/unchanged replacement、hunk mismatch、policy denial。权限拒绝不能通过自动 retry 或替代编辑路径绕过。

### 隔离 LSP 导航

- definition/references/implementation/hover 保持每次查询 fresh server。新 duplex transport 直接通过 pinned Codex backend 启动 executable/argv，保留 raw stdout、处理 stdin backpressure、drain 64 KiB stderr、暴露 exit 并等待 process-tree termination。
- dedicated child of `:read-only` 拒绝 workspace write 与 `.git`/`.codex`/`.agents`/`.everpeace`、Everpeace global state；用户 full access 不会放开该策略。权限 revision 或 task cancellation 会终止查询，cleanup failure 会覆盖成功结果。
- JSON-RPC 限制为 8 KiB header、2 MiB frame、8 MiB aggregate incoming；现有 30 秒、16 MiB document、100 locations、64 KiB hover 保留。初始化 capability、当前 UTF-16 input position、document/returned-location containment 都在返回前验证。
- 配置的 server 启动前运行相同 native policy 下的 direct-socket denial probe。固定 Windows `@openai/codex@0.155.1` 实测可拒绝 workspace 写入与应用状态读取，但仍允许 socket；运行时及 `/doctor` 因而报告 isolation unavailable，保留 lexical search，不在较弱边界下启动 LSP。`:read-only` 的 ambient system reads 与 temporary-directory grants 已明确记录。

## 主要实现与回归入口

| 领域 | 实现 | 回归 |
| --- | --- | --- |
| checkout/preflight | [checkout.ts](../src/benchmark/checkout.ts)、[worker](../src/benchmark/checkout-worker.ts)、[campaign CLI](../src/benchmark/campaign-cli.ts) | [checkout.test.ts](../tests/unit/benchmark/checkout.test.ts)、[campaign.test.ts](../tests/unit/benchmark/campaign.test.ts) |
| dsh usage/preflight | [dsh.ts](../src/benchmark/dsh.ts)、[instrumentation](benchmark/dsh-instrumentation/index.mjs)、[network guard](benchmark/dsh-instrumentation/preflight-network-guard.mjs) | [dsh.test.ts](../tests/unit/benchmark/dsh.test.ts) |
| 模型变更审阅 | [workspace.ts](../src/tools/workspace.ts)、[workspace-review.ts](../src/tools/workspace-review.ts)、[react-agent.ts](../src/agent/react-agent.ts) | [workspace-review.test.ts](../tests/unit/tools/workspace-review.test.ts)、[react-agent.test.ts](../tests/unit/agent/react-agent.test.ts) |
| 精确编辑 | [apply-patch.ts](../src/tools/apply-patch.ts)、[react-agent.ts](../src/agent/react-agent.ts) | [apply-patch.test.ts](../tests/unit/tools/apply-patch.test.ts)、[react-agent.test.ts](../tests/unit/agent/react-agent.test.ts) |
| LSP transport/isolation | [code-navigation.ts](../src/tools/code-navigation.ts)、[cli.ts](../src/codex/cli.ts)、[sandbox-policy.ts](../src/tools/sandbox-policy.ts) | [code-navigation.test.ts](../tests/unit/tools/code-navigation.test.ts)、[cli.test.ts](../tests/unit/codex/cli.test.ts)、[sandbox-boundaries.test.ts](../tests/unit/tools/sandbox-boundaries.test.ts) |

中英文 README、BENCHMARKING、DEVELOPMENT、PLAN、PROJECT_MAP、TOOLS、SANDBOX 和 DECISIONS 已同步。

## 验证证据

使用 Windows Node 工具链串行执行本轮最终门禁：

- `pnpm typecheck`：通过。
- `pnpm test`：456 项，454 通过、2 跳过、0 失败/取消。计数包含工作区已有未跟踪测试，不能作为 clean checkout 固定数量。
- `pnpm build`：通过。
- 仓库没有 lint script，因此未运行 lint。
- 全局 `git diff --check` 退出 2，仅报告任务开始前已有 `.gitignore` 与 `LICENSE` CRLF 差异；本轮所有 tracked/untracked 文件的 trailing-whitespace 定向扫描无匹配。

额外定向证据：checkout preflight 真实导入当前 production adapter 并在合成 provider boundary 完成一次 high/32K request，未读取 keyring、未发送网络请求；Windows native LSP fixture 实测 write/state denial 与 direct-network limitation，并验证 runtime fail-closed；fragmented/malformed frames、backpressure、noisy stderr、permission revision cancellation 和 cleanup failure 回归均通过。

本轮没有可用的 pinned dsh checkout，因此未执行真实 dsh CLI/profile preflight。没有运行 live API、九次 smoke、九十次正式比较或真实 Windows Terminal 手工验收。

## 已知限制与下一步

1. 在固定 dsh revision `639ed015397290b3745d163aafe02ffee4aa3f84` 的已安装/已构建 checkout 上运行 `--preflight`，保存真实 profile/request-boundary/cleanup artifact。
2. 要在 Windows 启用 native LSP，需要 pinned backend 提供能通过 direct-socket probe 的网络隔离；Linux/macOS 也须各自通过 write/state/network 与 descendant cleanup probe。
3. 真实模型比较仍需单独授权并给出 task/campaign 数值预算；先运行恰好九次 smoke，再决定是否运行九十次正式 campaign。
4. 真实 Windows Terminal 仍需检查 resize、scrollback、Esc、Ctrl+C、后台 writer、Session 恢复与界面重放。

## 用户已有差异

本轮开始前已有 `.gitignore`、`LICENSE` 未暂存 CRLF 差异，以及未跟踪 `.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`tests/unit/codex/`、`{}`。这些内容均未清理或覆盖；本轮只在已有未跟踪 `tests/unit/codex/cli.test.ts` 中追加 duplex transport 回归。新建的 benchmark checkout 源码/测试与 preflight guard 属于本轮实现。

交接只是快照；下一轮仍须查看实时 Git 状态。
