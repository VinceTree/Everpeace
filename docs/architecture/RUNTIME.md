# Coding runtime：请求、工具循环与可信结算

本文说明当前生产代码的职责边界。先读根目录 [AGENTS.md](../../AGENTS.md) 和 [HANDOFF](../HANDOFF.md)，再按下表定位；不需要为普通修改重新遍历整个仓库。测试和当前源码优先于历史决策，实时版本、门禁结果和待验收事项只在 HANDOFF 维护。

## 按任务最小阅读

| 要修改的行为 | 先读本文章节 | 必要源码与回归 |
|---|---|---|
| 模型参数、请求失败、token | 请求与计量 | [capabilities](../../src/providers/capabilities.ts)、[provider factory](../../src/providers/openai-compatible.ts)、[provider tests](../../tests/unit/providers/capabilities.test.ts) |
| 重试、流、并发、steering | ReAct 循环 | [ReactAgent](../../src/agent/react-agent.ts)、[agent-loop](../../src/agent/agent-loop.ts)、[loop boundaries](../../tests/unit/agent/loop-boundaries.test.ts) |
| 自动修复、完成状态、取消 | Coding task 与验证 | [task-runner](../../src/workflow/task-runner.ts)、[workflow](../../src/workflow/runtime.ts)、[runner tests](../../tests/unit/workflow/task-runner.test.ts) |
| 压缩、上下文大小 | 上下文 | [request-snapshot](../../src/agent/request-snapshot.ts)、[ReactAgent tests](../../tests/unit/agent/react-agent.test.ts) |
| 修改识别或手动验证 | 变更与检查 | [workspace-tracker](../../src/workflow/workspace-tracker.ts)、[verifier](../../src/workflow/verifier.ts)、[workflow tests](../../tests/unit/workflow/runtime.test.ts) |

## 生产调用关系

```text
TUI / 内部 benchmark adapter
  → CodingTaskRunner（整个编码任务及收尾）
    → CodingWorkflowRuntime（变更、检查、修复状态）
    → ReactAgent（Responses、上下文、工具路由）
      → runAgentLoop（sampling → durable record → tools → follow-up）
      → RequestExecutor → RequestAttemptLedger → provider client
    → 最终验证 → Goal / Memory 结算 → 宿主摘要
```

[TUI dependencies](../../src/tui/app/dependencies.ts) 负责构造真实 Agent、provider 和运行依赖；界面不应另写一套修复循环。内部 benchmark 也复用生产 runner，独立评分属于评测器职责。

## 请求与计量

- `createProviderRuntime` 统一 client、能力与请求设置。只使用 Responses；模型 ID 保留服务端原值，不能通过名称推测中转端点支持官方能力。
- 官方 DeepSeek 使用普通 reasoning/tool item、summary 压缩和供应商自动前缀缓存；不发送 OpenAI encrypted reasoning、prompt-cache 或 native compact 参数。`max` 原样映射到 DeepSeek `max`。
- 官方 OpenAI 声明 native compact；未知兼容端点使用 summary 和保守能力。SDK 上存在方法不等于服务端支持该能力。
- 编码默认 `high` / 32,768 输出 tokens；不支持 reasoning 的端点不发送该参数。产品默认输出预算与供应商能力上限分别保存；DeepSeek 当前能力上限为未知。
- `/reasoning` 等设置对后续任务生效，任务内使用一致配置。用途设置由 `requestSettingsForPurpose` 集中定义：summary 8,192、Skill 4,096、Memory 800、title 64、doctor 16 输出 tokens；辅助请求关闭 reasoning，并各有超时。
- SDK 自动重试关闭，由宿主控制请求边界。辅助请求必须校验终态及所需正文，不能把 incomplete 或空白响应标为成功。

[RequestExecutor](../../src/agent/request-executor.ts) 在请求前准入，完成、失败、取消均结算 attempt；被准入拒绝的调用记为 rejected，不假装已消费模型 tokens。编码、摘要、重试、传输 fallback 与生产辅助调用均经过此边界。

[RequestAttemptLedger](../../src/agent/request-attempt-ledger.ts) 以 input + output 结算预算；reasoning 单列展示，不与已包含它的 output 重复相加。已经发出的请求缺少可靠 usage 后，当前账本的 incomplete 状态不可被后续成功覆盖，禁止继续准入；新宿主任务仅能在没有未结束 attempt 时重置账本。

CLI 分开显示主编码与辅助用量；Session 编码总量不混入标题请求。预算耗尽时禁止下一请求，但已发出的请求可能超出剩余额度，超出量必须保留。usage、缓存命中及写入的完整性分别判断，缺字段不补造零成本或实际账单。

回归入口：[attempt ledger](../../tests/unit/agent/request-attempt-ledger.test.ts)、[provider compatibility](../../tests/unit/providers/openai-compatible.test.ts)、[response errors](../../tests/unit/agent/response-errors.test.ts)。

## ReAct 循环

1. 每个逻辑 step 准备项目规则、MCP、Skills、Memory 与工具快照；独立准备并行执行，全部完成后才发送请求。普通网络重试复用同一步快照。
2. 消费完整 Responses 响应；仅 completed 响应中的完整工具集合允许进入 dispatch。缺失或重复 `call_id` 在落盘和执行前拒绝。
3. 先保存模型响应，再执行工具；工具结果按模型原始顺序保存。保存失败阻止后续副作用，不当成普通工具错误让模型继续。
4. 有工具调用或明确 `end_turn: false` 则继续采样；普通回答结束并不等于编码任务验证通过。

生产启用最多四个经过能力审定的只读工具并发；`parallelReadTools` 是宿主调度设置，和发给供应商的 `parallel_tool_calls` 分离。某个读取完成即可补入下一项，连续已就绪结果按序持久化后释放缓存；全部完成但未持久化结果受数量与字节背压限制。写入、shell、MCP、审批和不安全读取形成串行屏障。

dispatch 仍检查实时权限、当前 step 广告工具集合、停止状态和取消。Plan 只读限制由宿主实施；不能依靠模型遵循提示。steering 在安全点保存并更新上下文，未启动工具补齐 `steered` output，不能遗留断开的工具链。

采样默认最多两次重试；退避支持 `Retry-After` 和取消。普通重试不包含永久错误或上下文超限，也不重新执行已完成工具。传输 fallback 只在尚无流事件且端点明确拒绝 streaming 时使用。

每个 attempt 有取消控制器；SSE 默认 60 秒空闲超时，结束时关闭 iterator/transport，前一次尚在运行时不能开始重试。仅可靠 reasoning delta 显示 Thinking，否则展示通用等待。

默认每个 turn 最多 32 个逻辑 step；可选 turn 时限、Goal token 限额与 usage 不完整产生明确 stop reason。sampling retry、stream recovery、context recovery 各自有独立预算。停止后不启动工具、自动修复或 Goal 续跑。

来源和细化的顺序协议见 [AGENT_LOOP](AGENT_LOOP.md)；文件与命令工具机制见 [TOOLS](TOOLS.md)。

## Coding task 与验证

`CodingTaskRunner` 持有整个任务的生命周期，协调 Agent、后台命令、验证、诊断、Goal 和 Memory；同一 runner 在执行或清理中拒绝第二个任务。取消、异常或预算停止先收束后台命令并丢弃待完成意图。最终检查返回后、Goal 结算前和 Memory 捕获前再次检查取消。

`WorkflowState` 将 phase 与结果分开：

| 结果 | 含义 |
|---|---|
| `verified` | 本轮代码变更通过当前文件版本绑定的完整检查，且追踪未受限 |
| `unverified` | 缺检查、追踪受限、结果过期或旧任务验证债务尚未消除 |
| `failed` | 检查或 review 失败，可能仍可诊断，也可能达到修复上限 |
| `no_changes` | 没有观察到本轮变更，且没有遗留未验证事实；不代表执行过检查 |

取消、预算、step 和时限停止继续保留独立停止原因。Session 旧记录缺字段时不能推断为 verified。

宿主实际启动诊断轮时才增加 `repair_attempts`，同一轮多次 patch 的快速检查失败不重复计数。最多三轮，耗尽后 phase 为 blocked，后续所有工具和自动 Goal 续跑停止；新用户任务可以重新授权修复预算，仍保留旧未验证事实。

Session 恢复使用 `resumeTurn` 重建进程内追踪，不清除任务身份、修复上限或验证债务；结构化 undo 检查点和文件观察版本不恢复。Goal 自动续跑只有在本轮结算允许时发生，不能利用空改动绕过旧债务。

模型的编码 Goal 完成请求只暂存意图，由宿主在结算时决定；验证失败、中断或受限不会提交完成。真正无变更且无债务的任务可按 no_changes 结束。成功 learned-memory 仅接收 verified，详见 [MEMORY](MEMORY.md)。

## 变更与检查

- `WorkspaceChangeTracker` 在任务基线、shell 前后和最终检查边界观察内容指纹；Git 使用结构化 NUL 路径，将仓库根路径映射到工作区范围，不能混入兄弟目录。
- 已脏文件再次变化、新建、删除、中文/空格路径及恢复原状都按内容比较；Git 可见路径与显式编辑路径取并集，显式修改 ignored 文件仍触发验证。
- 普通 ignored 且未跟踪的构建产物不加入快照；非 Git shell 或扫描受限不得声称完整验证。结构化编辑仍可用检查点 review。
- patch 后快速检查优先使用现有 typecheck 或 lint。完成前重新读取当前 `package.json`，按 typecheck → lint → test → build 执行全部已声明脚本，包含快速检查用过的命令。
- 检查串行且首败停止，未执行项显示为 skipped；修复后从头跑全套。没有命令返回 unavailable。检查不自动安装依赖或执行发布脚本。
- 最终 suite 前后比较版本；文件变化则重新发现命令并完整补跑，最多补跑两次。持续变化标记 unverified/stale，旧退出零不能结算当前内容。
- `/verify` 共用取消、权限和文件快照语义；显式 `/verify <command>` 仅作补充证据，不冒充完整 suite 或自动完成 Goal。
- 宿主摘要显示观察到的改动、检查及阻塞原因；模型回答不是成功判据。JSONL 只保存 workflow 元数据，不保存检查 stdout/stderr、错误正文或文件检查点。

回归入口：[workspace tracking](../../tests/unit/workflow/workspace-tracker.test.ts)、[verification](../../tests/unit/workflow/verifier.test.ts)、[workflow state](../../tests/unit/workflow/runtime.test.ts)、[checkpoint](../../tests/unit/workflow/checkpoint.test.ts)。

## 上下文与性能证据

`RequestSnapshot` 从实际请求同时生成内容估算、输出预留与指纹，估算标为 UTF-8 bytes / 4，不能伪装为供应商实测。已知窗口自动阈值取 `min(窗口 × 80%, 窗口 − 输出预算 − 安全余量)`，安全余量为窗口 5%、最多 32K。

`ReactAgent` 只在 coding provider call 通过请求执行器准入、即将实际发送时，从该 `RequestSnapshot` 捕获只读的 “Last submitted coding request”。估算阶段、被拒绝的准入、标题/Skill/Memory/doctor/summary 等辅助请求不会替换它。快照仅存在当前 Agent 内存，深复制后通过可选 `getContextSnapshot()` 暴露；重启、恢复 Session 或替换 Agent 后不从历史重建。

快照记录 model/provider、提交时间、context revision、序列化请求估算、输出预留与指纹，以及项目规则来源、Skills、Memory、MCP、广告工具、文件附件范围、conversation item counts 和 opaque item 的数量/大小。已知可见来源只保存有界、沿用现有 secret redaction 的预览；凭据、transport headers、reasoning 和 encrypted bodies 不进入预览。组件大小是局部近似，不要求加总等于序列化请求估算；所有估算与响应返回的 measured usage 明确分开。

summary 以完整 assistant/tool-result 交互边界切割，保留最近两个单元并修复工具配对，单个用户任务也可压缩。摘要请求复用稳定指令与工具定义，设置 `tool_choice: none`；摘要不能把模型自述升级为验证事实。

incomplete、空白、没有缩短的摘要以及取消、持久化失败都保留原上下文；少于三个可切割单元明确返回不能安全压缩。已发出摘要的用量即使结果被丢弃也结算。context-limit 恢复最多一次，不能重复执行工具。

当前有效项目规则每次请求重新提供，历史 rule snapshot 从模型输入和压缩输入中过滤，避免旧规则被摘要固化。其他动态上下文及前缀的缓存收益需实测，不能把指纹稳定等同于缓存命中提升。压缩后 context 占用设为未知，等待下一次实际 response usage。

性能 trace 只保存单调耗时、数量、字节、指纹和状态，不新增请求正文、文件内容或凭据。协议与离线回归不能代替真实模型成功率、Windows Terminal 交互或 dsh 实测；当前验收边界查 [HANDOFF](../HANDOFF.md)。
