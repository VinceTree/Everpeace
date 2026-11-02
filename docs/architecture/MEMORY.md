# Learned Memory

项目条目在创建/人工复核后 90 天到期并暂停召回，自动合并和使用不续期；长期用户偏好不自动到期。`/memory list/inspect/renew/correct/disable/delete` 使用 revision-bound 人工操作；实际请求前重新检查有效性。来源集合、superseded 关系和回归见 [Memory 生命周期](VALIDATION_PRIVACY_PERFORMANCE.md)。

Everpeace 的 learned memory 是本地、分层、可审计的经验存储。它不替代当前 Session context、`AGENTS.md`、仓库证据或用户当前指令，也不使用向量数据库。设计参考 Codex 的“提取与整理分离”原则，但使用 Markdown、JSON 任务文件和普通 Responses 请求适配当前单 Agent 与兼容端点。

## 数据与作用域

- `learned.md` 保存用户级长期偏好；`projects/<workspace-hash>/learned.md` 保存项目经验。
- `capture-jobs.json` 保存待处理、运行中和失败任务；`memory-candidates.json` 保存 pending、review、consolidated 和 rejected 状态。
- `memory-control.json` 保存全局开关撤销 epoch、全局用户 scope epoch 和各项目 scope epoch；job、候选和手动请求绑定开始时的 epoch。缺少 epoch 的旧任务仅在对应 scope 从未撤销时兼容，不能重新授予旧任务权限。控制文件损坏直接报错。
- 项目路径规范化后做 SHA-256 哈希，不把原始路径写入文件名。所有内容读写先取 store 级 `proper-lockfile` 控制锁，再取需要的文件锁，固定为“控制锁 → 文件锁”；provider 请求不持锁。提交时重查 epoch、策略和 job 租约所有权，阻止其他实例或进程的旧结果回填。
- 清空、关闭和人工变更通过控制层撤销旧写入资格。`memory-transaction.json` 的原子替换是清理或多文件审查提交点，先持久化新 epoch 和写入意图，再完成内容操作；中断后所有读取和新写入先恢复该事务。事务文件含脱敏内容，使用与 Memory 相同的本地文件权限。
- 同一 store 的 capture job 读取与写入共用每路径队列；读取等待已开始的原子替换和锁释放，避免 Windows 上高频状态读取与替换竞争。外部进程仍由原子替换、跨进程锁和有界重试保护，持续存储失败保持可见。边界回归见 [capture recovery](../../tests/unit/memory/capture-recovery.test.ts)。
- 成功重启回归使用明确完成状态和可靠 Usage，等待串行 job 队列结算后再读取长期条目，避免测试高频读取写入目标；失败保留合成 fixture 的 job/capture 状态。未知 Usage 的恢复和禁止重试仍由独立用例验收，不以成功 fixture 代替。
- 新增、续期和纠正统一限制每 scope 最多 100 条 active，超限先归档过期条目，再归档最旧 active，让新条目保留。superseded、archived、候选与 review 状态不挤占 active 配额；未合并临时候选保留 30 天。自动去重保留稳定 ID 和原到期时间。
- 旧 Markdown 条目继续读取为 legacy 来源，不补造验证证据，也不默认回扫旧 Session。

长期条目包含稳定 ID、scope、kind、confidence、status、完整创建/更新时间、适用条件、来源 Session 和最多三个脱敏证据片段。归档条目不会被相同自动提取重新激活。

## 读取与召回

每个逻辑 Agent step 在请求准备阶段生成一个 `MemorySnapshot`：

```text
revision + loadedAt + entryIds + injected text
```

检索词来自当前用户问题和本轮已实际访问的文件，支持中文双字片段、英文词、路径和标识符。只选择 active 条目，并以完整条目为单位装入字符预算；装不下的条目整体跳过，不截断半条规则。普通网络重试复用当前快照，工具 follow-up 或 guidance 进入下一 step 时重新检索。

主 prompt 注入的是带 ID 的短索引，并明确标记为不可信背景。`memory_lookup` 是受 scope 和读取策略限制的只读工具，可按 ID 返回脱敏详情及证据；Plan 模式允许读取。当前聊天关闭 `readExisting` 后，下一 step 不再广告该工具，dispatch 也会拒绝读取。`/memory view` 展示最近一次实际发送的 snapshot，而不是重新读取磁盘形成一个不同视图。

全局开关同时控制 learned Memory 的读取和自动学习；聊天级策略也仅影响 learned Memory。`session_search`、`session_event_search`、`session_event_read`、`session_relations` 和同工作区 `read_tool_output` 属于独立的只读历史能力，关闭 Memory 不会关闭它们；历史记录也不会因此自动成为长期经验。聊天级 `readExisting` / `captureFuture` 通过 `memory_policy_updated` Session 事件保存；`/new` 使用默认策略，`/resume` 恢复原 Session 策略，旧 Session 使用默认值。Session 分支继承该策略；公开 exec 固定读取已有 Memory、关闭本次 capture，不在任务清理后产生提取请求。

## 后台生命周期

前台通过共享 runtime 调用：

- `beginTask` / `endTask`：由生产 Agent 接到现有 coding runner 的完整任务范围；同步关闭后台准入并取消请求，覆盖 Plan 审批、宿主验证、修复和 Goal 续跑，最终退出时才恢复五分钟空闲期。
- `beginTurn` / `endTurn`：单轮持有前台状态；没有待学习材料时也能结束该轮，整项任务仍活动时不能解除任务的暂停。
- `finishTurn`：在 workflow 验证完成后提交结构化 outcome，仅 verified 任务可以自动排队。failed、unverified、cancelled、stopped 即使含 always、remember 或“记住”也不得准入；恢复旧队列应用相同规则。长期偏好通过独立 `/remember`（兼容 `/memory remember`）保存。
- `setPolicy`、`clear`、`archive`、`deleteEntry`：提升 runtime generation，取消或隔离旧工作；迟到结果在写入前必须再次通过 generation 与策略检查。
- `dispose`：停止当前 runtime，但保留持久队列供下一实例或进程恢复。

显式 `remember` 等待启动完成，并在 provider 准入、响应后、持锁写入提交前及返回成功前复核全局开关、取消信号与 generation。全局关闭时必须先启用；聊天级 `captureFuture: false` 只暂停自动学习，仍允许新的显式偏好请求。清空、关闭、归档、删除、恢复前台或关闭聊天 capture 会取消已在运行的手动请求，迟到响应保留可靠 usage，但不能写回或报告成功。取消发生在原子提交之后时保留已提交条目，不尝试回滚并发修改。

runtime 登记手动请求和异步变更的所有权后才执行 callback；重复及取消 callback 重入的 `dispose` 共用同一完成 Promise，等待请求、计量和存储结束。启动、手动操作设置读取、手动写入或异步变更的存储失败关闭该所有者的后续准入；资源清理失败也关闭所有者，关闭仍返回原故障，资源清理错误优先于存储错误与普通取消。生产 TUI 为手动偏好创建关闭自动 capture 的临时 runtime，避免它消费共享后台队列；TUI 服务关闭也等待 provider 返回后的 Memory 持久化。回归见 [手动生命周期](../../tests/unit/memory/manual-lifecycle.test.ts)、[生产 TUI 服务](../../tests/unit/tui/dependencies.test.ts) 和 [实际 SDK 离线 fixture](../../tests/fixtures/tui-memory-lifecycle.ts)。

预览过期、条目不存在、无效纠正和撤销后的旧提交属于可恢复业务错误，不设置永久 persistence failure；重新预览或开始下一任务仍可用。真实存储与资源清理故障继续关闭该所有者的后续准入。

生产默认等待五分钟真实空闲。任务最终结束后，所有可靠 queued job 重新计时；失败、取消、受限停止、no_changes 和 Plan 退出不增加未验证学习，但仍恢复旧队列。runtime 重建时也重新计时，进程关闭期间不算当前实例的空闲；unknown/pending job 仍按持久恢复规则失败，前台暂停不能隐藏该用量缺口。timer、处理循环、异步认领和请求提交复核前台状态，旧请求结算后的重排不能在前台任务中重新启动。回归见 [生产空闲生命周期](../../tests/unit/runtime/memory-idle-lifecycle.test.ts)，使用实际 factory、runner、隔离 Git 项目和受控时钟，不替代付费效果或真实终端验收。后台并发为 1，一次空闲最多处理 5 个任务。每个请求 60 秒超时，失败最多重试 2 次；running 任务持有一小时租约，只有已可靠结算的任务在租约过期后可重新排队。任务 ID 根据 Session、工作区和脱敏后的轮次材料计算，重复提交保持幂等。连续轮次分别进入队列，不再由单个 timer 覆盖。

上述重试只适用于可重试且可计量的普通失败。Memory runtime 为当前 job 的提取/合并复用 RequestExecutor 和同一账本，生产 TUI 使用相同 scope 汇总辅助用量；用量缺失后，合并准入抛出 RequestUsageIncompleteError。任何失败路径若账本已有缺口，该 job 直接保存为 failed，不以重新排队或重建 controller 获得新准入；网络失败、不完整及空白响应同样适用。可靠响应 usage 在正文与终态校验之前保存，普通失败的重试仍保留。ResourceCleanupError 同样使 job 失败，并停止当前批次及故障辅助所有者的后续请求。另一个已验证轮次是独立 job，可以开始新账本，累计辅助 usage 仍保留旧缺口。服务关闭取消并等待正在进行的请求。回归见 [Memory jobs](../../tests/unit/memory/learned-memory.test.ts)、[辅助账本](../../tests/unit/agent/auxiliary-request-executor.test.ts)。

生产 factory 和 TUI 手动 Memory 将 runtime 的同一 RequestAccountingScope 交给辅助执行器，由它在取消/所有者准入通过后使用该 executor 调用实际 provider，不再包围第二个 attempt。Memory 显示与辅助总量分别观察已结算账本，不重复结算。可靠响应随后取消仍是已知用量；准入前取消、关闭或旧资源故障没有新 provider attempt，不能制造 unknown 或重复累计旧错误中的 usage。真实发出的未知请求仍保持缺口，同一 scope 换 signal 不恢复准入；新独立操作不清除累计 unknown。外部 host runner 必须使用传入 scope 的 executor，不能把 provider wrapper 本身当成已开始请求。回归见 [生产准入与计量](../../tests/unit/runtime/memory-request-ownership.test.ts) 和 [实际 SDK 离线解析](../../tests/fixtures/memory-accounting-offline.ts)。

`capture-jobs.json` 使用可选的 `requestPending` / `usageComplete` 保存每个 job 的请求结算状态，新 queued job 为 false / true。每次提取或合并先在持有的 running 租约下原子保存 pending，再准入 provider；认领后及 pending 写入后都重查实时 generation、策略、开关与取消，不能在异步认领期间暂停 capture 后仍发请求。账本结算、累计可靠用量之后保存 false / 完整性，最后才处理响应或启动下一请求。写入失败直接停止该 job 的自动重试，不把尚未发出的请求伪造成未知消耗；失败状态能够落盘时，同时保存已经确定的结算状态。持续存储失败仍向 UI 报告 failed，保留原持久标记，不能误报 running 或成功。清理错误优先于同时发生的存储错误。

重建时，过期 running job 必须明确为 false / true 才能恢复；旧 running job 缺少标记、pending 或用量未知时保存为 failed。queued job 已有 pending / unknown 标记，或有重试、错误、extracted 证据但缺少可靠结算标记，也不得重新准入；错误类型的标记不能冒充 boolean。失败用量缺口随任务保留并使恢复实例的 Memory 显示 unknown。旧的未开始 queued job 仍兼容，已保存 extracted 的可靠任务不重复提取。未过期租约保持原所有者；提取结果、请求结算、失败更新和任务移除均匹配原 running 租约，不覆盖接管后的任务。恢复的是准入完整性，不是历史 token 总数。回归见 [恢复与存储边界](../../tests/unit/memory/capture-recovery.test.ts) 和 [真实中断 fixture](../../tests/fixtures/memory-capture-crash.ts)：分别在提取、合并过程中终止进程，保持请求标记并模拟租约到期，断言不自动重发。

## 两阶段写入

第一阶段从一个已验证轮次提取最多三条候选，记录 scope、lesson、适用条件、置信度、来源和证据。输入只包含明确用户信息、助手结果摘要与本地可追溯 transcript；网页、MCP 文本和助手自称成功不能单独作为验证依据。

第二阶段先做确定性去重和冲突检查。与 active 条目或同批候选在相同适用条件下冲突的内容进入 review，不注入 prompt。只有同批存在多条非冲突候选时才额外调用普通模型提出合并结果；模型没有工具或文件写权限，程序重新解析、脱敏、限制数量。最终在控制锁内对规范化后的合并结果、当前长期条目和同批内容再次使用相同确定性判据检查；合并引入或并发新增的冲突也进入 review，不增加付费语义判断。候选结算与长期条目一起提交，提交前复核 generation、信号、策略、epoch 与租约。模型失败时保留原有长期记忆和持久任务状态。

所有输入先脱敏再裁剪，模型输出在保存前再次脱敏。凭据匹配规则通过 [redact-secrets](../../src/util/redact-secrets.ts) 与历史/附件共享，覆盖 JSON/配置形式的 key、token、password、Bearer、常见 token 前缀，以及完整或被截断的 PEM。Memory 保留原有空白清理、标签清理和字段裁剪；历史/附件使用保留换行、缩进与 CRLF 的脱敏函数，再按 UTF-8 字节分页。Memory 请求 usage 单独累计；provider 未返回 usage 时显示 unknown，不计入前台 context 占用、Session 主 usage 或 Goal 预算。

Memory 使用共享脱敏器完整的引号、转义和 JSON 处理后再清理空白、标签并裁剪，验证裁剪后的结果稳定后才返回；有界规范化无法稳定时整字段遮罩。入队、提取/合并结果、保存和读取均经过该边界；提取输出仅保留声明字段与合法类型，不保存模型额外属性。旧格式字段含脱敏占位符时不能证明秘密已完整清除，lesson、applyWhen、evidence 整字段遮罩，并暂停召回、标记 redactionReview；人工纠正后才可恢复，续期不足以解除。旧受污染 job 不继续提取；旧受污染候选只能纠正后接纳或拒绝。实施和回归只使用隔离合成目录，不读取或批量重写真实用户存储。

## 候选审查

共享 store 提供列表、详情、预览与提交。`LearnedMemoryStatus.candidateNeedsReview` 单独计数，`needsReview` 同时包含条目和候选；项目候选限定当前工作区，用户候选全局可见。

CLI 使用 `everpeace memory candidates list`、`inspect <id> [JSON correction]`、`accept|reject <id> <revision>` 和 `correct <id> <revision> <JSON correction>`。纠正先用相同 JSON 预览，revision 绑定候选、纠正内容、epoch 和全部受影响条目的 revision；任一变化均要求重新预览。

TUI 菜单和 `/memory candidates list|inspect|accept|correct|reject` 提供对应操作，修改沿用默认 Cancel 的确认窗口，不请求模型。人工接纳冲突候选时展示受影响规则；确认后原子保存新条目、旧规则的 superseded 状态和候选结算，保留来源、`supersedes` 及可选 `supersedesIds`。拒绝持久保存，job 重试和重启不能重新激活同一候选。回归见 [八项缺陷与跨进程恢复](../../tests/unit/memory/hardening.test.ts)、[CLI](../../tests/unit/cli/memory-review.test.ts) 和 [TUI](../../tests/unit/tui/app.test.tsx)。

## 安全与兼容边界

- 自动学习不读取历史 Session，不跨项目提升项目事实，也不允许模型直接写 Memory 文件。
- 用户 scope 只接受明确要求长期记住的偏好；其他候选降为 project scope。
- 清空 user 影响所有工作区，清空 project 仅影响当前项目。混合 job 仅撤销对应 scope，其他有效材料继续；pending/unknown 用量证据保留。删除、禁用、纠正和 CLI 直接操作也经过同一控制层，撤销旧写入资格。
- 文件格式继续兼容旧条目；新增 Session 事件为可选事件，旧 JSONL 不迁移。
- 当前实现不包含向量检索、多 Agent、远程 Memory 服务、通用 hooks 或历史回填。
