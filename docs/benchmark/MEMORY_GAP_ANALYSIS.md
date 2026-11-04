# Memory 差距分析与 Harness 对标

当前结论是阶段性的：**具体事实在提取与整理阶段丢失，是已经有直接证据的主要问题；不能将分差直接归因于 DeepSeek，也不能用本次无工具 reader 判断完整 coding harness 的竞争力。**

本文对应独立分析目录 `.cache/memory-analysis/go-flash-native-015/snapshot-005/`。公开结果集合冻结于北京时间 2026-11-04 13:41:41，450/4500 项已有终态，4050 项尚未结算；编码 72 项全部通过。统计与模型证据分开保存，旧批次和运行配置保持完整。后续运行记录不会自动变成这个快照的证据。

## 观察到的质量差距

| 同题、同重复的比较 | 配对数 | Memory 正确 | BM25 正确 | Memory 减 BM25 |
| --- | ---: | ---: | ---: | ---: |
| 全部已结算，失败计入分母 | 149 | 10/149（6.71%） | 82/149（55.03%） | -48.32 个百分点 |
| 双方均成功执行，仅用于诊断 | 135 | 10/135（7.41%） | 70/135（51.85%） | -44.44 个百分点 |

这些配对来自 50 个独立问题，三次重复不作为独立题扩大样本量。只看双方执行成功的样本，差距依然存在，说明服务故障解释不了主要差距；成功子集也有选择偏差，不能替代主表。未运行题不记成答错，六类、abstention 和每次重复完整保存在快照 `summary.json`。本协议固定禁用正式置信区间，不作显著性声明，不外推全量结果。

## 信息在哪一步丢失

| 已观察事实 | 原始证据与中间结果 | 定位与解释 |
| --- | --- | --- |
| 猫名 Luna 没有进入记忆 | 问题 `0862e8bf`，证据历史序号 27；三次重复的真实投影都包含 Luna，未裁剪，提取均返回空 entries | 提取阶段未保留事实；不能归因于存储容量或检索算法 |
| 推荐的 pilsner/lager 被整理删掉 | 问题 `16c90bf4`，历史序号 41；重复 1/3 提取为空，重复 2 提取到啤酒类型，但 merge 只保留“推荐地域食谱”的通用规则 | 重复 2 是整理丢失；候选日志存在事实，不等于 active Memory 已保留该事实 |
| “4 个木乃伊”变成通用写作要求 | 问题 `18dcd5a5`，历史序号 42；原文与真实投影有 Mummies (4)，三次提取改为剧本、属性表等规则 | 未保留需要回答的数量。来源 Session 命中也不能证明细节被保留 |

**机制解释**：[生产提取提示](../../src/memory/learned-memory.ts) 优先保存纠正、仓库惯例、已验证程序与显式长期偏好，排除临时细节，每次最多三条。整理提示又要求最多三条。这适合经验学习，但与本基准要求的姓名、日期、事件、数量和助手历史回答存在目标偏差。上述案例证实具体丢失路径，不代表所有错误都由同一机制解释。

**已有抽样证据**：种子 16716，按问题 ID 的 SHA-256 在六类内排序，选择各类最多 10 个、全部九个计划项已有终态的独立问题。实际可选数量为 6／8／2／10／10／10，共 46 题；失败也保留，不按回答好坏筛选。审查三次重复与全部三组，原始链接在 `cases.md`，提取／整理输出与投影在 `cases.json`、`projections.json`。

46 题对应 138 条 learned-memory 记录：14 条基础设施失败，65 条错误记录的全部 gold Session 提取均为空，1 条锚点在整理时丢失，3 条数量锚点未保留，7 条答对，其余 48 条保留为“需语义判断／未确定”。这是 AI 审计的可观察信号，不是经过校准的因果分类或人工复核。字面不匹配不能排除同义表达，审计脚本不会据此补造“已存未召回”等结论。

## 召回、成本与编码证据

同一双方完成的 135 组中，Memory 来源覆盖为 72/253（28.46%），BM25 为 164/253（64.82%）。这只统计来源 ID，不等同事实内容覆盖。Memory 并非空召回：平均约 6280 字符，active 平均 22.27 条、最大 41 条，review 与归档均为零。当前子集没有达到 100 条容量上限，也没有冲突 review 阻塞的证据；优先增加容量缺乏支持。

该共同子集含建库与评分的已知 token 为 Memory 19,646,510、BM25 310,720，约相差 63.2 倍。两组最终交给 reader 的平均上下文字符数相近，大部分差异来自逐历史提取／整理。不能把这视为生产长期每次查询的成本比：实验为每个样本独立建库、回答一次。快照分别展示构建、回答、评分、失败消耗及 Q=1/10/100 的算术摊销情景；情景没有测量未来查询质量或缓存收益。

快照账本读取区间内 campaign 已知累计 27,288,546 tokens，祖先部分仅加一次；独立诊断另计 211。累计 15 条已关闭请求用量未知，该次账本采样无 pending，因此金额与完整消耗均不可宣称完整。后续在途与失败持续变化，请以新快照重新计算。当前缺口无法补回，也不重试失败。

编码 on/off 各 36/36 通过，首轮验证全部 passed、诊断轮次均零，同任务重复工具失败均零。on 已知 2,984,099 tokens、off 为 2,705,527，描述性高约 10.3%；同任务普通工具失败分别 20／21 次。跨源码身份、短合成任务与零空闲 capture 设置限制了推断，不能据此声称 Memory 提升了编码生产率，或把普通工具失败当作跨 Session 重复犯错。

## 外部系统：成绩与条件一起看

核验字段及缺项完整保存在 [比较来源目录](memory-comparison-sources.json)；快照另外保存 `external-comparison.json/md`。本次是公开材料核查，没有独立复现任何外部系统。

| 对象 | 公开材料核实到的成绩 | 必须保留的条件 |
| --- | --- | --- |
| LongMemEval 作者参考设计 | 保留原始 round，以事实扩展索引，并使用时间查询和 Chain-of-Note | 论文原始 S/M、不同模型、top-k；不能把 Recall/NDCG 当 QA 准确率。[论文](https://arxiv.org/html/2410.10813v2) |
| Mastra OM | 94.87% 六类宏平均；按公开计数为 468/500＝93.60% 微平均 | reader gpt-5-mini、Observer/Reflector Gemini 2.5 Flash、judge GPT-4o，平均约 30k tokens；数据 SHA 未核对。[原作者说明](https://mastra.ai/research/observational-memory) |
| Zep | 451/500＝90.2% | reader 与 judge 均 GPT-5.4，检索中位上下文 4408 tokens；检索延迟不是建库或完整回答延迟。[原作者说明](https://www.getzep.com/research/) |
| Mem0 | 作者报告 LongMemEval top_200 为 94.4% | 所查文章未完整绑定提取／回答／评分模型与统计口径，不能用 OSS 默认配置补齐 Cloud 成绩条件。[原作者说明](https://mem0.ai/blog/introducing-temporal-reasoning-in-mem0) |
| Hindsight | 已下载逐题文件，500 题中 correct=true 473，94.6% | reader Gemini 3.1 Pro Preview、judge Gemini 2.5 Flash-Lite，平均上下文 43624.5 tokens；压缩 SHA 与发布 manifest 一致，尚未核对历史语料身份。[开发者评测页](https://benchmarks.hindsight.vectorize.io/)／[公开运行清单](https://github.com/vectorize-io/agent-memory-benchmark) |

Hindsight 的 500 个问题 ID 和题面与本批次相同，也不能证明历史文件、提取模型、读取策略及 judge 相同。AMB 与 Hindsight 属于同一组织，不能标成独立第三方复现。不同 reader、judge、上下文预算和数据版本的分差，不能直接归因于 memory/harness。

## 完整 Harness 的能力与证据边界

| 维度 | 我们已具备或本轮测到的内容 | 对标与真正缺口 |
| --- | --- | --- |
| 项目规则与跨 Session 经验 | 项目／用户 Memory、任务验证后的自动捕获、人工维护、Session 恢复 | [OpenCode](https://opencode.ai/docs/rules/) 和 [Claude Code](https://code.claude.com/docs/en/memory) 都有持久规则；这些机制存在不代表 LongMemEval 高分 |
| 短索引与按需详情 | snapshot 与现有 memory_lookup | Claude Code auto memory 同样有短索引与按需主题文件；本轮 reader 禁用工具，没有对比两者实际使用效果 |
| 原文恢复与主动检索 | 生产已有 session_search、session_event_search、session_event_read 等工具 | [Letta 文件系统实验](https://www.letta.com/blog/benchmarking-ai-agent-memory/) 允许代理主动找原文，74% 属于 LoCoMo，不能进入本表 LongMemEval 排名；我们本轮未测试生产原文恢复闭环 |
| 上下文压缩 | 生产有压缩／持久检查点，本轮公开 reader 不使用 coding 上下文循环 | [OpenCode 配置](https://opencode.ai/docs/config/#compaction) 公开 auto/prune/reserved；文档能力不是统一模型实测优劣 |
| 编码验证闭环 | 宿主检查与独立验收全部通过后才捕获，72 项合成验证完成 | 尚无与外部 harness 在同一 Go／DeepSeek 下的长期真实任务对照；不能把其他产品测试工具描述等同宿主强制验收 |

我们使用 OpenCode Go 作为模型服务，不代表实验运行了 OpenCode harness。当前最明确的缺口是“事实记忆目标与证据保留”，完整 harness 的主动恢复能力属于缺少评测证据，不能写成产品没有。

## 下一步的最小验证顺序

| 优先级 | 现象与影响 | 外部可借鉴机制 | 最小验证 |
| --- | --- | --- | --- |
| P0 | 提取／整理把事实变成经验规则，答案缺少证据 | 原文证据保留；事实／事件与经验分层 | 新的隔离变体只改变提取或整理中的一个因素，先检查锚点与固定样本的事实保留；不能改当前批次或按 gold 写记忆 |
| P0 | 摘要丢细节后无法在本次 reader 中恢复 | 代理主动读取来源原文 | 单独评测现有 memory_lookup 与 Session 搜索链路，控制相同工具权限及总上下文；与组件成绩分开 |
| P1 | 召回来源不足、时间与实体细节缺失 | 多信号／时间检索、日期化观察 | 先用实际 active 条目区分漏存与漏召回；再分别测试索引、日期或重排，不预设需要图数据库 |
| P1 | 每题大量构建请求，成本与故障暴露较高 | 保留原文、减少不必要整理、复用建库 | 单独量化请求数、建库与查询成本、失败；验证惰性／批量整理是否保留质量，不重发旧失败 |
| P2 | 两臂合成任务均通过，无法分辨长期收益 | 长期连续任务与隐藏验收 | 后续设计有记忆依赖的真实序列，标注跨 Session 重复犯错、首轮通过与修复成本；需新实验而非本轮结果外推 |

以上为验证建议，并非已证明有效的修复。本次只新增离线分析和文档，没有修改生产 Memory 或发起额外模型实验。

## 复算与结束后更新

要求本机 Python 3.10+ 与仓库现有 Node/tsx，无需新增包或凭据。在不存在的新输出目录运行：

```powershell
python scripts/benchmark/analyze-memory.py --campaign C:\absolute\campaign --output C:\absolute\analysis-snapshot
python scripts/benchmark/analyze-memory.py --campaign C:\absolute\campaign --replay C:\absolute\analysis-snapshot --output C:\absolute\analysis-replay
python scripts/benchmark/analyze-memory.py --campaign C:\absolute\campaign --output C:\absolute\analysis-after-stop --wait-for-stop
python tests/unit/benchmark/memory_analysis_test.py
```

输出不得位于原 campaign 内，已有目录拒绝覆盖。结果集合先固定，随后在记录区间复制账本，因此不是全局原子时点；pending 与已关闭 unknown 分列。`source-index.json` 保存每份读取材料的 SHA-256、时间及内容寻址副本；replay 只读冻结字节，修改或缺失副本会失败。`projections.json` 用原生产函数离线生成，并核对源码身份；无需 provider 或 keyring。

输出包含 4500 项 `public-statuses.json`、72 项 `coding-statuses.json`、统计、案例、外部矩阵与收据。`--wait-for-stop` 只等待已有 run-state，再生成新的独立快照；即使停止于故障，也明确保留未完成状态，不恢复实验、不发模型请求。正式区间仍禁用。快照不标人工复核，校准检查覆盖 11 类统计误读。

## 限制

抽样仅覆盖当时已结算的前缀，六类样本数不齐，未使用它选择性汇报最终成绩。AI 审计尚未确定的链路不作自动语义归因；外部复现与统一 judge 校准均未执行。与动态实验解耦的离线分析不得触发生产调参或覆盖重跑。完整运行、计量完整与 Memory 有效分别判断。
