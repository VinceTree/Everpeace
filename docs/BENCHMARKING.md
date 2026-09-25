# Coding Task Benchmarking

Everpeace 的 benchmark 层用于比较不同 harness、模型策略和恢复策略在真实 coding task 上的表现。它不修改 Session JSONL，不启动 TUI，也不改变 Agent 的权限边界。

## Task format

每个任务至少包含唯一 `id`、自然语言 `prompt` 和隔离工作区 `workspacePath`。推荐为每个任务提供一个不依赖模型输出的验证命令：

```ts
import type { BenchmarkTask } from "../src/benchmark/index.js";

export const tasks: BenchmarkTask[] = [
  {
    id: "fix-parser-regression",
    prompt: "Fix the parser regression and keep the existing tests passing.",
    workspacePath: "C:/benchmarks/parser-fixture",
    tags: ["bug-fix", "tests"],
    timeoutMs: 15 * 60 * 1000,
    verification: {
      command: "pnpm",
      args: ["test"],
      expectedExitCode: 0,
      timeoutMs: 2 * 60 * 1000,
    },
  },
];
```

工作区应由任务准备步骤提前创建并固定到可复现的初始状态。benchmark runner 不会自动 reset、checkout 或删除工作区。

## Harness adapter

外部 harness 通过 `BenchmarkHarnessAdapter` 接入。adapter 必须尊重传入的 `AbortSignal`，并在启动子进程、网络请求或模型调用时继续传递它。每次 Agent turn 的 `onPhase` 和 `onEvent` 应转发到 context，以便收集响应、工具、重试、stream recovery、compaction、steering 和取消指标。

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
    await agent.runTurn(task.prompt, context.signal);
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

stdout/stderr 各自保留最多 1 MiB 尾部，避免失败任务污染评测进程。suite 按任务顺序运行，每个任务独立记录结果，并汇总完成率、验证通过率、工具调用数、重试数、人工介入数和 unsafe action 数。

第一阶段建议从 15-20 个来自真实项目的任务开始，固定 prompt、初始工作区、验证命令和模型配置后再比较不同 harness。
