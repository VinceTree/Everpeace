# Coding Task Benchmarking

Everpeace 的 benchmark 层比较 harness、模型策略和恢复策略在真实 coding task 上的表现。主指标是固定请求预算内，由独立断言确认的任务通过率。该层不改变 Agent 的权限、验证和 Session JSONL 语义，也不会自动 reset 或清理日常工作区。

当前 [十项 Node 清单](benchmark/DEEPSEEK_NODE_TASKS.json) 已包含固定 revision、setup、pristine assertion、reviewed seed/reference patch 与 evaluator-owned acceptance；正式 parser 缺少任一项都会在模型请求前拒绝。十项 Chalk、Commander 和 Day.js fixture 已逐项离线证明 pristine pass → seeded assertion failure → reference pass。Commander 与 Day.js 使用上游 lockfile；Chalk 固定 revision 原本用 `.npmrc` 禁用 lockfile，因此评测材料保存 evaluator-owned `chalk-package-lock.json`，准备器在 setup 前排他复制。三组统一用显式 npmjs registry 执行 `npm ci --ignore-scripts`，避免本机 registry 配置改变依赖来源。

## Task and fixture contract

每个任务包含唯一 `id`、自然语言 `prompt`、隔离工作区、固定源码和有界命令。`verification` 可向 harness 提供开发反馈，最终评分优先使用模型无法通过改写项目脚本替代的 `acceptance`。

```ts
import type { BenchmarkTask } from "../src/benchmark/index.js";

export const task: BenchmarkTask = {
  id: "fix-parser-regression",
  prompt: "Fix the parser regression and keep existing behavior passing.",
  workspacePath: "unused-before-preparation",
  source: {
    repositoryUrl: "https://github.com/example/project",
    commit: "0123456789abcdef0123456789abcdef01234567",
    issue: "42",
    license: "MIT",
  },
  fixture: {
    setup: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
    pristineVerification: { command: process.execPath, args: ["reviewed-acceptance.mjs"] },
    seedPatch: "fix-parser-regression/seed.patch",
    referencePatch: "fix-parser-regression/reference.patch",
  },
  verification: { command: "pnpm", args: ["test"], timeoutMs: 120_000 },
  acceptance: { command: process.execPath, args: ["reviewed-acceptance.mjs"], timeoutMs: 120_000 },
  timeoutMs: 15 * 60_000,
  maxRepairAttempts: 3,
};
```

`prepareBenchmarkFixture()` 只克隆到已确认不存在的目标，校验 pinned HEAD，执行有界 setup 和 pristine assertion，再应用 seed。`proveBenchmarkFixture()` 必须证明：

1. pinned source 的独立断言通过；
2. seed 应用后，同一 assertion 因预期缺陷失败；
3. reference repair 应用后，同一 assertion 再次通过。

超时、缺少依赖、命令启动失败和 `exitCode: null` 都是基础设施失败，不算有效 seed。重复运行使用 `createIsolatedBenchmarkPreparer()` 创建 `campaign/harness/task/repetition` 目录，避免 harness 和 repetition 相互覆盖。

## Production and external adapters

TUI 与 benchmark 共用 `CodingTaskRunner`。`createProductionBenchmarkAdapter()` 在无 Ink 环境中构造生产 `ReactAgent`、SessionStore、权限、原生 sandbox、workflow 和 runner；同一个 Agent/Session 内完成工具循环、最多三轮诊断、完整最终验证、Goal 及 Memory 结算。adapter 标记 `managesRepairs`，因此 evaluator 只运行独立 acceptance，不会叠加另一套自动修复循环。

```ts
import {
  createProductionBenchmarkAdapter,
  runBenchmarkSuite,
} from "../src/benchmark/index.js";

const adapter = createProductionBenchmarkAdapter({ model, sessionsRoot });

const summary = await runBenchmarkSuite(tasks, adapter, {
  prepareRun,
  repetitions: 3,
});
```

`createCheckoutBenchmarkAdapter()` 为 baseline 与 candidate 提供同一条 fresh-process worker 路径。每次运行都从指定 checkout 动态导入 production adapter，并重新核对完整 Git revision、runtime source digest 和已构建 entry digest；source digest 覆盖 `src` 中 tracked、deleted 与未忽略 untracked 内容，以及 manifest、lockfile 和 TypeScript 配置，因此候选新增文件会改变身份，而仓库外或无关根目录文件不会。worker 强制使用配置中的原始模型 ID、`high` reasoning 和 32,768 output tokens，不继承个人保存的 request settings。基线和候选可以共享 revision，例如基线为干净 `b226bfc` checkout、候选为该 revision 上的明确工作树内容；digest 才区分两者。preflight 失败会在错误中给出实际 digest，供 reviewed 配置更新。

`createProcessHarnessAdapter()` 参数化启动固定外部程序，不使用 shell 拼接；通用外部 wrapper 必须在自己的 LLM 边界输出一行 `EVERPEACE_BENCHMARK_RESULT <JSON>`，launcher 不从最终回答猜测 usage。固定 dsh 使用 `createInstrumentedDshAdapter()`：它要求源码 checkout 的完整 HEAD 为 `639ed015397290b3745d163aafe02ffee4aa3f84`，直接通过 Node 启动该 checkout 内的 built `apps/cli/lib/bin.js`，并创建内容锁定的专用 headless profile。profile 在 dsh 的 `llm/stream` waterfall 记录每次 coding、重试、摘要和标题请求，校验模型原始 ID、主编码请求的 `high` reasoning 与 32K 输出上限，在每个 provider 请求前检查剩余预算，并把 cache/unknown usage 交回 campaign。缺失或非法 token 字段会永久把该任务 usage 标为 incomplete 并阻止后续请求；cache 字段缺失时 denominator 保持未观察。取消或失败时仍在清理临时目录前保存脱敏 ledger。Windows 不经过 `.cmd` 或 shell。

dsh 配置需要 `sourceRoot`、位于该目录内的 `entryPath`、独立 `dshHome` 与专用 `profile`。首次运行只在 profile 不存在时写入 reviewed manifest/patch；已有 profile 内容不一致会失败关闭。运行前需在固定 checkout 中完成官方依赖安装和 build，这一步不会由 campaign 静默执行。profile 禁用 Web tool、使用隔离的 Agents home 和关闭遥测；API key 只在 live 子进程环境中传递，不写入配置、ledger 或 artifact。

## Campaign command

内部入口要求配置文件，并且必须在无凭据启动预检、离线 fixture proof 与 live campaign 中三选一：

```powershell
pnpm benchmark:campaign -- --config .\campaign.json --preflight
pnpm benchmark:campaign -- --config .\campaign.json --prove-fixtures
pnpm benchmark:campaign -- --config .\campaign.json --live
```

配置包含 `campaignId`、catalog/fixture/run/artifact/session 目录、已注册的 `modelId`、随机 `seed`、`repetitions`、`taskTokenBudget`、`campaignTokenBudget`、可选有序 `taskIds` 和名称唯一的 harness 列表。可从 [示例配置](benchmark/CAMPAIGN_CONFIG.example.json) 开始。`everpeace-checkout` 分别命名 baseline/candidate 并指定 source/build identity；`dsh` 使用固定源码与内置 instrumentation；既有单个 `everpeace` 和 `instrumented-process` 配置继续兼容。通用外部参数模板支持 `${PROMPT}`、`${WORKSPACE}` 和 `${TOKEN_BUDGET}`，以 argv 传递而非 shell 拼接。

`--preflight` 不读取系统 credential storage，也不发送模型请求。它实际启动每个 checkout fresh worker、导入 production entry 并在真实 provider request boundary 注入合成 response；dsh 同样启动固定 CLI/profile，在 `llm/stream` boundary 注入合成响应。两者传入 dummy credential，在 Node socket guard 下要求完成；Windows 上 dsh 启动 deadline 为 60 秒，其他平台为 30 秒，以覆盖冷启动 profile composition。结果把 entry/profile loading、request-boundary interception、effective settings、checkout identity、usage ledger 与失败写入 `preflight-result.json`。这是 startup/admission 证据，不是 scored result，也不证明操作系统级断网。无 digest 的旧 `everpeace` 与未定义无凭据预检契约的通用 `instrumented-process` 在该模式失败关闭，live 兼容性不变。

Windows 上 benchmark verification 保持 `shell: false`；manifest 中的 `npm` 命令通过当前 Node 安装的 `npm-cli.js` 直接启动，不经过不可直接 spawn 的 `npm.cmd` batch shim。fixture 准备失败时删除临时 checkout 使用有界重试，避免 Windows 文件句柄短暂占用覆盖原始失败原因。

live 入口在任何请求前写入 `campaign-plan.json`，随后随机交错 harness 顺序；结果写入 `campaign-result.json`，包含完整 planned、executed、skipped、unknown usage 和 stop reason。每个 skipped 项保留 adapter、task 和 repetition。准备失败作为执行结果保存，不算有效 seed，也不会消费模型预算。

## Usage and budget

真实请求必须显式设置 `liveApi: true` 和正整数 `totalTokenBudget`。生产 adapter 将同一个 `RequestAttemptLedger` 传到真实模型 client，coding、stream recovery、缓存能力降级和 summary request 分别结算：

- 预算使用 input + output；reasoning 是 output 的明细，不重复扣减。
- 每次请求开始前检查剩余预算；恰好耗尽时不能继续。
- 在途请求可以超过剩余预算，超出量仍如实记录，不能描述为账单硬上限。
- 已发出但 usage 不可靠的请求把账本永久标为 incomplete；后续成功不能清除，当前任务和整个 campaign 停止继续发请求。

尚未接入生产 ledger 的外部 adapter 必须返回完整 `BenchmarkTokenUsage`。缺失或 `complete: false` 同样停止后续任务。

## Result and artifact semantics

- `passed`：harness 完成，独立 acceptance 通过，没有 unsafe action。
- `failed`：acceptance 失败、预算失败或 harness 报告 unsafe action。
- `timed_out`：任务或 acceptance 超过有界时间。
- `error`：adapter、准备器或验证器发生其他错误。

suite 单独保存 `planned`、`executed`、`skipped`、`stopReason` 和 `statisticsComplete`。成功率分母固定为 planned runs；预算耗尽、取消和 usage unknown 不会缩小分母。usage completeness 只说明已执行请求的计量是否完整，不能替代 campaign completeness。

任务开始和结束记录有界 Git workspace snapshot。可选 artifact sink 保存脱敏的 snapshot、每次 acceptance 和结果；路径包含 campaign/harness/task/repetition/attempt，常见 API key、authorization、token 和 `sk-` 形式会在写入前替换。stdout/stderr 使用增量有界缓冲，最多保留 1 MiB。

Performance trace 记录 context preparation、request snapshot、sampling、retry delay、tool wait/execution、sandbox startup、assistant render callback、compaction、workspace snapshot、verification 和 artifact persistence 等单调时钟耗时，以及响应、工具、重试和取消数量。sandbox startup 截止到子进程 spawn，rendering 表示宿主 callback 成本，不冒充终端绘制完成时间。SSE 的 first event/text 来自真实流事件；buffered endpoint 只能在完整响应返回时记录。trace 不保存请求正文、文件内容、验证输出或凭据。

## Acceptance sequence

正式对比顺序固定为：

1. 每项 fixture 先独立证明 pristine pass → seed fail → reference repair pass。
2. smoke 配置列出 3 个 `taskIds`、3 个 harness、`repetitions: 1`，计划必须恰好产生 9 次运行。
3. 正式配置包含全部 10 项、相同 3 个 harness、`repetitions: 3`，随机交错计划必须恰好产生 90 次运行。

三组固定模型原始 ID、`high` 推理、32K 产品输出预算、十五分钟任务时限和最多三轮诊断。报告独立通过次数、首次通过、人工介入、双方均成功任务的配对耗时、总 token/成功任务、缓存统计完整性，以及协议、sandbox、工具差异。

十项离线 proof、命名 checkout worker、无凭据 preflight 路径和固定 dsh instrumentation 代码已完成；2026-10-02 已在 Windows Node 22 上安装并构建 pinned dsh checkout，Everpeace 与 dsh 的 preflight 均通过，十项 fixture 也全部证明 seed fail → reference pass。真实 API smoke、九十次对比及 Windows Terminal 验收仍未执行。真实调用需要另行显式授权，并同时给出 task 与 campaign token 预算；在此之前不能发布排名、冷缓存结论或相对 dsh 的性能优势声明。
