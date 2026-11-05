# Memory 事实保留优化

本专题落实用户批准的 `memory-fact-preservation` 策略。目标是普通对话事实、可回读原文与已验证经验分层，详细依据见 [差距分析](MEMORY_GAP_ANALYSIS.md)。

用户已改为停止全量批次，先修复再小样本验证。生产已接入独立候选保留、严格解析、普通完成对话事实捕获、独立事实存储和带原文摘录的 snapshot；memory_lookup 返回事实来源及现有历史工具可用的查询。工程与 live 实际结果以 HANDOFF 为准，质量收益尚不能外推。

原 015 的取消导致进程退出但未完成 runner 最终收尾，两个请求保留 pending。原结果和未知用量封存，不能称为全部请求已结算，也不能自动恢复。新候选使用全新独立账本，旧缺口保持在旧报告中。

## 可执行入口

依赖本机 Python 3.10+、现有 Node/tsx，无新增依赖，无凭据读取。以下命令均在仓库根目录执行：

```powershell
python scripts/benchmark/prepare-memory-facts.py prepare --campaign <冻结批次目录> --snapshot <已有分析快照目录> --output <新准备目录>
python scripts/benchmark/prepare-memory-facts.py verify --root <准备目录>
python tests/unit/benchmark/memory_fact_preparation_test.py
```

English: `prepare` creates an offline experiment package from a frozen campaign and analysis snapshot. `verify` checks its file hashes, split isolation and plan membership. Both commands make zero model requests. Use a new output directory outside the original evidence directories; existing outputs are never overwritten.

`prepare` 使用 Node 核验上游 `JSON.stringify` 对象摘要，另记录文件字节 SHA；预检中的实际 source/build 身份必须仍与当前 checkout 一致。输出 `receipt.json` 冻结所有生成 JSON 的字节摘要。读取历史只投影日期、角色、来源和正文；问题与标准答案不会进入 `build-inputs.json`。grader 目录单独存答案，这是数据流隔离，不宣称操作系统 ACL 隔离。

## 数据与候选清单

- 按历史全文 hash 将题目组成 cluster；所有已审计题及同 cluster 题只能进入开发集。种子 16716 对 cluster 排序，整组分配；不会拆分重复或跨类别的同一历史。
- 开发集六类各 10 题；保留集六类各 20 题。已审计题必须保留，若因此超出目标则披露；无法凑满则披露缺额。剩余题列为 unused。
- A 为旧行为，B 为保留独立候选，C 为事实层，D 为事实与原文融合，E 为原 BM25。每题一轮，组别起始顺序轮换。
- 开发集生成五臂计划；保留集只有 `A / SELECTED / E` 模板，必须在开发阶段完成、选出一个候选并冻结后才能成为执行清单。准备工具没有 live 或自动选优入口。
- 保留集的含义是划分时未逐题审计。它来自公开基准，不能宣称外部独立测试集；后续若查看或调优保留集，必须记录其失效，不能继续作为未审阅集合使用。
- 原始模型、端点、profile、数据与评分器 revision 写入候选清单；新预算标记 `UNSET`，不从旧批次复制 null。事实提取提示及输出预算须在生产候选实现后另行冻结。

24 个合成任务分为细节、更新、跨 Session、证据不足各六项；包括中英文猫名、助手啤酒推荐、木乃伊数量、历史路径、否定条件、相对时间、导入时间、未来生效更新、未验证助手声明和提示注入。期望答案与来源事件 ID 留在 grader，旧／新 harness 两臂共 48 个计划项。两臂使用相同历史工具名单、最多六次调用及 8000 字符累计检索正文预算。仅创建任务，不把 fixture 合法性检查当作模型通过。

## 离线重放的证据范围

从此前快照的内容寻址副本读取请求，逐文件验证 hash；当前运行中的账本不参与重放。输出明确区分合法空结果、非空、非法 JSON、结构错误、截断及无效终态。

重放 B 的规则只去除内容字段完全相同的候选，合并全部来源记录，保留独立候选；相同 scope／适用条件下不同 lesson 标记 review。这是生产接入前的策略规格，不模拟实际 store 的容量、跨轮冲突、租约提交或最终回答。

真实啤酒案例 `16c90bf4`／重复 2／历史 41 的提取和合并请求分别链接到原始收据。检查保留策略中 pilsner/lager 是否仍在，以及原合并输出是否保留。该检查证明已有候选可以被无损保留，不能证明 Luna 等原本未提取的事实已解决，也不能证明问答质量提高。

## 结算后的实现顺序

1. 将确定性保留与严格解析接入生产共享提取／整理路径；保留冲突 review、verified、epoch、租约、取消及 unknown 约束。离线规则测试迁移到共享实现，避免长期维护两套逻辑。
2. 新增项目范围事实存储与消息级来源定位，分开消息／事件／导入时间。普通完成对话只提取事实，已验证任务允许同次请求提取事实与经验；失败、取消和停止任务不自动提炼。
3. 接入读取、关闭、清空和恢复；新事实不占经验的 100 条配额。旧记录兼容、无自动历史回填，全局偏好仍要求显式意图。
4. 接入事实／原文检索和 `memory_lookup` 事实 ID，复用现有 Session 读取工具；总正文预算保持 8000 字符。事实来源不足或状态冲突不能由摘要冒充验证。
5. 补齐脱敏、隔离、长输入、存储、取消、迟到响应、unknown 恢复及未验证任务回归，串行执行 typecheck → lint → test → build，首败停止。冻结候选、提示、评分器和新预算后才能执行新 live 实验。

工程选择门槛沿用用户计划：保留集计划分母正确率比 BM25 高至少 5 个百分点，更新与 abstention 错误数不增加，构建已知 token 不超过旧 Memory；回答成本超过 BM25 的 1.5 倍时不默认启用。全部失败保留，缺失计量不能通过成本门槛。小样本只作描述，旧批次不补正式区间。

当前产物路径、真实重放结果、验证数量和剩余工作以 [HANDOFF](../HANDOFF.md) 为准。

## 12 题受限 pilot

新增 `pnpm benchmark:memory-pilot prepare <新绝对目录> <已有准备目录> <原基线目录>`，随后 `pnpm benchmark:memory-pilot run <绝对目录> --live`。prepare 必须在四门禁后执行；它冻结当前源码、构建、提取提示、reader 与评分器和题目 ID。run 核验这些身份，不提供恢复或自动重跑入口。

从开发集六类各两题选择 12 题，优先保留 Luna、啤酒和木乃伊三个锚点。新事实 Memory／原 BM25 各一次，共 24 回答项；前置六项合成 smoke 的全部请求亦计入 200 万 input+output 总上限。每个请求按 UTF-8 输入字节、最大输出与协议余量预留，并发不超过二；未知用量、存储故障或 smoke 错误关闭后续请求。预算到达后剩余项 skipped。旧基线、120 题保留集及全量任务均不运行。

此轮只测共享生产事实提取、存储与 snapshot，不等同完整工具 reader 对照。生产详情提供原文恢复定位；公开 reader 不开放历史工具。报告分别保留样本结果、共同成功配对、分阶段 token 及全部失败，小样本不出正式区间、不自动晋升候选。

## 引文错误隔离

首轮小样本发现，模型有时省略 Markdown 标记或用省略号拼接引文。后续离线候选只调整错误隔离：逐条拒绝无实际引用的事实，保留其余合法事实，并记录 rejectedFacts。非法 JSON、整体结构错误和截断仍不等同合法空结果。该候选仅通过收据重放进行初步核验，不能把原模型结果重新标成成功。

已有模型批次的独立报告使用 `python scripts/benchmark/report-memory-fact-pilot.py --campaign <已结束批次> --output <新分析目录>`；English: read-only analysis with no model calls. 引文重放使用 `node --import tsx scripts/benchmark/replay-fact-quotes.mjs <已结束批次> <新重放目录>`，只读取捕获前缀，不补发任何请求。

## 来源链离线核验

`node --import tsx scripts/benchmark/prove-memory-sources.mjs <新证据目录>` 使用真实 Session／Memory 存储及固定提取响应，验证事实到原文的定位。English: real local storage with fixed model responses; zero external model requests and no credential access. A new evidence directory is required; existing outputs are never overwritten.

命令读取当前已结束的 pilot-001 清单，生成 evidence.json、中文 report.md、实际历史读取记录 history-reads.json 和 next-plan.json。来源核验分别记录精确绑定、精确回读、搜索回退、来源不可用及回读不一致。下一轮清单仍为六项 smoke 与 12 题两组，tokenBudget 为 UNAUTHORIZED，executableCampaign=false；该清单不能交给 live runner 执行，必须在新预算授权后另行建立独立 campaign。

固定响应验收验证了宿主机制，不是模型 QA 正确率。保持原来的提取提示和召回排序；组件 reader 仍无工具，因此来源链能力需与组件问答成绩分开报告。当前候选身份、门禁与实际产物见 HANDOFF。

### DS Harness 机制参照

参考固定 revision `639ed015397290b3745d163aafe02ffee4aa3f84` 的 [session-query 设计](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-query/README.md)。这是实现机制对照，没有运行 DS Harness 问答，也没有质量排名。

| 机制 | DS Harness 参考 | 本次实现与边界 |
| --- | --- | --- |
| 事件精确读取 | readEvent 与来源关系查询 | 复用已有 session_event_read 引用，新事实绑定真实来源 |
| 统一历史投影 | 一致 observation 与日志投影 | 事实、摘要校验和历史分页共用同一消息正文投影 |
| 权限归属 | 查询服务由调用方约束授权 | 沿用模型工具的项目和敏感权限；宿主捕获不推进工具 EOF |
| 排序检索 | 可挂载全文后端 | 本轮保持现有召回排序；未采用该后端或开展排序对照 |

当前已知限制：只对启用后实际捕获的新消息绑定精确来源；无来源旧记录保留搜索回退。当前 no-tool 公开组件 reader 不使用新来源工具能力，不能用其成绩衡量完整来源恢复闭环。实际离线结果、源码身份和四门禁仅在 HANDOFF 维护。

## 新小样本的效果分析

### 只接续 skipped

用户可明确授权 `pnpm benchmark:memory-pilot prepare-skipped <新绝对目录> <已结束父批次目录>`，再对新目录执行 `run <绝对目录> --live`。入口只选择父报告的 skipped；completed／failed 和通过的 smoke 带来源保留，不创建新请求。父请求必须全部关闭；已关闭且绑定 failed 样本的 unknown 继续披露，不允许未决请求续跑。每个子批次保持 200 万 input+output 上限，新账本只统计本批，parentKnownTokens／parentUnknown 单列，cumulativeKnownTokens 不重复加总。

English: `prepare-skipped` freezes parent inputs, terminal rows and closed request ledgers into a new pilot. Only skipped items are scheduled. Completed answers, failures and passed smoke cases are inherited without model calls; unresolved requests are refused. Parent unknown usage stays unknown, and the result retains both source identities. A new failure or unknown in the child still stops admission. Nested continuation is not automatic.

新源码仅修改接续调度时也须在启动前通过四门禁。公开 24 项汇总会混合父子来源，不能将父记录的成本当成本批请求成本，也不能以进程正常退出声称所有实验完成。

用户已进一步授权新一轮 smoke 与 12 题对照。候选保持来源链最终身份；本轮因网络错误伴随未知用量触发冻结停止，不能称为全 12 题已测完。实际成绩、完整状态与成本仅见 HANDOFF。当前证据支持引文错误隔离改善建库，并出现了“目标事实已存未召回”的案例；生产来源工具收益仍未由无工具 reader 测量。

只读比较入口：`python scripts/benchmark/compare-memory-fact-pilots.py --before <旧已结束批次> --after <新已结束批次> --output <新比较目录>`。English: compare two sealed 12-question pilots with identical membership; preserve planned denominators, failed/skipped rows, matched costs and source hashes. No model calls; existing outputs are never overwritten. 数字须与逐请求账本一致，不能把旧建库失败当作与正常回答同条件的质量差异。

后续可以固定现有事实，对词项边界、IDF／BM25 排序和来源上下文做离线消融；这是待验证方向，不是本轮已取得的增益。未知用量保持原记录，继续模型实验需要独立授权与新证据目录。

## 只复用事实的排序回放

`node --import tsx scripts/benchmark/replay-memory-recall.mjs <已结束父批次> <已结束子批次> <锚点审计JSON> <新回放目录>` 调用共享生产 snapshot 和 BM25 排序，只读取已落盘事实。完整历史库参与覆盖比较，部分历史库单列；输入与原结果核对摘要，已有回放目录拒绝覆盖。

English: offline retrieval replay using the production snapshot and frozen fact stores; zero model calls and zero extraction. Labels are loaded after retrieval and never become ranking inputs. Keep the 8,000-character body budget, retain source hashes and incomplete-store flags, and report both recovered anchors and source-coverage losses.

只验证关键事实 ID、引文是否进入上下文和正文预算；不会生成新答案或重新评分。旧 paid 问答继续属于旧排序，不能将其分数归给新排序。Luna／啤酒锚点用于回归，木乃伊／奶精为已审阅开发案例；该回放不使用保留集，也不满足保留集的正式质量门槛。当前候选与证据入口见 HANDOFF。

## 冻结事实库的词项／聚合消融

新增独立入口，不调用提取器、不构建新事实库：

```powershell
pnpm benchmark:memory-recall prepare <新绝对目录> <已结束父批次> <已结束子批次> <必要证据审计JSON>
pnpm benchmark:memory-recall preflight <目录>
pnpm benchmark:memory-recall run <目录> --live
pnpm benchmark:memory-recall report <目录>
```

English: compare `current`, conservative plural normalization (`terms`), and source-discounted greedy selection (`aggregate`) on frozen complete fact stores. Prepare and preflight are offline and do not access credentials. Reports create new append-only snapshot directories. Existing output roots, changed inputs or candidate identities are refused; started runs cannot automatically resume.

审计 JSON 为逐题数组，每项包含 questionId、necessary 事实 ID 数组、可选 anchor 和 rationale。审计表与参考答案在所有上下文生成后才读取；排序只获得当前问题及已授权事实，不能使用 gold 来源。覆盖固定完整库，部分库独立披露，不从保留集补题。候选选择要求四锚点可见、baseline 已确认必要证据逐条不减少，且至少新增一条必要证据；两者合格时先选增益较多者，同分选 terms。均不合格时 selected=null、计划为空、executableCampaign=false，run 在读取凭据前拒绝。

固定六项合成 smoke 双臂验证姓名、推荐、数量、更新、跨会话与证据不足，事实直接来自 fixture 的带角色原消息，不用答案生成证据。通过后对相同完整事实库运行 current 与选中候选各一次；固定种子 16716 生成交错顺序，最大并发二。reader 沿用 high／32768，judge 沿用 none／16；显式 --live 且本轮用户授权后才读取 keyring。新总预算固定 500000 input+output，所有 smoke、回答与评分共用；输入 UTF-8 字节、最大输出及协议余量先预留。未知用量、服务、身份、存储故障停止新准入，等待在途结算，用户取消同时取消在途；不自动重试。

逐条报告必要证据、引文锚点、来源得失、重复字符和正文长度。正式问答报告固定计划分母、失败／跳过、两组配对成本、阶段计量及延迟；历史建库成本／unknown 单列，不叠加为本批请求。采用要求完整计量、正确数严格增加、原正确题无回退、更新与证据不足无退化，且配对回答 token 比不超过 1.5。小样本不计算正式区间，也不自动满足保留集门槛。工程候选与实际结果见 HANDOFF。

### 聚合丢失的显式修复验收

用户后续要求优先解决木乃伊数量、最低售价丢失，离线通过后直接使用 50 万 tokens 做预测。新增 `prepare-protected`，参数与 prepare 相同，但清单冻结 selectionPolicy=preservation-repair；原 prepare 仍使用 evidence-gain，不改写旧清单或把修复称为新增证据收益。

修复路径只允许 protected：每题 current ID 和顺序均为候选前缀、8000 字符正文内、必要证据逐条无损失、四个锚点保留，并且旧 aggregate 至少存在一条审计丢失且全部找回。报告保留 gain/lost、repairRequired/repaired、baselinePreserved 和实际策略。关联事实只从已授权语料构建局部稀有词图，在剩余预算里完整添加；不使用答案、gold Session、人工关键词或模型提取。原始引文和角色／时间归属保留。

通过修复验收后的 preflight/run/report 沿用原入口及独立新目录。本轮用户已明确授权新 500000 input+output 总预算，smoke、回答、评分全部计入，不再重复询问。真实问答仍比较 current 与 protected 的相同十一题，各一次；六项固定事实 smoke 双臂前置，最大并发二，未知用量与服务故障停止新准入，不自动重试。未达到原 evidence-gain 的事实须持续披露。生产默认采用继续由 QA 完整性、正确数提高、零原正确题回退与回答成本比不超过 1.5 决定。


### 本地语义补充与必要证据门禁

```powershell
pnpm benchmark:memory-recall prepare-model <新模型绝对目录>
pnpm benchmark:memory-recall prepare-semantic <新实验绝对目录> <已结束父批次> <已结束子批次> <语义审计JSON> <模型绝对目录>
pnpm benchmark:memory-recall preflight <实验目录>
pnpm benchmark:memory-recall run <实验目录> --live
pnpm benchmark:memory-recall report <实验目录>
```

English: explicitly prepare pinned local E5 ONNX assets, then compare baseline-preserving semantic supplements at fixed 0.75 and 0.80 cosine thresholds. Encoding runs on the local CPU without remote model loading. The ordinary Memory default stays current. Windows requires compatible VC++ runtime libraries; native loading errors fail preparation. CI uses controlled encoders and does not download weights.

prepare-model 独占新目录，固定上游 revision、五份推理资产摘要及 Transformers.js 版本；prepare-semantic 额外冻结实际 ONNX 原生运行库文件。不得覆盖旧目录。模型下载通过既有公共 HTTP／DNS／重定向边界，不传入事实或凭据；编码禁止远程加载。当前固定参数为 480 内容 token 窗、64 重叠、query／passage 前缀、mean pooling、归一化及窗口最大余弦分数。超过模型输入上限时只分窗编码，不裁剪注入事实。

语义审计复用原逐题数组，在需要强制补齐的题目添加 semanticRequired 事实 ID 数组。它必须是 necessary 子集，且不能包含基线已召回项；本轮杂志题固定为 Architectural Digest 与单期购买 National Geographic 两条，排序不读取这些 ID。semantic-gain 要求两者同时可见、current 全部 ID／顺序／原文保留、四锚点保留、必要证据逐条无损失及正文预算通过。两候选均通过时先比增益，同分选 0.80；都失败时 selected=null、空计划，run 在读取凭据前拒绝。先生成全部上下文再读标签；开发题已被研究，不声称盲测。

新授权 500000 input+output 仅在门禁通过后执行原六项双臂 smoke 与十一题配对一次，沿用原模型、reader、judge、种子、并发与计量停止规则。所有回答／评分计入同一新预算，不重新提取。原批次建库成本与 unknown 单列。报告保留必要事实原文、角色／时间、相关度和名次、来源与重复字符，编码墙钟、CPU 时间与采样 RSS 另列，RSS 不称作峰值。模型加载和缓存复用不计为 API tokens；API 零调用不等于未做本地推理。

未通过时保留失败配置与证据，不降低门槛、改 top-k 或补刊物词典。新增模型依赖只作显式候选，即使 QA 采用门槛满足也只标记可采用；本轮不自动切换普通安装默认值。


### BGE base 与 MMR 的新批次

```powershell
pnpm benchmark:memory-recall prepare-bge-model <新模型绝对目录>
pnpm benchmark:memory-recall prepare-bge <新实验绝对目录> <已结束父批次> <已结束子批次> <语义审计JSON> <BGE模型绝对目录>
pnpm benchmark:memory-recall preflight <实验目录>
pnpm benchmark:memory-recall run <实验目录> --live
pnpm benchmark:memory-recall report <实验目录>
```

English: the BGE-base candidate uses pinned quantized ONNX weights, CLS pooling and the model's query instruction. Compare relevance-only and fixed 0.7 MMR supplements to the unchanged baseline. MMR considers only eligible baseline facts and the eight candidate facts; it never removes baseline entries. Existing E5 manifests retain their original policy and parameters. No automatic asset downloads or default switch occur.

prepare-bge 冻结 semantic-model-gain。两个候选共用 memoryTerms(question,true) 的词项查询与原陈述／引文；普通 reader 题面不变。语义相似度是相对排序，不沿用另一模型的绝对阈值；候选池仍前八，最多补四，正文仍 8000 字符。MMR 在相同池内贪心选 `0.7 × relevance − 0.3 × max similarity(selected)`，装不下不计作已选，同分保持既有稳定次序；两候选门禁同分时选 MMR。

审计沿用 semanticRequired，必须补齐本轮两条遗漏、逐条必要证据无损失、全部 baseline 原文与 ID／顺序原样保留、四锚点可见；先生成上下文再加载标签。模型和方法选择使用过已知开发题，全部原型、失败和诊断保留，不能称作盲测或泛化验证。

用户明确授权同范围 Memory 小样本后续直接使用 tokens，不再重复询问；本轮及后续独立批次默认上限为 500000 input+output。通过离线门禁后自动运行固定六项双臂 smoke 与十一题各组一次，沿用原 Go 模型、reader／judge 设置、种子和并发二。每批从新目录与新账本开始，不自动恢复、重发或删除失败，不把旧 unknown 清零。正式采用仍由完整问答、计量、无回退和成本条件判定，本轮新增依赖保持显式候选。
