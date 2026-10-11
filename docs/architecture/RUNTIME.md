# Coding runtime：请求、工具循环与可信结算

模型传输/流恢复、上下文/压缩和文件观察由内部状态所有者管理；任务性能与验证证据是可选解释字段，不改变可信结算。入口及测试见 [验证与性能](VALIDATION_PRIVACY_PERFORMANCE.md)。

本文说明当前生产代码的职责边界。先读根目录 [AGENTS.md](../../AGENTS.md) 和 [HANDOFF](../HANDOFF.md)，再按下表定位；不需要为普通修改重新遍历整个仓库。测试和当前源码优先于历史决策，实时版本、门禁结果和待验收事项只在 HANDOFF 维护。

## 按任务最小阅读

| 要修改的行为 | 先读本文章节 | 必要源码与回归 |
|---|---|---|
| 模型参数、请求失败、token | 请求与计量 | [capabilities](../../src/providers/capabilities.ts)、[provider factory](../../src/providers/openai-compatible.ts)、[provider tests](../../tests/unit/providers/capabilities.test.ts) |
| 重试、流、并发、steering | ReAct 循环 | [ReactAgent](../../src/agent/react-agent.ts)、[agent-loop](../../src/agent/agent-loop.ts)、[loop boundaries](../../tests/unit/agent/loop-boundaries.test.ts) |
| step 工具集合、准入与 MCP binding | ReAct 循环 | [工具目录](../../src/agent/step-tool-catalog.ts)、[目录回归](../../tests/unit/agent/step-tool-catalog.test.ts) |
| 自动修复、完成状态、取消 | Coding task 与验证 | [task-runner](../../src/workflow/task-runner.ts)、[workflow](../../src/workflow/runtime.ts)、[runner tests](../../tests/unit/workflow/task-runner.test.ts) |
| 编码提问、执行清单、后台完成通知 | ReAct 循环、Coding task 与验证 | [ReactAgent](../../src/agent/react-agent.ts)、[task progress](../../src/workflow/task-progress.ts)、[ReactAgent tests](../../tests/unit/agent/react-agent.test.ts) |
| 压缩、上下文大小 | 上下文 | [conversation-checkpoint](../../src/agent/conversation-checkpoint.ts)、[request-snapshot](../../src/agent/request-snapshot.ts)、[checkpoint tests](../../tests/unit/agent/conversation-checkpoint.test.ts) |
| TUI/exec/SDK/benchmark 生产装配 | 生产调用关系 | [production factory](../../src/runtime/production.ts)、[factory tests](../../tests/unit/runtime/production.test.ts) |
| 模型任务准入、取消、会话归属与批准 | 应用协调与任务执行 | [coordinator](../../src/runtime/application-coordinator.ts)、[协调回归](../../tests/unit/runtime/application-coordinator.test.ts)、[App](../../tests/unit/tui/app.test.tsx) |
| 非交互任务、预算与退出状态 | 请求与计量、Coding task 与验证 | [exec runtime](../../src/exec/runtime.ts)、[exec tests](../../tests/unit/exec/runtime.test.ts) |
| 修改识别或手动验证 | 变更与检查 | [workspace-tracker](../../src/workflow/workspace-tracker.ts)、[verifier](../../src/workflow/verifier.ts)、[workflow tests](../../tests/unit/workflow/runtime.test.ts) |

## 生产调用关系

[DeepSeek 官方契约回归](../../tests/unit/providers/deepseek-contract.test.ts) 通过实际 SDK 与 fake fetch 观察生产请求及 Session 计量。覆盖原始模型 ID、high/输出上限、不发送服务端会话参数、工具调用配对、completed/incomplete/failed、无终止事件、缺失 usage 和取消。请求从未接触真实模型；reasoning 包含在 output 里，不重复扣预算。官方协议出处：[Responses API](https://api-docs.deepseek.com/guides/responses_api/)。

```text
TUI / everpeace exec / everpeace/sdk / 内部 benchmark adapter
  → production factory（provider、Agent、历史/附件、Memory、MCP、sandbox command）
  → CodingTaskRunner（整个编码任务及收尾）
    → CodingWorkflowRuntime（变更、检查、修复状态）
    → ReactAgent（Responses、上下文、工具路由）
      → runAgentLoop（sampling → durable record → tools → follow-up）
      → RequestExecutor → RequestAttemptLedger → provider client
    → 最终验证 → Goal / Memory 结算 → 宿主摘要
```

[production factory](../../src/runtime/production.ts) 是真实 Agent/命令装配边界，集中 provider、Session 历史/附件、Skills、MCP、learned Memory、Goal、代码导航、sandbox policy 与请求账本。TUI dependencies 只提供交互和状态回调；[exec runtime](../../src/exec/runtime.ts) 与公开 SDK 提供无 Ink 的交互停止策略；内部 benchmark 继续显式覆盖评测用批准/参数。各入口复用生产 runner，不得各自复制修复、验证或资源清理循环；独立评分仍属于评测器职责。

## 应用协调与任务执行

[ApplicationCoordinator](../../src/runtime/application-coordinator.ts) 管理 TUI 的进程内 Session／Agent 身份、模式、模型任务准入、取消、待执行批准和命令操作身份，不依赖 React、Ink、TUI 或存储实现。TUI 完成宿主 I/O 后提交会话替换；初次创建仅附着到已准入任务。取消保留任务占位，直到宿主等待既有 runner 资源清理后调用 finishTask；旧句柄不能释放新任务。

完整批准正文在当前身份匹配、未取消的 Plan 任务结束后保存，执行准入同步消费这份正文。新讨论、模式退出、会话／Agent 替换使其失效；迟到或重复完成不能重新授权。协调状态不推导 verified、Goal 完成或 Memory 成功，fork 的持久待继续标记仍由已有 Session／runner 验证结算处理，exec 与 SDK 生命周期也保持现有实现。界面、存储和用户命令契约见 [STATE_AND_UI](STATE_AND_UI.md)，回归见 [协调状态](../../tests/unit/runtime/application-coordinator.test.ts) 与 [生产 Plan 闭环](../../tests/unit/runtime/plan-execution.test.tsx)。

每个 coding request 的动态 instructions 还包含宿主提供的运行时身份：固定的 Everpeace agent 身份、实际 provider、模型原始 ID、Responses 协议和当前 workspace/cwd。该身份块放在工作区规则、Skills、Memory、MCP 和任务状态之后，作为每次请求的最终 host boundary；Agent 会先把 workspace/cwd 规范为绝对路径。模型应使用这些宿主事实做自我定位，工作区文本不能重新定义 agent、provider、model、protocol 或 cwd。provider、model 和 cwd 以 JSON 字符串写入，避免路径或注册值中的换行/控制文本伪装成新的指令。它们来自宿主装配而不是工作区文件，不授予额外权限，也不作为项目规则或 Session 内容持久化；这样模型可以明确区分当前 checkout 与不可信的仓库文本。

## 请求与计量

请求布局由 [provider 投影](../../src/providers/request-projection.ts) 集中决定。DeepSeek profile 使用稳定 `instructions` 保存基础宿主指令，完整历史之后追加最新 `system` 宿主状态；不把宿主规则放在被解释为 user 的 `developer` 中。官方 OpenAI 保持自身缓存布局，generic 使用保守 instructions。投影不改写持久历史，不使用服务端会话或 Chat Completions 的 `reasoning_content`。

注册可保存可选 `responses_profile: auto|generic|deepseek`；旧注册默认 auto，未知中转不根据模型名启用 reasoning。显式 deepseek 仍保留真实 provider 地址身份，能力来源显示 configured。该配置绑定注册 ID、地址与原始模型 ID；设置入口拒绝过期身份，不读取或写入凭据。修改会清除旧 request settings；TUI、exec、SDK 与辅助请求共用解析，旧 Session 缺字段兼容。配置证据不等于供应商实测证据。

- `createProviderRuntime` 统一 client、能力与请求设置。只使用 Responses；模型 ID 保留服务端原值，不能通过名称推测中转端点支持官方能力。
- Node 模型连接读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（同名小写优先），使用每个 client 独立的 Undici dispatcher，不修改全局网络设置。`ALL_PROXY` 不单独作为配置入口；配置无效报固定错误，不输出可能含凭据的代理 URL。主 Agent 先等待请求、Memory 与工具清理，再释放其拥有的连接；外部传入 provider 由调用者负责释放。登录、标题、Skill、手动 Memory 与 doctor 在各自请求结束后释放连接，取消后强制关闭残留 CONNECT。该代理不改变网页 SSRF 或模型 shell 原生隔离边界。回归见 [proxy transport](../../tests/unit/providers/proxy-transport.test.ts)。
- 官方 DeepSeek 使用普通 reasoning/tool item、summary 压缩和供应商自动前缀缓存；不发送 OpenAI encrypted reasoning、prompt-cache 或 native compact 参数。`max` 原样映射到 DeepSeek `max`。
- 官方 OpenAI 声明 native compact；未知兼容端点使用 summary 和保守能力。SDK 上存在方法不等于服务端支持该能力。
- 编码默认 `high` / 32,768 输出 tokens；不支持 reasoning 的端点不发送该参数。产品默认输出预算与供应商能力上限分别保存；DeepSeek 当前能力上限为未知。
- `/reasoning` 等设置对后续任务生效，任务内使用一致配置。用途设置由 `requestSettingsForPurpose` 集中定义：summary 8,192、Skill 4,096、Memory 800、title 64、doctor 16 输出 tokens；辅助请求关闭 reasoning，并各有超时。
- SDK 自动重试关闭，由宿主控制请求边界。辅助请求必须校验终态及所需正文，不能把 incomplete 或空白响应标为成功。

[RequestExecutor](../../src/agent/request-executor.ts) 在请求前准入，完成、失败、取消均结算 attempt；被准入拒绝的调用记为 rejected，不假装已消费模型 tokens。编码、摘要、重试、传输 fallback 与生产辅助调用均经过此边界。

ReactAgent 在每个实际 provider attempt 结束后立即结算 coding 的 Session/Goal 用量；流恢复、采样重试和能力降级各有独立样本，不能只记录逻辑请求的最终成功。账本触发停止仍须保存已发出请求的 unknown 样本。未准入的请求不产生 usage 样本；用量持久化失败不能被 steering、网络重试或 fallback 吞掉。

已准入的 provider attempt 失败且触发 unknown 停止时，Agent 的当前 turn 保留宿主生成的 HTTP 错误状态（仅 400–599 整数）和固定 sampling category。共享 runner 把它加入停止提示，exec/SDK 使用已有 `error` 字段返回；仍保持 `usage_limited`、退出码 4、不重试和不执行后续工具。供应商 message、body、headers、凭据及任意 error 字段不进入该诊断；没有实际请求失败的缺失 usage 不伪造 HTTP 错误。回归见 [exec runtime](../../tests/unit/exec/runtime.test.ts)。

压缩每个 attempt 结束后立即更新 Goal，再检查下一请求准入。Session 保留原有 context_compacted 事件的最终 usage 增量和上下文替换；此前失败样本另存 usage，压缩失败则保存全部样本。不得重复计量或改变既有 schema。prepareStep 中的预算停止返回明确 stop reason，不包装成压缩错误。回归见 [request settlement](../../tests/unit/agent/request-settlement.test.ts)。

手动压缩也绑定当前 active Goal，已达到预算或 usage 停止的 Goal 在准入前拒绝，不依赖可选 task ledger 才生效。预取消不读写 Goal 或发出请求；压缩期间拒绝 turn、task reset、设置变更和第二次压缩。Agent 为 turn 和手动压缩分别持有取消控制器及完成 Promise；dispose 先关闭准入，取消并等待请求、持久化和后台清理，再释放内存，重复 dispose 共用完成结果。取消发生在 context 已持久化后仍保持内存与落盘一致，保留已知用量，但不报告成功。回归见 [生产手动压缩](../../tests/unit/runtime/manual-compaction.test.ts)。

模型流关闭失败时，attempt 记为 failed，同时保留终态实际返回的可靠 usage；没有可靠 usage 则仍为 unknown。计量完整与资源关闭是独立事实：即使用量可计量、账本被重置，故障 executor/Agent 也不能再启动请求。ModelStreamCleanupError 和 ProcessCleanupError 共用 ResourceCleanupError 边界，资源故障优先于取消、steering、预算停止和能力降级。

[RequestAttemptLedger](../../src/agent/request-attempt-ledger.ts) 以 input + output 结算预算；reasoning 单列展示，不与已包含它的 output 重复相加。已经发出的请求缺少可靠 usage 后，当前账本的 incomplete 状态不可被后续成功覆盖，禁止继续准入；新宿主任务仅能在没有未结束 attempt 时重置账本。

TUI 分开显示主编码与辅助用量；Session 编码总量不混入标题请求。exec 的可选 task ledger 覆盖主请求、summary、retry 与 repair，并关闭结束后的 Memory capture，避免产生任务外辅助请求。预算耗尽时禁止下一请求，但已发出的请求可能超出剩余额度，超出量必须保留。usage、缓存命中及写入的完整性分别判断，缺字段不补造零成本或实际账单。

[AuxiliaryRequestExecutor](../../src/agent/auxiliary-request-executor.ts) 复用 RequestExecutor，把每项辅助操作的准入与 dependency 实例的累计显示分开。标题、Skill、doctor 和独立 Memory 操作拥有独立账本；同一后台 Memory job 的提取和合并共享 runtime 提供的 scope，用量缺失后不再请求合并，也不自动重试该 job。后续独立操作可以增加已知用量，但不能把累计 unknown 改回完整。资源清理故障则关闭整个辅助所有者的后续准入。dispose 取消并等待所有活动辅助请求及计量；已可靠返回的用量即使结果因取消被丢弃也保留。回归见 [辅助请求所有权](../../tests/unit/agent/auxiliary-request-executor.test.ts)、[实际 SDK fixture](../../tests/fixtures/tui-auxiliary-offline.ts)。

ReactAgent 将 Memory 的任务暂停接入已有 beginTask/endTask，范围包含 Plan、宿主验证、修复和 Goal 连续轮次；dispose 只清理 Agent 任务状态，不发送恢复通知；异步 Memory 暂停返回后重新检查 Agent 可用性，关闭不能留下迟到的任务进度。轮次 outcome 只决定新材料能否入队，整项任务退出后才重置可靠队列的五分钟空闲期；没有 pending learned turn 的退出仍通知单轮结束，不能让旧队列永久搁置。runtime 重建同样重新计时。生产行为见 [Memory 空闲回归](../../tests/unit/runtime/memory-idle-lifecycle.test.ts)。

Memory runtime 默认使用同一 job 的 RequestExecutor/ledger 执行提取和合并；生产 factory/TUI 的 host runner 将同一 RequestAccountingScope 交给辅助执行器，后者先检查所有者与取消，再使用该 executor 调用实际 provider。两种用量显示观察同一次结算，不把被拒绝的 wrapper 当成新 provider 请求。响应可靠但随后取消仍计量；准入前取消、关闭或旧资源故障没有新样本，旧故障中的 usage 不重复累计。scope 按 ledger 复用记录位置，换 signal 不清除未知用量，不能在同一 ledger 上悄悄替换 executor。回归见 [生产 Memory 准入](../../tests/unit/runtime/memory-request-ownership.test.ts) 和 [实际 SDK](../../tests/fixtures/memory-accounting-offline.ts)。

错误路径继续检查 job 账本是否有缺口；网络、不完整或空白响应不能通过重新排队及新 controller 绕过未知用量限制。可靠响应 usage 在终态与正文校验前保存，已知用量的普通重试保持原行为。后台认领及 pending 写入后复核实时 capture 策略与 generation，尚未准入的停止仍是零用量。此约束也适用于无辅助包装器的默认 runtime，回归见 [Memory jobs](../../tests/unit/memory/learned-memory.test.ts)。

回归入口：[attempt ledger](../../tests/unit/agent/request-attempt-ledger.test.ts)、[provider compatibility](../../tests/unit/providers/openai-compatible.test.ts)、[response errors](../../tests/unit/agent/response-errors.test.ts)。

## ReAct 循环

内部 `loopStrategy` 默认 baseline，只有显式候选评测采用 candidate。候选精简基础提示及五项读取描述，指导独立读取同轮、依赖操作分轮、失败后调整；名称、参数、目录顺序和四路安全读取边界不变。危险操作仍串行，完整终态 output 落盘前不执行工具。反馈在模型顺序提交结果时处理，避免并发完成顺序影响判断：相同工具、规范化参数与错误连续第二次失败追加一次提醒；正常后台轮询、取消和清理失败不触发。签名仅保留摘要，提醒不新增请求、不重放工具、不绕过批准或重新观察。

本地评测采集请求次数、批次大小、重复失败、工具等待、实际 usage/cache，以及 instructions、工具定义、工具结果和整个请求的 UTF-8 JSON 字节数。字节比例不当作 token；跨进程事件只传计数、时间和安全状态，不复制正文或 reasoning。只有质量门槛及完整计量满足后才判断候选效率，未证明有效的优化不进入默认生产行为。

1. 每个逻辑 step 准备项目规则、MCP、Skills、Memory、已落盘历史读取边界与工具快照；独立准备并行执行，全部完成后才发送请求。普通网络重试复用同一步快照。
2. 消费完整 Responses 响应；仅 completed 响应中的完整工具集合允许进入 dispatch。缺失或重复 `call_id` 在落盘和执行前拒绝。
3. 先保存模型响应，再执行工具；工具结果按模型原始顺序保存。保存失败阻止后续副作用，不当成普通工具错误让模型继续。
4. 有工具调用或明确 `end_turn: false` 则继续采样；普通回答结束并不等于编码任务验证通过。

完整助手消息与工具开始/完成事件允许异步宿主回调，生产链会等待输出消费端接受后继续，避免 exec 的慢管道积累无界待写任务。工具结果仍按原有顺序持久化；输出失败进入取消与资源清理，不作为普通 provider 网络重试。JSONL 大正文、缓冲与半条末行规则见 [STATE_AND_UI](STATE_AND_UI.md#非交互-exec)。

宿主提供交互回调时，`request_user_input` 在 Plan 和普通 coding 模式都可用。它保持一至三个问题、每题两至三个选项和 UI 自由文本入口；等待回答期间不发模型请求。回答按普通 function-call/output 配对先持久化，再继续该批剩余调用或下一次采样。Plan 的取消仍结束规划；coding 界面的 Esc/Ctrl+C 取消整个活动任务并进入统一后台清理。问题答案只是输入，不能批准 shell、patch、MCP 或其他权限操作。

普通 coding 还可调用 `update_plan` 整体替换当前执行清单。清单最多 20 个唯一非空步骤，单项最多 240 个 Unicode 字符，状态为 `pending / in_progress / completed`，且最多一个 `in_progress`；空数组明确清除。宿主在发布新投影前保存 `task_progress_updated`，失败即停止执行。当前投影作为明确标注的 model-authored 动态上下文加入每个请求，压缩后的请求也重新注入，因此历史工具调用或摘要不能覆盖当前值。

生产启用最多四个经过能力审定的只读工具并发；`parallelReadTools` 是宿主调度设置，和发给供应商的 `parallel_tool_calls` 分离。某个读取完成即可补入下一项，连续已就绪结果按序持久化后释放缓存；全部完成但未持久化结果及其待提交输出正文受数量与字节背压限制。超大结果的正文在并发执行阶段仅有界准备，按模型顺序提交附件、追加配对结果引用，再淘汰旧附件；任何存储失败均停止后续请求。写入、shell、MCP、审批和不安全读取形成串行屏障。

[StepToolCatalog](../../src/agent/step-tool-catalog.ts) 拥有一个逻辑 step 的工具定义、名称准入、MCP binding 和并发资格。ReactAgent 等 MCP／Skill／Memory／项目规则来源全部准备完毕后构建目录；定义和 metadata 深复制并冻结，普通采样 retry 复用，follow-up／steering 重建，turn 收尾丢弃。请求参数、稳定前缀、context inspection 与 dispatch 读取同一个目录；未广告的 MCP metadata 不能进入 binding 查询，MCP annotations 也不能取得本地读取的并发资格。目录不包含权限或持久化状态，不从 Session 历史恢复。

dispatch 仍检查实时权限、当前 step 目录、停止状态和取消。Plan 只读限制由宿主实施；不能依靠模型遵循提示。steering 在安全点保存并更新上下文，未启动工具补齐 `steered` output，不能遗留断开的工具链。目录只提供准入事实，不执行工具或授权操作；实际路由、审批、文件观察和结果落盘继续使用现有 ReactAgent 与工具实现。

活动 coding task 为每次 runner invocation 分配 generation。后台命令完成只排入该 generation 的元数据通知（job ID、终态、退出码、完成时间）；下一个普通 step 在工具结果配对和 steering 之后，通过既有 durable context 通道保存通知，成功后才确认出队，正文仍须用 `poll_background` 读取。通知不会唤醒空闲 Session 或额外发请求；任务结束会丢弃未送达项，迟到 callback 也因 generation 失效。运行中 job 与未送达通知合计最多 20 项，既有同时运行两个命令的限制继续生效。

后台管理器先登记任务及完成 promise，再调用生产执行器；同步启动失败也保留可查询的失败 job 并沿用一次完成通知。stopAll 清理期间关闭启动，dispose 永久关闭；终态后不接受迟到预览。runner 的等待与取消沿用该完成边界，worker 未结束时保持任务准入占用，并阻止最终验证。具体状态契约见 [后台任务](TOOLS.md#模型-shell-与后台任务)，受控 worker 的真实 Agent／runner 回归见 [task runner](../../tests/unit/workflow/task-runner.test.ts)。

采样默认最多两次重试；退避支持 `Retry-After` 和取消。普通重试不包含永久错误或上下文超限，也不重新执行已完成工具。传输 fallback 只在尚无流事件且端点明确拒绝 streaming 时使用。

每个 attempt 有取消控制器；SSE 默认 60 秒空闲超时。终态事件后先取消 transport，等待 iterator.return 确认 done 和尚未完成的 next；缺少关闭操作、done 非 true 或关闭拒绝都使当前所有者永久停止。自然 EOF 是已结束证据，不再多余 return。恢复后的流也须消费和清理结束才取消其恢复控制器；清理故障不能被原始中断替换或触发重试。仅可靠 reasoning delta 显示 Thinking，否则展示通用等待。

生产 [response-stream](../../src/providers/response-stream.ts) 从 SDK 的原始 HTTP Response 接管 body reader，继续复用 SDK SSE 解码。它独立等待 reader.cancel、活动 read 和 reader lock 释放，不能依赖 SDK 在 abort 后快速返回或忽略取消错误。已经 errored 的 body 所重抛的同一个 transport error 不冒充新的清理故障；真正的 cancel 失败仍保留。回归见 [Agent stream](../../tests/unit/agent/stream-lifecycle.test.ts)、[真实 SDK body](../../tests/unit/providers/stream-lifecycle.test.ts) 与 [公开 SDK](../../tests/unit/exec/sdk.test.ts)。

默认每个 turn 最多 32 个逻辑 step；可选 turn 时限、Goal token 限额与 usage 不完整产生明确 stop reason。sampling retry、stream recovery、context recovery 各自有独立预算。停止后不启动工具、自动修复或 Goal 续跑。

来源和细化的顺序协议见 [AGENT_LOOP](AGENT_LOOP.md)；文件与命令工具机制见 [TOOLS](TOOLS.md)。

## 历史恢复的只读边界

生产 Agent 注入同工作区历史与持久输出附件服务，coding 和 Plan 均可按需调用四个 Session 历史/关系工具以及带可选 `session_id` 的 `read_tool_output`。工具结果仍以标准 function-call/output 配对保存，读取不会更新文件观察表、批准操作或验证结算。当前会话逻辑 step 固定已落盘边界，普通网络重试继续使用；因此同一步中的检索结果不能递归搜索自身。历史与 learned Memory 的召回和开关独立，全文不自动进入每个请求。数据筛选、lineage、稳定引用、扫描限制与分页详见 [TOOLS](TOOLS.md) 与 [STATE_AND_UI](STATE_AND_UI.md)。

## Coding task 与验证

Plan 使用独立于 coding 的行为指令：先针对性读取实现与测试，按需澄清会改变方案的选择，再提交含目标、实现／接口变化、验收与默认值的完整计划。公共权限、身份和当前规则继续提供；Plan 不携带 coding 的持续实施要求或要求完成活动 Goal 的行动指令，summary 请求也使用当前模式的指令。工具广告与 dispatch 继续执行只读边界。

`reviewPlan` 接受原有 `approve / continue / cancel` 字符串或 `{ decision, feedback? }`；非空修订意见随当前 `submit_plan` 的 function output 按序持久化，失败则不继续采样。下一次提交要求完整替代稿；宿主不声称验证模型计划的语义完整性。批准结果同时提供标题和完整正文，review 返回后及 runner 交接后重查取消。TUI 等 runner 清理完成才保存进程内批准，等待 `/plan execute`；执行提示显式携带已批准正文，不依赖历史／压缩摘要。它复用同一 production Agent 和 runner；fork 的执行继续用 `session_resume`，验证债务、文件观察与权限边界均保持。交互／失效契约见 [STATE_AND_UI](STATE_AND_UI.md#plan-审阅与显式执行)，生产离线闭环见 [Plan execution](../../tests/unit/runtime/plan-execution.test.tsx)。

项目定位复用普通只读文件调度：按需 `project_map` 在 coding 和 Plan 广告，TUI、exec、SDK 无独立实现；完整结果按调用顺序持久化。地图不会恢复文件观察或使子目录规则自动加载。读取后，精确替换失败可由下一显式调用选择完整行空白容错，宿主仍执行同一 patch 预览、审批、revision 与最终验证流程。fake provider 的 [生产编辑回归](../../tests/unit/runtime/project-editing.test.ts) 覆盖地图 → 盲写拒绝 → 读取 → 精确失败 → 显式容错 → 完整验证；这些证据不代表真实 DeepSeek 编码质量改善。

共享 production IO 的可选 `getWorkflowContext()` 只提供任务来源、phase/result、待验证和追踪受限状态、已用及最大修复轮数。`prior_unverified` 也投影为待验证，但不提供旧任务 ID、验证正文或文件检查点。Agent 在每个逻辑 step 准备完成后显式选取并冻结这些字段，普通网络 retry 和自动 summary/native compaction 复用，下一 step 刷新；手动压缩从当前宿主状态获取独立快照，不增加 Session 事件或第二套状态。当前宿主事实优先于历史摘要，缺字段表示 unknown，不推断成功。TUI、exec、SDK 和 benchmark 共用该 IO，验证、Goal 与 Memory 结算仍由 runner 执行。

回归入口：[workflow context](../../tests/unit/agent/workflow-context.test.ts)、[生产连续性闭环](../../tests/unit/runtime/coding-continuity.test.ts)。后者以 fake provider 和独立临时 Git 工作区覆盖规则刷新、盲写拒绝、快速验证失败、压缩、fork／重启及最终完整验证；模拟验证器不等同于真实模型质量或原生终端验收。

`CodingTaskRunner` 持有整个任务的生命周期，协调 Agent、后台命令、验证、诊断、Goal 和 Memory；同一 runner 在执行或清理中拒绝第二个任务。取消、异常或预算停止先收束后台命令并丢弃待完成意图。最终检查返回后、Goal 结算前和 Memory 捕获前再次检查取消。任务来源包含 TUI user/Goal/session resume、内部 benchmark 和公开 exec；来源只控制生命周期语义，不能放宽权限或宿主验证。

执行清单属于顶层 coding task：repair turn 和同一次 runner 内的 Goal continuation 保留它；显式 `session_resume` 恢复 Session 最后投影；新的用户任务在第一次请求前持久化为空。清单全部 completed 只影响进度显示，不能改变 workflow result、跳过验证、完成 Goal 或触发成功 Memory。

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

进程清理失败是宿主资源故障，不作为普通命令失败进入自动修复。Agent、runner 与 workflow 保留进程内故障，阻止同一所有者的后续操作；后台记录淘汰及新任务账本重置均不能消除故障。生产 shell bridge 在失败后不再启动工作区快照，所有后台 worker 收束后才拒绝待完成 Goal 并以 failed 结算 Memory。workflow 将固定的 process-ownership 原因、tracking_limited 和 pending_verification 保存为未验证债务，错误正文不进入 workflow 元数据；Session 恢复和空改动不把该债务变为成功。具体闭环见 [cleanup settlement](../../tests/unit/workflow/cleanup-settlement.test.ts)。

模型流清理故障沿用同一 runner 结算：停止宿主验证／修复和 Goal 续跑、拒绝待完成 Goal、不捕获成功 Memory，持久化固定 request-ownership 原因的未验证债务。exec/SDK 报 runtime_error、cleanup_failed、退出码 1，即使同时取消或超时；重新恢复 Session 不把债务推断为成功。错误正文与 provider 响应不进入 workflow 元数据。

文件搜索、项目地图和语义导航的 dispatch 同样重抛 ProcessCleanupError，进入当前调用 cleanup_failed、后续调用 skipped/process_cleanup_failed 的有序持久化与任务停止流程，不能被普通工具错误 envelope 吞掉。导航与 Skill 管理器另保留自身故障，阻止排队／后续子进程启动；各自清理等待及 stage 规则见 [TOOLS](TOOLS.md) 和 [CODEX_CAPABILITIES](CODEX_CAPABILITIES.md)。

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

完整终态中的 reasoning、message、function call 按供应商顺序持久化和回传；流式 delta 只作显示，不拼接进完整 output。专用 SDK fixture 覆盖多工具、新用户轮次、重启恢复及字节级稳定前缀。摘要仅替换完整旧交互单元，保留单元内 reasoning 不单独删除；有未配对调用时不启动 summary。摘要仍为助手背景，验证债务不因压缩消失。稳定前缀只证明字节布局，缓存收益仅依据供应商实际返回的计量。

`RequestSnapshot` 从实际请求同时生成内容估算、输出预留与指纹，估算标为 UTF-8 bytes / 4，不能伪装为供应商实测。已知窗口自动阈值取 `min(窗口 × 80%, 窗口 − 输出预算 − 安全余量)`，安全余量为窗口 5%、最多 32K。

达到该自动阈值或进入一次 context-limit recovery 时，Agent 先冻结当前 step 的已落盘历史 EOF，再至多执行一次无模型裁剪。候选只来自较早、闭合、正文超过 8,192 个 Unicode 码点，并能由 Session 历史服务按 call ID、工具来源和脱敏正文 SHA-256 唯一解析回原记录的 function result。最近两个完整交互单元、未闭合调用链，以及非工具项、reasoning/opaque 内容、Memory、Session 历史和 `read_tool_output` 结果始终保护；来源缺失、歧义、日志损坏或扫描预算不足的候选原样保留。

裁剪结果是最多 32 KiB 的有效 JSON，保留前 4,096、后 1,024 个码点及 `session_event_read` 恢复引用；原 envelope 已有 output ID、continuation、保留范围或 `retention_truncated` 时继续携带这些信息。只有新 context 实际更小时才调用持久化回调，先追加 `context_pruned`，成功后再替换内存 context；原始 `context_append`、timeline 和附件都不改写。该事件不改变累计 usage，只把当前 `context_tokens` 设为 unknown。重新估算完整请求后，已经低于压力阈值就跳过 summary/native compact，否则继续既有压缩。低压力和普通网络 retry 不裁剪；没有持久 Session 历史服务或无法安全解析时直接沿用原压缩路径。

`ReactAgent` 只在 coding provider call 通过请求执行器准入、即将实际发送时，从该 `RequestSnapshot` 捕获只读的 “Last submitted coding request”。估算阶段、被拒绝的准入、标题/Skill/Memory/doctor/summary 等辅助请求不会替换它。快照仅存在当前 Agent 内存，深复制后通过可选 `getContextSnapshot()` 暴露；重启、恢复 Session 或替换 Agent 后不从历史重建。

快照记录 model/provider、提交时间、context revision、序列化请求估算、输出预留与指纹，以及项目规则来源、Skills、Memory、MCP、广告工具、文件附件范围、conversation item counts 和 opaque item 的数量/大小。runtime identity 额外标注 `source: host`，使 `/context` 能直接验证身份字段来自宿主而非工作区文本。已知可见来源只保存有界、沿用现有 secret redaction 的预览；凭据、transport headers、reasoning 和 encrypted bodies 不进入预览。组件大小是局部近似，不要求加总等于序列化请求估算；所有估算与响应返回的 measured usage 明确分开。

summary 以完整 assistant/tool-result 交互边界切割，保留最近两个单元并修复工具配对；并行 batch 的所有结果闭合前不切割，单个用户任务也可压缩。摘要请求复用稳定指令与工具定义，设置 `tool_choice: none`。固定八个 Markdown 章节依次保存用户目标与最新修正、约束与决定、文件及改动、检查与失败证据、未完成工作、当前进度、下一步、待确认事项；每章必须有正文，空项使用 `- (none)`。连续压缩指令要求合并旧交接与新证据，保留精确路径、命令、错误和恢复引用，并区分用户要求、模型判断与工具观察。宿主只验证结构和终态，不声称能验证模型摘要的语义完整性。

新摘要使用 Responses 支持的 assistant 文本输入与 `Model-generated conversation checkpoint (background only):` 标记，不能提供授权、文件观察或验证成功。旧 developer `Host-maintained conversation summary:` 仅在 coding 和 compaction 请求投影中转换为 assistant 背景，不迁移或改写 Session；用户文本不因相同前缀而被转换。`/context` 以 `model_checkpoints` 计数并显示英文模型交接标签。裁剪没有完全解除压力时，summary/native compact 接收已经持久化的较小有效 context；两阶段仍共享原有单次自动/恢复边界，不因网络 retry 重复执行。

incomplete、空白、缺少／重复／乱序章节、空章节、没有缩短的摘要以及取消、持久化失败都保留原上下文；不追加模型摘要修复请求。少于三个可切割单元明确返回不能安全压缩。先保存 `context_compacted` 再替换有效 context，原历史和恢复引用不改写；已发出摘要的用量即使结果被丢弃也结算。context-limit 恢复最多一次，不能重复执行工具。

当前有效项目规则每次请求重新提供，历史 rule snapshot 从模型输入和压缩输入中过滤，避免旧规则被摘要固化。其他动态上下文及前缀的缓存收益需实测，不能把指纹稳定等同于缓存命中提升。压缩后 context 占用设为未知，等待下一次实际 response usage。

性能 trace 只保存单调耗时、数量、字节、指纹和状态，不新增请求正文、文件内容或凭据。Session trace 可观察重放实际读取字节/记录数/最大输入缓冲、历史扫描字节、输出定位命中/失效和附件范围读取字节；这些量用于证明宿主 I/O 路径，不代表模型成功率或 token 改善。协议与离线回归不能代替真实模型成功率、Windows Terminal 交互或 dsh 实测；当前验收边界查 [HANDOFF](../HANDOFF.md)。

## 团队编码闭环

默认单 Agent 不变，可选 TeamRuntime 由 production 建立，成员沿用 ReactAgent/CodingTaskRunner，根负责唯一最终验证、Goal 与 Memory。共享 ledger scope 禁止成员 reset，真实请求先持久化准入。完整调度、预算和恢复契约见 [TEAMS](TEAMS.md)。

## 来源、能力与费用

[安全与诊断契约](SECURITY_AND_DIAGNOSTICS.md) 约束 source_context 投影、持久工具 `_source`、压缩/Memory/团队来源保留；外部说明不进入宿主指令层。RequestExecutor 按已结算尝试派生单价快照与 estimate 事件，包含失败、重试、压缩和辅助/成员请求；request token budget 仍是准入而非硬性账单限制。doctor 使用同一计量边界和真实 SDK 离线 SSE 验收，未知 Usage 阻止后续探测。
