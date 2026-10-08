# 项目定位与开发路由

此页用于按问题选择文档、源码与测试，避免每次启动都重新扫描仓库。先读根 [AGENTS.md](../../AGENTS.md) 和 [HANDOFF](../HANDOFF.md)，再选择下面的一行；不要求同时打开所有入口。历史设计原因见 [DECISIONS](DECISIONS.md)，待做事项见 [PLAN](../PLAN.md)。

## 产品与技术边界

Everpeace 是 DeepSeek 优先、Windows 优先的个人开发 CLI；保留官方供应商和兼容端点。当前核心是 Node/TypeScript 单包任务：理解规则、受保护地修改、执行完整检查、有限诊断并交付宿主可证明的结果。

- Node.js 22+、TypeScript、ESM；包管理器为 `pnpm@10.22.0`。
- React + Ink 提供 inline TUI，保留原生 scrollback；同一 `dist/cli/index.js` 也暴露不加载 Ink 的 `everpeace exec`。
- 普通 Responses 驱动单 Agent ReAct；供应商能力显式配置，不依据 SDK 是否有方法或模型名推断能力。
- 模型 shell 使用固定原生执行后端；结构化读写、Web、MCP、Skills 各自保持权限与信任边界。
- TUI、公开 exec、TypeScript SDK 与内部 benchmark 共用生产 Agent factory 和 coding task runner；完整验证结果决定代码 Goal 与成功学习。
- `everpeace exec` 提供 CLI + JSONL 自动化面，`everpeace/sdk` 的 `runTask` 提供同一非交互任务的公开 TypeScript 接口；ACP、通用 app-server、多 Agent、Web/Desktop 和完整插件架构不是现有产品承诺。
- 对比结果与真实 Windows Terminal/API 验收情况以 HANDOFF 为准，不从功能数量推导性能排名。

## 整体分层与状态归属

以下层次描述现有职责和后续提取方向，不要求新增目录或建立第二套运行时。

| 层次 | 职责与状态归属 | 当前入口 |
| --- | --- | --- |
| 入口适配 | 处理输入输出和各自交互方式；展示、草稿与终端按键属于界面 | `src/tui/`、`src/cli/`、`src/exec/`、`src/sdk/`、`src/benchmark/` |
| 应用协调 | 管理当前 Session 身份、模式、待执行计划、模型任务准入、取消及操作身份，决定任务是否启动、属于哪个会话 | [ApplicationCoordinator](../../src/runtime/application-coordinator.ts) 由 TUI App 持有；非交互入口管理各自调用生命周期 |
| 任务执行 | runner/workflow 管理任务资源、清理、验证、诊断及最终结算，决定任务是否完成、是否验证通过 | `src/workflow/` |
| Agent 引擎 | 请求准备、上下文维护、模型循环、工具调度与请求计量 | `src/agent/` |
| 能力与资源 | 文件、shell、权限、存储、provider、MCP、Skills、Memory 提供各自能力，保留各自安全和生命周期约束 | `src/tools/`、`src/permissions/`、`src/storage/`、`src/providers/` 等 |

共享 [production factory](../../src/runtime/production.ts) 继续装配各入口使用的 Agent 与 IO。入口适配可以依赖核心模块；`src/runtime/`、`src/agent/`、`src/workflow/`、`src/exec/`、`src/sdk/` 不得反向引入 React、Ink、`@inkjs/ui` 或 `src/tui/`，包括类型导入、重导出及字面量动态导入。TUI 与 CLI 的适配入口保留合法 UI 依赖；[架构回归](../../tests/unit/architecture/dependency-boundaries.test.ts) 在现有测试命令中执行这条边界。

Session 存储持久事实；timeline、模型 context、workflow 元数据保持既有分离，界面从它们建立状态投影。Plan 批准属于当前进程的会话／Agent 协调状态，文件观察属于工具实例，活动进程属于任务；恢复、fork 或历史文本不能重建这些授权和资源。后续按状态所有者提取协调模块，保持 runner 与存储为单一实现，不按文件行数拆分。详细生命周期见 [RUNTIME](RUNTIME.md) 与 [STATE_AND_UI](STATE_AND_UI.md)。

## 目录职责

| 路径 | 职责与依赖边界 |
| --- | --- |
| `src/cli/`、`src/exec/`、`src/sdk/` | CLI 参数／输出、TUI 启动及公开非交互 CLI/SDK 适配；exec 与 SDK 不依赖 UI |
| `src/runtime/` | 共享生产 Agent／IO／sandbox factory，以及 UI 无关的应用协调状态；不依赖 UI |
| `src/tui/` | 交互、展示及宿主 I/O 适配；应用协调状态委托给 runtime，目录分层见 [TUI_STRUCTURE](TUI_STRUCTURE.md) |
| `src/agent/` | Responses 交互、step/context、请求执行与计量、压缩、项目规则 |
| `src/providers/` | client 工厂、能力契约、用途设置、模型列表 |
| `src/workflow/` | coding 任务编排、变更追踪、检查发现/执行、检查点、TaskProgress 与结果 |
| `src/tools/`、`src/codex/` | 工具实现、输出/进程资源与原生 sandbox 启动；不负责 UI 生命周期 |
| `src/storage/`、`src/status/` | 凭据引用、配置、Session/input history、lineage/分支事务、历史投影与持久输出附件、usage/status 数据模型 |
| `src/permissions/` | 用户与项目策略组合、授权判断、权限 revision |
| `src/goal/`、`src/plan/` | 明确 Goal 生命周期与严格 Plan 工具/交互契约 |
| `src/memory/` | 分层 learned memory、召回、脱敏、候选与后台队列 |
| `src/util/` | 保留版式的凭据脱敏；Memory 与历史/附件复用同一匹配规则 |
| `src/skills/`、`src/mcp/` | 外部能力发现、读取、安装或连接；工具内容不是上层授权 |
| `src/benchmark/`、`src/performance/` | 隔离评测、独立评分、预算与元数据 trace |
| `tests/unit/` | 按模块定位回归；部分测试实际启动子进程/临时仓库 |
| `tests/fixtures/`、`docs/benchmark/` | 固定材料与任务目录；评测材料不得由被评 Agent 定义成功 |
| `third_party/`、`patches/` | 上游来源说明与受控依赖补丁，不当作项目业务源码重写 |
| `.github/workflows/` | 测试 CI 与自动发布分别管理 |

## 能力 → 源码 → 测试 → 文档

| 任务或问题 | 定向源码入口 | 主要回归 | 先读文档 |
| --- | --- | --- | --- |
| CLI 参数、启动、登录/模型选择 | [cli/index](../../src/cli/index.ts)、[args](../../src/cli/args.ts)、[selection](../../src/cli/selection.ts) | [args](../../tests/unit/cli/args.test.ts)、[selection](../../tests/unit/cli/selection.test.ts) | [README](../../README.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| `everpeace exec`、JSONL、管道背压与退出清理 | [exec runtime](../../src/exec/runtime.ts)、[exec output](../../src/cli/exec-output.ts)、[exec writer](../../src/cli/exec-writer.ts)、[production factory](../../src/runtime/production.ts) | [exec](../../tests/unit/exec/runtime.test.ts)、[exec output](../../tests/unit/cli/exec-output.test.ts)、[writer](../../tests/unit/cli/exec-writer.test.ts)、[真实子进程](../../tests/unit/cli/exec-process.test.ts) | [README](../../README.md#non-interactive-execution)、[RUNTIME](RUNTIME.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| 公开 SDK、分层与禁止的依赖方向 | [SDK](../../src/sdk/index.ts)、[production factory](../../src/runtime/production.ts)、[类型配置](../../tsconfig.json) | [SDK](../../tests/unit/exec/sdk.test.ts)、[架构回归](../../tests/unit/architecture/dependency-boundaries.test.ts) | [DEVELOPMENT](../DEVELOPMENT.md)、[DECISIONS](DECISIONS.md) |
| 任务准入、取消、会话归属与待执行 Plan | [应用协调](../../src/runtime/application-coordinator.ts)、[App](../../src/tui/app/app.tsx) | [协调回归](../../tests/unit/runtime/application-coordinator.test.ts)、[App](../../tests/unit/tui/app.test.tsx)、[生产闭环](../../tests/unit/runtime/plan-execution.test.tsx) | [RUNTIME](RUNTIME.md#应用协调与任务执行)、[STATE_AND_UI](STATE_AND_UI.md) |
| 请求 step、工具调度、steering、重试 | [react-agent](../../src/agent/react-agent.ts)、[step 工具目录](../../src/agent/step-tool-catalog.ts)、[agent-loop](../../src/agent/agent-loop.ts) | [工具目录](../../tests/unit/agent/step-tool-catalog.test.ts)、[react-agent](../../tests/unit/agent/react-agent.test.ts)、[loop boundaries](../../tests/unit/agent/loop-boundaries.test.ts) | [RUNTIME](RUNTIME.md)、[AGENT_LOOP](AGENT_LOOP.md) |
| DeepSeek/兼容端点、reasoning、辅助请求 | [capabilities](../../src/providers/capabilities.ts)、[provider client](../../src/providers/openai-compatible.ts)、[request executor](../../src/agent/request-executor.ts) | [capabilities](../../tests/unit/providers/capabilities.test.ts)、[react-agent](../../tests/unit/agent/react-agent.test.ts)、[TUI dependencies](../../tests/unit/tui/dependencies.test.ts) | [RUNTIME](RUNTIME.md) |
| attempt 计量、预算、context/缓存 | [ledger](../../src/agent/request-attempt-ledger.ts)、[request snapshot](../../src/agent/request-snapshot.ts)、[context limits](../../src/agent/context-limits.ts) | [ledger](../../tests/unit/agent/request-attempt-ledger.test.ts)、[snapshot](../../tests/unit/agent/request-snapshot.test.ts)、[context](../../tests/unit/agent/context-limits.test.ts) | [RUNTIME](RUNTIME.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| 最近 coding 请求检查 | [context inspection](../../src/agent/context-inspection.ts)、[react-agent](../../src/agent/react-agent.ts)、[context surface](../../src/tui/components/screens/context-surface.tsx) | [context inspection](../../tests/unit/agent/context-inspection.test.ts)、[daily-use surfaces](../../tests/unit/tui/daily-use-surfaces.test.tsx) | [RUNTIME](RUNTIME.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| 项目规则、嵌套 AGENTS、动态约束 | [project context](../../src/agent/project-context.ts)、[react-agent](../../src/agent/react-agent.ts) | [project context](../../tests/unit/agent/project-context.test.ts) | [TOOLS](TOOLS.md) |
| 最终检查、诊断、取消后结算 | [task runner](../../src/workflow/task-runner.ts)、[runtime](../../src/workflow/runtime.ts)、[verifier](../../src/workflow/verifier.ts) | [task runner](../../tests/unit/workflow/task-runner.test.ts)、[runtime](../../tests/unit/workflow/runtime.test.ts)、[verifier](../../tests/unit/workflow/verifier.test.ts) | [RUNTIME](RUNTIME.md) |
| coding 提问、执行清单、`/tasks` | [react-agent](../../src/agent/react-agent.ts)、[task progress](../../src/workflow/task-progress.ts)、[App](../../src/tui/app/app.tsx)、[task surface](../../src/tui/components/screens/task-progress-surface.tsx) | [react-agent](../../tests/unit/agent/react-agent.test.ts)、[task progress](../../tests/unit/workflow/task-progress.test.ts)、[App](../../tests/unit/tui/app.test.tsx) | [RUNTIME](RUNTIME.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| Git/显式路径追踪、undo、并发编辑保护 | [tracker](../../src/workflow/workspace-tracker.ts)、[checkpoint](../../src/workflow/checkpoint.ts)、[apply patch](../../src/tools/apply-patch.ts)、[raw file version](../../src/tools/file-version.ts) | [tracker](../../tests/unit/workflow/workspace-tracker.test.ts)、[patch](../../tests/unit/tools/apply-patch.test.ts)、[checkpoint](../../tests/unit/workflow/checkpoint.test.ts) | [TOOLS](TOOLS.md)、[RUNTIME](RUNTIME.md) |
| 分页文件读取、随包 rg 搜索/glob、结果续读 | [files](../../src/tools/files.ts)、[ripgrep](../../src/tools/ripgrep.ts)、[workspace](../../src/tools/workspace.ts) | [files](../../tests/unit/tools/files.test.ts)、[ripgrep](../../tests/unit/tools/ripgrep.test.ts)、[workspace](../../tests/unit/tools/workspace.test.ts) | [TOOLS](TOOLS.md) |
| Composer 文件引用 | [attachments](../../src/agent/file-attachments.ts)、[prompt](../../src/tui/composer/prompt.tsx)、[task runner](../../src/workflow/task-runner.ts) | [attachments](../../tests/unit/agent/file-attachments.test.ts)、[prompt](../../tests/unit/tui/prompt-history.test.tsx)、[react-agent](../../tests/unit/agent/react-agent.test.ts) | [TOOLS](TOOLS.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| 人工 `/diff` 与模型变更审阅 | [workspace review](../../src/tools/workspace-review.ts)、[workspace tools](../../src/tools/workspace.ts)、[diff surface](../../src/tui/components/screens/workspace-diff-surface.tsx) | [workspace review](../../tests/unit/tools/workspace-review.test.ts)、[daily-use surfaces](../../tests/unit/tui/daily-use-surfaces.test.tsx) | [TOOLS](TOOLS.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| 原生隔离的 TypeScript 语义导航 | [code navigation](../../src/tools/code-navigation.ts)、[native duplex](../../src/codex/cli.ts)、[sandbox policy](../../src/tools/sandbox-policy.ts)、[dependencies](../../src/tui/app/dependencies.ts) | [navigation](../../tests/unit/tools/code-navigation.test.ts)、[duplex](../../tests/unit/codex/cli.test.ts)、[sandbox boundaries](../../tests/unit/tools/sandbox-boundaries.test.ts) | [TOOLS](TOOLS.md)、[SANDBOX](SANDBOX.md) |
| 模型 shell、后台任务、输出、取消 | [bash](../../src/tools/bash.ts)、[background jobs](../../src/tools/background-jobs.ts)、[process cancel](../../src/tools/process-cancel.ts) | [bash](../../tests/unit/tools/bash.test.ts)、[jobs](../../tests/unit/tools/background-jobs.test.ts)、[Agent](../../tests/unit/agent/react-agent.test.ts)、[runner](../../tests/unit/workflow/task-runner.test.ts)、[sandbox boundaries](../../tests/unit/tools/sandbox-boundaries.test.ts) | [TOOLS](TOOLS.md#模型-shell-与后台任务)、[SANDBOX](SANDBOX.md) |
| 原生 sandbox、权限、审批 | [policy](../../src/permissions/policy.ts)、[sandbox policy](../../src/tools/sandbox-policy.ts)、[native CLI](../../src/codex/cli.ts) | [permissions](../../tests/unit/permissions.test.ts)、[sandbox boundaries](../../tests/unit/tools/sandbox-boundaries.test.ts) | [PERMISSIONS](PERMISSIONS.md)、[SANDBOX](SANDBOX.md) |
| 公共网页读取/搜索、SSRF | [web](../../src/tools/web.ts) | [web](../../tests/unit/tools/web.test.ts) | [CODEX_CAPABILITIES](CODEX_CAPABILITIES.md)、[PERMISSIONS](PERMISSIONS.md) |
| MCP tools/resources/templates/prompts、完整定义校验与 step binding | [MCP runtime](../../src/mcp/runtime.ts)、[结果投影](../../src/mcp/results.ts)、[react-agent](../../src/agent/react-agent.ts) | [MCP runtime](../../tests/unit/mcp/runtime.test.ts)、[真实 stdio/HTTP 协议](../../tests/unit/mcp/protocol.test.ts)、[react-agent](../../tests/unit/agent/react-agent.test.ts) | [CODEX_CAPABILITIES](CODEX_CAPABILITIES.md) |
| Skill 发现、安装、向导 | [catalog](../../src/skills/catalog.ts)、[manager](../../src/skills/manager.ts)、[wizard](../../src/tui/components/wizards/skill-wizard.tsx) | [catalog](../../tests/unit/skills/catalog.test.ts)、[manager](../../tests/unit/skills/manager.test.ts)、[wizard](../../tests/unit/tui/skill-wizard.test.tsx) | [CODEX_CAPABILITIES](CODEX_CAPABILITIES.md) |
| 模型注册、凭据、Session 恢复 | [registry](../../src/storage/model-registry.ts)、[auth](../../src/storage/auth-storage.ts)、[SessionStore](../../src/storage/session-store.ts) | [registry](../../tests/unit/storage/model-registry.test.ts)、[SessionStore](../../tests/unit/storage/session-store.test.ts)、[App](../../tests/unit/tui/app.test.tsx) | [STATE_AND_UI](STATE_AND_UI.md) |
| 模型历史/关系检索、输出附件恢复与压力裁剪 | [session history](../../src/storage/session-history.ts)、[session outputs](../../src/storage/session-outputs.ts)、[context limits](../../src/agent/context-limits.ts)、[react-agent](../../src/agent/react-agent.ts)、[redaction](../../src/util/redact-secrets.ts) | [session history](../../tests/unit/storage/session-history.test.ts)、[session outputs](../../tests/unit/storage/session-outputs.test.ts)、[react-agent](../../tests/unit/agent/react-agent.test.ts)、[redaction](../../tests/unit/util/redact-secrets.test.ts) | [TOOLS](TOOLS.md)、[RUNTIME](RUNTIME.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| `/fork`、lineage 与独立 Session 副本 | [SessionStore](../../src/storage/session-store.ts)、[session outputs](../../src/storage/session-outputs.ts)、[App](../../src/tui/app/app.tsx) | [SessionStore](../../tests/unit/storage/session-store.test.ts)、[App](../../tests/unit/tui/app.test.tsx) | [STATE_AND_UI](STATE_AND_UI.md) |
| `/resume` Session 搜索与预览 | [SessionStore](../../src/storage/session-store.ts)、[session picker](../../src/tui/components/navigation/session-picker.tsx)、[App](../../src/tui/app/app.tsx) | [SessionStore](../../tests/unit/storage/session-store.test.ts)、[picker](../../tests/unit/tui/session-picker.test.tsx)、[App](../../tests/unit/tui/app.test.tsx) | [STATE_AND_UI](STATE_AND_UI.md) |
| `/status` 与累计 usage 显示 | [model status](../../src/status/model-status.ts)、[status card](../../src/tui/components/screens/status-card.tsx) | [status](../../tests/unit/status/model-status.test.ts)、[card](../../tests/unit/tui/status-card.test.tsx) | [STATE_AND_UI](STATE_AND_UI.md) |
| Goal、Plan、Memory | [Goal](../../src/goal/runtime.ts)、[Plan](../../src/plan/runtime.ts)、[Memory](../../src/memory/learned-memory.ts) | [Goal](../../tests/unit/goal/runtime.test.ts)、[Plan](../../tests/unit/plan/runtime.test.ts)、[Memory](../../tests/unit/memory/learned-memory.test.ts) | [STATE_AND_UI](STATE_AND_UI.md)、[MEMORY](MEMORY.md) |
| Slash、inline 布局、输入、历史 | [App](../../src/tui/app/app.tsx)、[commands](../../src/tui/commands/slash-commands.ts)、[command surface](../../src/tui/components/screens/command-surface.tsx)、[prompt](../../src/tui/composer/prompt.tsx) | [App](../../tests/unit/tui/app.test.tsx)、[surface](../../tests/unit/tui/command-surface.test.tsx)、[history](../../tests/unit/tui/history-window.test.ts) | [TUI_STRUCTURE](TUI_STRUCTURE.md)、[STATE_AND_UI](STATE_AND_UI.md) |
| 直接 `!`、PTY、终端设置 | [terminal](../../src/tools/terminal.ts)、[TUI entry](../../src/tui/index.tsx)、[settings](../../src/tui/terminal/settings.ts) | [terminal](../../tests/unit/tools/terminal.test.ts)、[TUI entry](../../tests/unit/tui/index.test.ts)、[setup](../../tests/unit/tui/terminal-setup.test.ts) | [STATE_AND_UI](STATE_AND_UI.md) |
| benchmark、命名 checkout、固定 dsh、独立验收 | [campaign CLI](../../src/benchmark/campaign-cli.ts)、[checkout worker](../../src/benchmark/checkout.ts)、[production](../../src/benchmark/production.ts)、[preparation](../../src/benchmark/preparation.ts)、[dsh](../../src/benchmark/dsh.ts) | [campaign](../../tests/unit/benchmark/campaign.test.ts)、[checkout](../../tests/unit/benchmark/checkout.test.ts)、[preparation](../../tests/unit/benchmark/preparation.test.ts)、[dsh](../../tests/unit/benchmark/dsh.test.ts)、[runner](../../tests/unit/benchmark/runner.test.ts) | [BENCHMARKING](../BENCHMARKING.md) |
| 性能 trace、并发结果背压 | [trace](../../src/performance/trace.ts)、[agent-loop](../../src/agent/agent-loop.ts)、[metrics](../../src/benchmark/metrics.ts) | [agent loop](../../tests/unit/agent/agent-loop.test.ts)、[metrics](../../tests/unit/benchmark/metrics.test.ts) | [RUNTIME](RUNTIME.md)、[BENCHMARKING](../BENCHMARKING.md) |

## 主要数据流

```text
CLI → model registry + keyring → TUI dependencies → App
                                              ↓
                         CodingTaskRunner + workflow + Goal/Memory
                                              ↓
                  ReactAgent → prepare step → request snapshot/executor
                                              ↓
                           Responses response → tool scheduler
                                              ↓
               permission check → file/web/MCP/Skill/native shell tool
                                              ↓
                 persist ordered context + usage → next sampling
                                              ↓
                  finish jobs → full verification → host settlement
```

1. TUI、exec、SDK 和 benchmark 各自完成输入适配与任务准入，再交给共享任务 runner；工具/模型回调更新各自输出，同时按对应通道保存 Session。
2. Agent 在完整响应边界执行工具，后续 step 更新适用规则、Memory、已落盘历史读取边界和工具快照；普通网络重试复用同一步快照。
3. workflow 记录任务开始内容基线，跟踪结构化与 shell 修改，在最终检查前后对比 revision，过期结果不得结算。
4. 应用协调维护会话归属和操作身份；runner 统一任务内部 generation、执行清单范围、诊断轮数、后台资源清理与完成通知、停止原因、Goal 完成与 Memory outcome；各入口复用这条链。
5. 评测器另建评分工作区并用 evaluator-owned assertions 判断结果；通过可被模型改写的 npm scripts 不等于独立验收通过。

持久化的 timeline、模型 context 与 workflow 元数据是不同通道；详细字段和恢复不变量见 [STATE_AND_UI](STATE_AND_UI.md)。

## 文档与源码的使用规则

- 回答已知架构问题先用专题；未涉及的模块不需要重新扫描。
- 开始改代码时仍须读取目标函数、直接调用者和对应测试，不能把文档当作当前文件内容。
- 文件移动或接口变化时同步修改本表中的源码、测试和专题链接；不要复制大段源码到文档。
- 新能力先确定归属模块与状态所有者，再添加实现；不要把持久化、权限或最终结算下沉到 UI 展示组件。
- 临时实验、未跟踪用户目录和历史归档不是稳定入口；是否已交付、是否真正运行验收只看当前 HANDOFF 证据。
- 本页不保存易变版本、提交或测试数量，避免入口知识随每次交付失真。
