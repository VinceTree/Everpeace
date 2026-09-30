# Coding Task Benchmarking

Everpeace 的 benchmark 层比较 harness、模型策略和恢复策略在真实 coding task 上的表现。主指标是固定请求预算内，由独立断言确认的任务通过率。该层不改变 Agent 的权限、验证和 Session JSONL 语义，也不会自动 reset 或清理日常工作区。

当前 [十项 Node 候选清单](benchmark/DEEPSEEK_NODE_TASKS.json) 只代表任务槽位。只有 pinned revision 和 prompt 并不构成可复现 fixture；用户工作区内另有未跟踪的源码材料，也不会被自动采纳。`parseReproducibleBenchmarkTaskCatalog()` 要求每项同时具备 reviewed seed/reference patch 与 evaluator-owned acceptance，否则正式 campaign 在发出模型请求前拒绝启动。

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

TUI 与 benchmark 共用 `CodingTaskRunner`。`createCodingTaskRunnerBenchmarkAdapter()` 每项只调用一次生产 runner；同一个 Agent/Session 内完成工具循环、最多三轮诊断、完整最终验证、Goal 及 Memory 结算。adapter 标记 `managesRepairs`，因此 evaluator 只运行独立 acceptance，不会叠加另一套自动修复循环。

```ts
import {
  createCodingTaskRunnerBenchmarkAdapter,
  runBenchmarkSuite,
} from "../src/benchmark/index.js";

const adapter = createCodingTaskRunnerBenchmarkAdapter(async (task, context) => {
  return createProductionTaskRunner({
    workspacePath: task.workspacePath,
    signal: context.signal,
    onPhase: context.onPhase,
    onEvent: context.onEvent,
    requestAttemptLedger: context.requestAttemptLedger,
  });
});

const summary = await runBenchmarkSuite(tasks, adapter, {
  prepareRun,
  repetitions: 3,
});
```

`createProcessHarnessAdapter()` 参数化启动固定外部程序，不使用 shell 拼接。`createDshHeadlessAdapter()` 使用 `dsh --profile headless <job>`；Windows 应传 Node 与已解析的 JS entry，避免 `.cmd` shell。campaign launcher 仍必须固定 dsh 安装提交、模型原始 ID、推理档位、输出上限、sandbox 和工具配置，adapter 不从最终回答猜测 usage。

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

Performance trace 记录 context preparation、request snapshot、sampling、retry delay、tool wait/execution、compaction 等单调时钟耗时，以及响应、工具、重试和取消数量。SSE 的 first event/text 来自真实流事件；buffered endpoint 只能在完整响应返回时记录。trace 不保存请求正文、文件内容、验证输出或凭据。

## Acceptance sequence

正式对比顺序固定为：

1. 每项 fixture 先独立证明 pristine pass → seed fail → reference repair pass。
2. 运行 3 项 × 当前版本/优化版本/固定 dsh × 1 次，共 9 次 smoke。
3. 随机交错 harness 顺序，运行 10 项 × 3 harness × 3 次，共 90 次正式比较。

三组固定模型原始 ID、`high` 推理、32K 产品输出预算、十五分钟任务时限和最多三轮诊断。报告独立通过次数、首次通过、人工介入、双方均成功任务的配对耗时、总 token/成功任务、缓存统计完整性，以及协议、sandbox、工具差异。

当前十项候选材料尚缺 reviewed patch pairs 和完整证明，真实 API smoke、九十次对比及 Windows Terminal 验收均未执行。真实调用需要另行显式授权并给出 campaign 总 token 预算；在此之前不能发布排名、冷缓存结论或相对 dsh 的性能优势声明。
