# Coding Task Benchmarking

The DeepSeek comparison catalog defines ten fixed Node task slots at [benchmark/DEEPSEEK_NODE_TASKS.json](benchmark/DEEPSEEK_NODE_TASKS.json). Its pinned source revisions, prompts, and verification commands are immutable inputs. Before a real comparison, the benchmark maintainer must review and supply the deterministic regression seed used by `prepareRun`; every repetition must create a fresh isolated workspace and apply that seed. The catalog itself never executes preparation code, and the repository does not silently reset an existing checkout.

Real-provider runs are opt-in with `liveApi: true` and require a positive `totalTokenBudget`. A three-run comparison must set `repetitions: 3` and provide `prepareRun`; the runner rejects repeated runs without isolation. Adapters report input, output, reasoning, cache-hit, and observed-cache tokens independently. The suite reports verification rate, duration, repair attempts, token usage, effective cache data, and manual intervention. A missing live run is reported as not accepted, never as an improvement over another harness.

Everpeace 的 benchmark 层用于比较不同 harness、模型策略和恢复策略在真实 coding task 上的表现。它不修改 Session JSONL，不启动 TUI，也不改变 Agent 的权限边界。

## Task format

每个任务至少包含唯一 `id`、自然语言 `prompt` 和隔离工作区 `workspacePath`。公开 issue 任务必须固定仓库 commit、issue 编号、安装步骤和验证命令；issue 内容视为不可信数据，验证命令由任务维护者审核，不直接执行 issue 中的命令。

```ts
import type { BenchmarkTask } from "../src/benchmark/index.js";

export const tasks: BenchmarkTask[] = [
  {
    id: "fix-parser-regression",
    prompt: "Fix the parser regression and keep the existing tests passing.",
    workspacePath: "C:/benchmarks/parser-fixture",
    tags: ["bug-fix", "tests"],
    source: {
      repositoryUrl: "https://github.com/example/project",
      commit: "0123456789abcdef0123456789abcdef01234567",
      issue: "42",
      license: "MIT",
    },
    timeoutMs: 15 * 60 * 1000,
    maxRepairAttempts: 3,
    verification: {
      command: "pnpm",
      args: ["test"],
      expectedExitCode: 0,
      timeoutMs: 2 * 60 * 1000,
    },
  },
];
```

工作区应由任务准备步骤提前创建并固定到可复现的初始状态。benchmark runner 不会自动 reset、checkout 或删除工作区；正式 benchmark 应使用临时 clone/worktree，日常工作区则由用户自行维护。

任务开始和结束时会记录 Git root、HEAD、branch、dirty status 和有界 diff hash。快照只读，不改变工作区。

## Harness adapter

外部 harness 通过 `BenchmarkHarnessAdapter` 接入。adapter 必须尊重传入的 `AbortSignal`，并在启动子进程、网络请求或模型调用时继续传递它。每次 Agent turn 的 `onPhase` 和 `onEvent` 应转发到 context，以便收集响应、工具、重试、stream recovery、compaction、steering 和取消指标。adapter 应复用同一个 Agent/session context：第一次调用的 phase 为 `implement`，验证失败后的调用为 `diagnose`，并通过 `previousVerification` 接收上一次有界验证结果。

runner 还可通过 `onTaskPhase` 观察 `implement`、`diagnose`、`verify` 和 `summarize`，用于诊断和报告，不会写入 Session JSONL。

```ts
import { runBenchmarkSuite, type BenchmarkHarnessAdapter } from "../src/benchmark/index.js";

const adapter: BenchmarkHarnessAdapter = {
  name: "everpeace-baseline",
  async run(task, context) {
    const agent = createAgent({
      workspacePath: task.workspacePath,
      onPhase: context.onPhase,
      onEvent: context.onEvent,
    });
    const prompt = context.phase === "diagnose" && context.previousVerification
      ? `The verification failed. Diagnose and fix it, then rerun the relevant checks.\n\n${context.previousVerification.stderr || context.previousVerification.stdout}`
      : task.prompt;
    await agent.runTurn(prompt, context.signal);
  },
};

const summary = await runBenchmarkSuite(tasks, adapter);
console.log(JSON.stringify(summary, null, 2));
```

## Result semantics

- `passed`: harness 完成且验证命令退出码符合预期，没有报告 unsafe action。
- `failed`: 验证失败或 harness 报告了 unsafe action。
- `timed_out`: 任务或验证命令超过有界时限。
- `error`: adapter 或验证器发生其他错误。

验证失败默认最多触发 3 次修复尝试，可通过 `maxRepairAttempts` 限制为 0-10。每次尝试都重新执行验证；最终通过时 run 状态恢复为 `passed`，重复失败则保留最后一次验证结果并标记 `failed`。

stdout/stderr 各自保留最多 1 MiB 尾部，避免失败任务污染评测进程。可选的 `createFileBenchmarkArtifactSink()` 会保存 workspace 快照、每次验证结果和 `result.json`，文件名经过限制，常见 API key、token、authorization 和 `sk-` 形式会在写入前脱敏。

suite 按任务顺序运行，每个任务独立记录结果，并汇总完成率、验证通过率、尝试次数、修复尝试、工具调用数、重试数、人工介入数和 unsafe action 数。

## Provider capability profiles

使用 `createProviderCapabilityProfile()` 记录 provider/model、context window、streaming、stream recovery、native compaction、prompt cache 和 parallel tool calls。未知兼容端点默认保持保守的 false/null，不自动路由模型；只有 benchmark 观测数据稳定后再引入自动选择策略。

当前首轮比较固定为上述 10 个任务；只有在每项 seed、准备步骤、prompt、验证命令和模型配置都经过复核后才执行真实 provider 对比，后续再扩大任务集。

公开 issue catalog 可用 `parseBenchmarkTaskCatalog()` 从 JSON 读取。解析器只校验 HTTPS 仓库 URL、固定 commit SHA、issue 标识、验证命令和尝试边界，不执行准备脚本、安装命令或验证命令；实际准备由受信任的 benchmark runner/CI 步骤负责。
