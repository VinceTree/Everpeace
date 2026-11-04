# 当前交接

## 主分支合并交付（2026-11-04）

用户明确授权合并此前已推送的 Memory 优化与 README 实验结果。本批通过 [PR #29](https://github.com/VinceTree/Everpeace/pull/29) 进入主分支，包含 b30f993、45b1bf7、7ff8c35；旧 PR #27 仅覆盖更早交付。先在独立检出同步 main。首轮 CI 的 Linux portable 因 Go Session 测试错误地要求 Windows 文件读取成功而失败；保留真实工具往返、Session 恢复、三次请求及 45 tokens 断言，在非 Windows 明确检查 FILE_ACCESS_UNAVAILABLE。安全扫描因静态英文文案与合成脱敏 fixture 的完整文件摘要变化而拒绝；核对内容后只追加两份精确摘要，不扩大路径或规则例外。生产代码、默认策略和依赖不变；须在修正后的 Windows 全量、Linux portable、安全扫描及 Required checks 成功后合并，不绕过保护。

首轮 Windows 另有两项测试失败：召回并发检查以固定 5ms 假定两个 provider 已同时进入，取消检查将冷 PowerShell 启动计入 12 秒取消时限。改为 provider 双请求事件屏障，以及 ready 后的单调取消计时；取消仍限定 12 秒，并新增确认进程树退出断言，整体 30 秒仅容纳启动与后续命令。原 29b81e4 的重新检查与本地四门禁均已通过；上述两个测试修正仍须独立再跑最终四门禁和 PR Required checks，不能沿用此前成功。

既有 Bing／MCP 六个未提交文件保持原字节并留在本地，不进入 PR。本轮不启动模型请求或新实验，不修改默认检索、展示值、tag 或 Release；使用 [skip publish]，保留 CI。原实验冻结摘要与结果仍绑定原身份，合并不构成重新实测。实际合并状态与 SHA 以 PR 和远端 main 为准，检查及工作区保留收据在 `.cache/memory-fact-preservation/merge-main-001/`。


## README 实测与外部对照公开摘要（2026-11-04）

用户在代码推送后要求同步 README 的本轮结果并与其他 harness 对比。代码已通过前述独立提交门禁并推送，代码提交为 45b1bf724a1283d6fc911eebae8254991154b0b2。新增中英文 Memory 实测段与 docs/benchmark/MEMORY_RECALL_REPORT.json，公开逐题标签、完整分母、冻结源码／构建摘要、用量、唯一同输入评分差异及未默认采用结论；不公开历史正文、凭据或本机路径。

本地小样本继续为 current 10/11、protected 9/11，68982 新 tokens、无新 unknown/pending，未重新提取。已按原始公开 Hindsight 文件 SHA 186cf0b05a5cbdd8223cea4336d5585a11677f774ddb7c743637c1e9c19a5222 对齐相同 11 个问题 ID 及逐字相同题面，外部标签为 11/11；全量 473/500。公开 manifest 的压缩 SHA d0bcc75fb4060f0a395239a353d2066d3f7d252bbe16d674c951d9855deaf9cf 与原收据一致。仅重算公开输出，不是重跑系统或同条件比赛，历史语料身份仍未核对。

已重新读取 Hindsight、Mastra、Zep、DS Harness 固定 revision、OpenCode、Claude Code 的一手页面。Mastra 分类计数微平均为 468/500＝93.60%，作者六类宏平均 94.87% 另列；Zep 为 451/500＝90.2%。README 同时列出回答／评分模型与上下文口径，明确 11 题开发子集、500 题发布成绩、字符与 token 预算不能直接排名。完整 DS Harness／OpenCode／Claude Code 仅对照文档机制，同条件实际分数标为未运行；Go 只是本轮模型服务。

本轮只修改文档和公开 JSON，不启动新模型请求，不改代码、依赖、默认策略或展示值。沿用刚完成的代码四门禁；另核对文档链接、双语、逐题和各汇总数字、公开数据摘要与 Git 范围：178 个文档路径／链接、959 项双语和暂存 diff 检查通过。本轮未重复 test/build，不将历史通过冒充新执行。继续使用 [skip publish] 提交推送，不打 tag 或创建 Release，Bing／MCP 的原有修改保持本地。


## 提交交付：事实来源与证据保护（2026-11-04）

用户已明确要求提交并推送。本次提交包含 Memory 事实捕获、消息来源回读、BM25／保护式聚合、独立计量实验入口、所需兼容端点接入与回归；共 85 个相关文件。Bing 网页解析及其文档／测试和原 MCP 测试调整留在工作区，未混入本次提交。双语入口同步说明普通完成对话捕获事实、编码经验仍要求 verified。

对实际暂存树建立独立临时检出验证，不依赖工作区内未提交的网页／MCP 修改。21 项 Python 回归通过。首轮 submit-001/gates-001 的全量测试为 1482 tests、1478 pass、1 fail、3 skip，未执行 build；失败为以固定 20ms 假设 provider 已准入的取消测试。两个相关用例改为等待模拟 provider 真实进入事件，保留用量、取消、禁止后续准入断言，定向 12/12 通过；只改变测试同步，不改变生产模型行为。

修正后 submit-001/gates-002 串行 typecheck → lint → test → build 全通过：1482 tests、1479 pass、3 个既有 skip、零 fail/cancelled；四项约 1.988／1.28／425.045／1.996 秒。177 个文档路径／链接、959 项双语与 diff 检查通过。验证后的提交内容仅补本条交接，功能、测试、manifest 和依赖保持与验证树一致。日志和冻结树收据在 `.cache/memory-fact-preservation/submit-001/`。

当前默认继续使用 current；protected 保留为已验证候选。此前真实 reader 的 68 次请求与 68982 tokens 仍绑定其原冻结身份，不迁移为本次提交的重新实测；本轮提交验证没有新模型请求。提交目标为当前 codex/source-candidate-evidence-2026-11-01 分支，使用 [skip publish]，不使用 [skip ci]，不改展示值、不创建 tag 或 Release。工作流核对：Release 仅手动触发；Test 在 PR 或 main 推送时运行。本条交接与代码一并提交，提交 SHA 见 Git 记录。


## 本轮：先保护基线证据，再以新授权运行 reader（2026-11-04）

用户明确要求继续优化证据聚合，优先解决木乃伊数量、最低售价丢失；离线筛选后直接使用 50 万 input+output tokens 做小样本预测，不再询问。新增 protected：current 的全部条目和顺序原样保留，再用空余正文预算补充局部词项关联事实。无主题词典、标签输入、模型提取或来源 ID 前缀关系推断，正文仍为 8000 字符整条装入。生产默认继续 current；本轮 QA 未满足默认采用条件。

本轮显式新增 prepare-protected／preservation-repair 验收，独立于原 prepare／evidence-gain；这是按本次“先修复丢失再实测”目标建立的修复验收，不把无新增证据伪装为通过旧门槛。protected-offline-001 在十一套完整库中保留全部 current 条目，恢复旧 aggregate 两条丢失并保留四个锚点，16／18 必要证据、相对 current 新增零。a3045048 部分库继续单列；旧 aggregate 仍为 14／18。原型与设计在 protected-design-001.json、protected-prototype-001.json，均零模型调用。

19 项定向回归通过，覆盖数量／最低价／否定／时间、完整基线前缀、预算、两跳有界关联、修复政策与旧增益政策并存。首次局部原型未获得新增必要证据，保留该结果；不声称修复已提升 QA。聚合关联只可能在剩余空间添加事实，也可能带来无关上下文，须以同身份 reader 实测判断。

protected-gates-001 串行四门禁全部通过：1485 tests、1482 pass、3 个既有 skip、零 fail/cancelled；约 1.70／1.20／433.92／2.20 秒，exec 50977 已退出 0。最终 sourceDigest `7bb6d184a8d0f3d20bc60874f841d418a3b873c87354c1ed7a241928c54cd657`、buildDigest `bd73fc02cff0ae511c890528f9e386d5dc62c388248e94bc26aac1566b90354d`；门禁、prepare／preflight、实际请求及收尾身份均一致。

正式新批次 `.cache/memory-fact-preservation/protected-pilot-001/` 已结算，exec 92893 退出 0。六项 smoke 双臂 12/12 正确；公开 22 项全部 completed，无失败或跳过。current 10/11、protected 9/11；木乃伊两组均答对 4，最低总售价均答对 $5,150（$5,000＋至少 $150）。新 68 请求全部可靠结算，input 62315／output 6667，共 68982 tokens，reasoning 不另加；新 unknown／pending 均零，峰值并发二，墙钟约 126.2 秒。answer 34 请求 63002 tokens，judge 34 请求 5980；提取请求零。配对公开回答 current／protected 为 28784／29507，比例约 1.0251；50 万总预算未耗尽，不追加重试。

唯一评分回退 57f827a0：两组完整上下文相同，实际回答请求 SHA 均为 `5e930a8c35057250c36c9a489358f1af64f7c796e6da1ff868f0270e1b85e4f1`。current 回答包含 mid-century modern dresser，protected 的这次生成未提及该偏好。不能将同输入的单次生成差异归因为聚合，但原分数与采用失败保留。仅猫名、杂志题正文发生变化；杂志仍未补齐语义缺口，两组均答 1、标准 2。没有复跑、改分或缩小分母；固定开发题一次重复、自动评分未人工复核，不给正式区间或保留集升级结论。

主交付 summary.md、critical-answers.json、regression-audit.json、verification.json；完整报告在 `report-3b444203-4e87-4ba2-acda-c5eb1cc08972/report.json`，offline.json 保留修复政策及逐题得失。核验 663 个原输入文件字节摘要未变；11 题 baseline ID、顺序和正文前缀全部保留，四锚点引文可见，两个旧丢失全部恢复。父子旧已知 2205808 与 unknown 1 单列，不作为本批新消耗，不清除历史缺口。

已更新双语 README、Memory／评测协议、PLAN、DECISIONS 与交接；不提交、推送、改版本或启动保留集／全量。下一步若继续改进，需要解决杂志题等词项之外的证据关联，并用重复采样研究同输入输出变化；该建议不自动启动新请求。最终 177 个文档路径／链接、959 项双语及 diff 检查通过；收尾再次核对当前身份与全部证据文件摘要一致。本轮实验已结束，无运行中实验进程。


## 本轮：本地词项与多会话聚合未通过离线筛选（2026-11-04）

用户批准本地检索路线及新的 50 万 input+output tokens reader 实验预算；live 以必要证据正增益且无损失为前提。当前已实现共享 current／terms／aggregate 选择器、独立 benchmark:memory-recall 的 prepare／preflight／run --live／report 入口及回归。生产默认继续 current，不重新建库、不访问保留集、不恢复旧失败；本轮真实模型与提取请求均零。

初步消融 aggregation-design-001：11 个完整事实库，a3045048 的部分库单列。固定审计表 evidence-audit-001.json 共 18 条必要证据，current 16／18、terms 16／18、aggregate 14／18；锚点分别 4／4、4／4、3／4。terms 没有新增必要证据；aggregate 丢失 18dcd5a5 的 Mummies (4): 与 91b15a6e 的梳妆台至少 $150。按已批准筛选规则，两候选均不进入 live。来源计数求和 124／116／174，不能将来源数量增加当作证据改善。

杂志题的 current／terms 正文为 6728／1499 字符，但必要证据均只命中 New Yorker 与 Forbes 取消；Architectural Digest 与 National Geographic 购买事实仍未进入。购买不等于订阅。旧报告所称来源覆盖下降，在该题具体是 gold 来源集合替换、命中数量仍为三；不能凭来源数量判断关键证据完整。

首次定向回归暴露 unknown 响应虽然关闭 gate、仍可被包装器返回的问题，已显式拒绝停止后的返回；初次失败输出保留在本聊天工具记录，无真实请求。新增实际项目 hash 路径读取，避免枚举同 store 其他项目；因此 aggregation-gates-001 运行期间发生源码变化，只作中间证据，最终必须另从 typecheck 串行重跑四门禁。首轮实际全部通过：1481 tests、1478 pass、3 个既有 skip、零 fail/cancelled，约 1.70／1.23／410.09／2.37 秒；因为源码变化，不作为最终身份门禁。最终 aggregation-gates-002 从 typecheck 串行重跑全部通过：1482 tests、1479 pass、3 个既有 skip、零 fail/cancelled；四门禁约 2.06／1.22／407.13／2.19 秒。exec 97717／36204 均已退出 0，无运行中实验进程。

最终交付 `.cache/memory-fact-preservation/aggregation-replay-001/summary.md`、cases.json、audit.json、selection.json、manifest.json 与 verification.json；详细逐题报告为 `report-1b880409-2da9-4f3f-8a4d-7e3b49521654/offline.json`。prepare／preflight／report 实际执行通过；手动调用 run --live 验证无合格候选时在读取凭据前拒绝，live-guard.log 保留预期拒绝，started.json 与 requests 均不存在。本轮真实模型、提取及新 tokens 均零，QA 正确率为 null，50 万授权额度未消费且不自动用于下一轮。

最终 sourceDigest `e95ab51a125e1f222c271d85e9801d438201d629cd9271558c647df960ab755c`、buildDigest `1ef1201a8e943984a5ae161e5bfeae146d0e431a1579d87e021c47a52937badf`；门禁前后源码一致，最终清单与构建一致。663 个原输入文件摘要未变；current 的 11 题 ID 与完整正文和 recall-replay-002 逐字节一致。父子 631 条请求唯一、全部 settled／openRequests=0；已知 2205808 与旧 unknown 1 保留，不计入本批新消耗。verification.json 冻结证据文件摘要与门禁结果。

已同步中英文命令、Memory 专题、评测协议、PLAN、DECISIONS 和交接；最终 177 个文档路径／链接、959 项双语及 diff 检查通过；收尾再次核对当前身份及全部证据文件摘要一致。本轮没有提交、推送、修改版本。下一步若继续研究，应优先考察必要证据约束或语义缺口；当前通用来源惩罚不能默认启用。上述为后续建议，不自动授权新实验。


## 本轮实验速览（2026-11-04）

已完成用户要求的顺序：先补跑 pilot-002 的 skipped，再优化召回。评测沿用本机 Go／deepseek-v4.1-flash；原批次与失败记录完整保留。本轮没有提交、推送或发布。

| 阶段 | 实际结果 | 计量与证据 |
| --- | --- | --- |
| 原排序下补跑 | 11/11 skipped 完成；合并后 Memory 6/12 正确、BM25 4/12 正确，原 2 个 failed 保留；共同完成十题为 6/10 对 4/10 | 新增 272 请求、985484 tokens；父子累计已知 2205808，父 unknown 1 保留，新增 unknown／pending 均零。原始记录在 `.cache/memory-fact-preservation/pilot-003-skipped/` |
| 新 BM25 排序离线回放 | 木乃伊数量 213→15、奶精偏好 353→6，均进入 8000 字符正文；Luna／啤酒锚点仍保留 | 复用 11 个完整事实库，1 个部分库单列；模型／提取请求均零。报告在 `.cache/memory-fact-preservation/recall-replay-002/summary.md` |
| 最终工程验证 | typecheck → lint → test → build 全通过；1466 pass、3 个既有 skip、零 fail | `.cache/memory-fact-preservation/recall-gates-001/`；最终身份与输入摘要见 `recall-replay-002/verification.json` |

必须区分：补跑问答成绩属于旧排序，不能记为新排序的 QA 成绩。新排序只通过离线召回验证；gold Session 总覆盖 16→17，但 `1a8a66a6` 来源覆盖下降，尚不能证明普遍质量提升或达到保留集升级门槛。当前没有运行中的实验进程，不自动重试旧 failed、清零 unknown、重新建库或启动付费／保留集／全量实验。

下一步建议是审查多 Session 的覆盖下降与证据聚合；如需真实回答验证，另建与当前新身份一致的批次，并按用户后续明确授权执行。下面保留详细实施、故障、验证与历史批次记录，历史“运行中”文字不代表当前进程状态。

## 当前：skipped 已全部接续，BM25 召回候选完成离线验收

用户最新要求先继续 skipped，再优化召回。新增 prepare-skipped 只运行原 11 skipped（Memory 5、BM25 6），13 条 completed／failed 与六项通过 smoke 带父来源保留，原 2 failed 未重试。父请求必须关闭；父 unknown 只保留披露，不清零，子批次新错误仍严格停止。父子输入、报告和账本摘要冻结；两个批次各自的 200 万预算与用量分开，不重复累计。

pilot-003-skipped 已完整结算，exec 29710 退出 0：11/11 新项 completed，无新增失败／跳过／unknown／pending。272 次新请求、985484 known tokens；父子累计 known 2205808，父 unknown 1 保留。合并公开 24 项为 22 completed／2 failed／0 skipped：fact-memory 10 completed、6 correct／12，bm25-history 12 completed、4 correct／12；双方成功十题为 6/10 对 4/10。新增 Memory 3/5、BM25 0/6。该成绩属于原子串排序，父子评测源码不同，不是新排序 QA 或正式质量门槛结果；仍无正式区间。analysis-003-skipped/report.md 区分本批请求消耗与父 known／unknown，并按 retainedFrom 读取原事实；settlement-verification.json 冻结接续收据。

接续候选 sourceDigest 4a9feb674c9940b66a25ffd921022da065e405fb9c043f88e43e0b7a0db9fe31，buildDigest 09361a982dbf05df9e03a17689e71ab363ecb71aa63536abbb11f0650ea7e793；启动和结算一致。skip-gates-001 的 test 曾出现两项 Windows ProcessCleanupError（context-pruning 首项、file-attachments 缺失路径项），1461 pass／2 fail／3 skip，未 build 或调用模型。相关两文件串行复查 16/16 通过约 11.3 秒；未改无关实现或删覆盖，根因未确定，日志保留。skip-gates-002 从 typecheck 重跑全部通过：1466 tests、1463 pass、3 个既有 skip、零 fail/cancelled；约 2.49／1.55／466.42／3.47 秒。exec 22912、15848 分别已退出 1／0，均不再运行。

确认该批次关闭后才改生产 Memory：src/memory/retrieval.ts 共享完整词项 BM25 k1=1.2、b=0.75，NFKC、小写、英文功能词过滤、Han Unicode 双字片段和路径／标识符；先过滤 active／到期／来源资格，再统计当前范围词频；相关性优先，原元数据只处理同分。保持 8000 字符整条正文、提取、事实、来源和公开 SDK。bm25-history 原文基线未改。ranking-prototype-001.mjs 与 recall-design-001.json 保存首个原型／既定参数，recall-baseline-sources-001 保存原排序源码，不污染或覆盖已运行实验。

replay-memory-recall.mjs 只读现有父子事实，先召回再读取标签，使用共享生产 snapshot；事实及结果输入摘要前后一致，零模型／零提取／零新 QA。最终 recall-replay-002 覆盖 11 个完整库，1 个部分库单列。目标和引文进入正文：木乃伊 213→15、奶精 353→6，Luna 3→1、啤酒 1→1 仍保留。gold Session 总覆盖 16→17，但 1a8a66a6 的来源覆盖下降，保留为限制，不能称为通用质量提升。初版 recall-replay-001 原样保留；其 summary id 为事实 ID，002 已独立加 questionId，排名和结果不变。

最终 recall-gates-001 串行四门禁通过，约 2.17／2.81／484.46／4.03 秒；1469 tests、1466 pass、3 个既有 skip、零 fail/cancelled，exec 35797 已退出 0。Memory 定向回归 107/107 通过。最终 sourceDigest b67d0f4867e9f10d7736d4b3498761d093ba55b525b1b68f09c22b0ab85fc142、buildDigest 360a6244705cf33e0c90619b3b81f6ae09e6a27b800e55e4be611aea7ae1f751；主交付 recall-replay-002/summary.md、report.md、replay.json、identity.json。verification.json 已核对来源／构建一致、四锚点引文进入预算、原输入摘要不变，父子 631 请求唯一且全部关闭、旧 unknown 1 保留；排序阶段零模型／零提取请求。

召回优化阶段没有追加付费请求、重新提取、改变旧问答或自动启动新批次。新排序尚无真实 QA 结果，不宣称通过保留集正式升级门槛；未提交、推送或改版本。中英文命令、Memory／评测专题、PLAN、DECISIONS 已同步；最终 177 个文档路径／链接、959 项双语及 diff 检查通过。

## 当前：pilot-002 已因网络错误停止，修复后效果分析完成

用户授权先跑六项 smoke，再做同一 12 题 Memory／BM25 对照。本轮新独立目录 .cache/memory-fact-preservation/pilot-002/，authorization.json 登记 200 万 input+output 上限；旧清单与旧实验保持原状，不继承无限额。来源链已验证候选 sourceDigest e027e0576aaa25b056c66ec1b1736bc30e823da88fc820ffcada31cd24192420、buildDigest d7ff552f92f84febf16873fff4fa9adb92a99af3bb266da1c689074187d2115f，启动、运行中与收尾身份一致，生产源码和提示未改。四门禁沿用同身份 source-gates-002；本轮只增加离线分析脚本及文档，没有重新构建或付费重试。

exec session 59776 已退出 0 并写出 run-state；exit 0 不是实验完整。北京时间 2026-11-04 16:31:41，57f827a0 的回答请求网络错误 und_err_socket／transport_failure 触发 service_error 全局停止；该请求 settled、usage incomplete，未知用量一次。a3045048 的在途构建可靠结算后受全局停止影响，保留失败；pending 零。没有自动重试、续跑或扩预算，也未启动保留集、全量或新编码 pilot。

六项 smoke 6/6 正确，6025 tokens。公开计划 24 项全部有状态：11 completed、2 failed、11 skipped。Memory 5 completed／2 failed／5 skipped、3 correct／12；BM25 6 completed／0 failed／6 skipped、4 correct／12。双方成功配对 5 题：Memory 3/5、BM25 4/5，独对 0／1，均错 1，均对 3；不能称为全 12 题结果或质量提升。自动评分未人工复核，不报告正式区间。

359 次请求：extract 324、answer 18、judge 17，峰值并发二，墙钟约 19.2 分钟。已知 input/output 为 903327／316997，共 1220324 tokens，另有一次未知，不是精确总消耗；reasoning 已包含于 output。提取 1189761、回答 27421、评分 3142；提取约占已知 97.5%。Memory 失败样本已知消耗 234139，未知回答仍另列。共同成功五题计量完整：Memory build/answer/judge 为 952801／12335／1072，BM25 为 0／10183／913；单独回答 tokens 比约 1.21。一次建库答一道题的实验成本不能外推长期生产查询成本。

已完整构建 6 套历史，另 1 套 9/53 个 Session；存储事实 4236，拒绝无效事实 67。没有再次因单条引文无效而整题失败。Luna 事实第 3、啤酒类型第 1，均被召回并答对。木乃伊题保存 Mummies (4):，却排第 213，14 条召回事实只取到 gold Session 的背景；奶精偏好已存却排第 353，22 条召回漏掉关键原料和低糖省钱目标。两例为已存未召回；等权子串匹配让常用词命中压过关键实体，是有证据的机制解释，尚未验证替代排序收益。生产来源工具已实现，但无工具 reader 未测其收益。

只读产物：analysis-002/ 的 report.md、summary.json、cases.json；comparison-003/ 的 effect-analysis.md 为主要中文结论，comparison.json／selected-evidence.json 为可复算汇总，case-audit.json 与 reproduce-audit.mjs 复现四个锚点，逐题共享生产 snapshot 回放 ID 与原请求一致。comparison-002 为补齐配对成本前的中间分析，保留；comparison-selfcheck-001 是旧批次自比较自检，无模型调用。新 scripts/benchmark/compare-memory-fact-pilots.py 实际账本复算通过。一次交接写入遇 Windows OSError 22，原文件完整后用 apply_patch 完成，不是模型服务故障。

下一步建议仅离线回放现有事实的检索排序及来源上下文，确认有效再另行授权少量 reader；没有自动实施新生产策略或启动新批次。预算未耗尽不等于允许重试未知请求。最终 177 个文档路径／链接、959 项双语和 diff 检查通过；comparison-003/verification.json 冻结请求及分析文件摘要，复核 359 requests＝359 attempts、无重复消费、无未决请求，保留一项 unknown；与启动 manifest 的源码／构建身份一致。

## 当前：事实来源链完成，离线证据与最终门禁通过

用户批准实施“事实 → 实际消息 → 原文回读”，本轮仅离线，不继承旧预算、不重跑旧失败、不启动保留集或全量。原 015 的两个 pending 和首轮 pilot 的失败继续保留。沿用既有 dirty checkout，未提交、推送或改版本。

宿主历史服务新增 beginMessageCapture／resolveMessages，以独立的本轮边界绑定实际 context_append 消息，按完整顺序、角色、脱敏正文核对。真实事件引用沿用原 history 格式；模型工具 prepared-step EOF 不变。source 与引文 UTF-8 偏移贯通 FactSource、事实、队列和恢复，最终助手消息落盘后才绑定；原始消息时间与导入时间分开。共同消息投影保留布局，分窗不拆 Unicode 代理对，裁剪或脱敏改变来源时明确降级未绑定。memory_lookup 保持旧字段，新增 lookup.sourceStatus／read，旧 ID 和搜索回退兼容。提取提示、无效引文逐条拒绝及排序保持现状。

新增 source-chain.test.ts、共享离线 fixture 和 scripts/benchmark/prove-memory-sources.mjs。固定响应验证真实 Session/Memory 存储，覆盖姓名、助手建议、数量、重复正文、状态更新、重启、压缩、跨 Session、UTF-8 分页及失效来源；不报告模型 QA 成绩。新增宿主扫描不完整／不扩大工具边界测试和来源布局归一化回归。定向组第一轮 152 项：151 pass、1 个既有 symlink skip；之后补充归一化回归进入完整门禁。初次定向发现测试响应只返回 output_text 而没有持久化的 message，修正为真实协议响应后来源链通过；初次 typecheck 缺 titlePending 的 fixture 已补齐。

首轮完整门禁 .cache/memory-fact-preservation/source-gates-001/ 全部通过：1464 tests、1461 pass、3 个既有 skip，零 fail/cancelled。复查发现同正文不同轮次会在旧捕获队列身份中碰撞，已将宿主事件引用纳入新任务身份，旧无绑定任务保持兼容；新重复对话／同版本幂等回归通过。最终候选 source-gates-002/ 从 typecheck 串行重跑全部通过：typecheck／lint／test／build 约 1.74／1.25／336.54／1.90 秒，1465 tests、1462 pass、3 个既有 skip、零 fail/cancelled。本轮外部模型请求为零。

离线证据目录 .cache/memory-fact-preservation/source-chain-001/：report.md 为中文报告，evidence.json 冻结源码／构建身份与 fixture 摘要，history-reads.json 保留实际历史工具返回。13 个场景中精确绑定 7、重启压缩后的精确回读 1、搜索回退 1、来源不可用 4；真实工具记录有 9 次正确原文回读、4 次预期 not_found、7 次证明宿主捕获不扩大模型 EOF 的空搜索，回读不一致零。来源不可用是合成的预期拒绝场景，不是生产故障计数。固定响应验证机制，qaAccuracy=null，不宣称模型质量提升。

最终 sourceDigest `e027e0576aaa25b056c66ec1b1736bc30e823da88fc820ffcada31cd24192420`，buildDigest `d7ff552f92f84febf16873fff4fa9adb92a99af3bb266da1c689074187d2115f`。提取提示与 pilot-001 冻结 extraction 字符串一致；新候选没有 live QA。next-plan.json 仅准备相同六项 smoke 与 12 题两组（24 回答项），tokenBudget=UNAUTHORIZED、liveAuthorized=false、executableCampaign=false，不能直接执行。不启动保留集或全量；后续真实模型验证须有独立新预算。



## 当前：全量已停止，事实修复与门禁完成；首轮实测失败已定位

用户已批准停止 015、先修复后仅跑 12 题／200 万 input+output tokens；这替换下文等待全量的历史顺序。015 已停止，不自动恢复。Ctrl+C 使原进程退出但未写出正常 run-state，保留两个 pending，不能称为有序结算全部请求。只读收尾快照 `.cache/memory-analysis/go-flash-native-015/user-stop-001/`：549/4500 有终态，已知 campaign 含祖先 31450440 tokens，诊断另计 211，已关闭 unknown 22，pending 2；72 编码结果仍保留。停止说明为同父目录 user-stop-receipt.json，原请求标记不改写。原报告已离线更新，旧分析等待器 PID 29748 已关闭。

生产新增 `src/memory/facts.ts`，普通对话由宿主 no_changes、无验证债务及完整跟踪判为 conversation_completed，仅捕获事实；verified 可在同请求产生事实与经验。独立事实文件使用原控制锁、事务、epoch 与租约，项目 clear 会同时删除事实；读取与旧 memory_lookup 兼容。事实包含角色、引文、消息／事件时间和来源查询，不伪造 event ID 或编码 verified。候选不再通过模型概括；严格解析区分空与非法，提取后显式阻断 unknown 写入，旧 extracted 与新 bundle 检查点保持兼容。事实/原文摘录进入统一 snapshot 预算，完整原文仍通过已有 Session 工具读取。

新增小样本入口 `pnpm benchmark:memory-pilot` 与离线报告脚本 `scripts/benchmark/report-memory-fact-pilot.py`。当前 `.cache/memory-fact-preservation/pilot-001/` 已冻结 12 题×2组、六项合成 smoke 及 200 万总预算，真实请求已结束（exec 41520 已退出 0）。不读取保留集，不跑全量，不自动重跑；unknown／存储失败和 smoke 错误停止新请求。该首轮运行时的源码、构建及提取提示保持冻结；后续修改仅为新的离线候选，不能把其结果套用到首轮。首轮源码摘要 `68201187c51630aabb0394b0fbfd49d98ad53cfbe007825b87b531253c05c62b`，构建摘要 `9fba896aa81680b80c7fd76e3efa0b0985e5d98c8cc34b64afe814f0ce24f26d`。

首轮模型证据：六项 smoke 均 completed/correct，5840 tokens；公开 24 项全部有终态，fact-memory 0 completed／12 failed（MemoryExtractionError），BM25 12 completed／5 correct。合计 407959 tokens，全部计量完整、无 pending／unknown，峰值并发二；phaseUsage 和组别成本在 `.cache/memory-fact-preservation/analysis-001/summary.json`，中文报告 report.md、逐题 facts 与来源 cases.json。第一轮不能证明质量提升；事实组没有到达回答阶段，双方成功配对为零，不能报告条件正确率。未运行保留集或全量，也未追加模型实验。

已从收据定位模型引用省略 Markdown 或以省略号拼接原文，导致首轮严格引用校验拒绝整个窗口。第二候选只改变此处理：拒绝无支持的单条事实、保留其他有效事实，rejectedFacts 随 bundle、capture 状态和 benchmark checkpoint 记录；非法 JSON／整体结构错误仍不是空提取。对应单元回归通过。首轮 facts.ts 副本保存在 analysis-001/source，首轮模型证据不覆盖。

离线重放 `.cache/memory-fact-preservation/replay-quotes-001/replay.json` 经当前生产提取器回读首轮已捕获收据：12 个历史前缀，1376 条接受、16 条拒绝，零模型调用；完整历史为零，没有计算 QA 正确率，也不能替代第二候选的 live 验证。第二候选四门禁 `.cache/memory-fact-preservation/gates-005/` 串行全部通过：typecheck／lint／test／build 约 2.17／1.40／463.48／2.77 秒，1460 tests、1457 pass、3 个既有 skip、零 fail/cancelled；不再自动启动新的付费批次，后续模型验证需按计划单独登记预算。最终源码摘要 `2339bca524ae7600019a86fb9842b2003e4fde33c825edd6232ce1e02e6b3b21`，构建摘要 `08d6966c441c976fca0b2a548ab53d36314277a820c6d8ae1b13fca5351215b9`；该候选尚无新的 live QA 成绩。最终核验收据 `.cache/memory-fact-preservation/verification-final.json`。

首轮候选四门禁 `.cache/memory-fact-preservation/gates-004/` 串行全部通过：typecheck／lint／test／build 约 3.70／1.62／481.29／5.02 秒；1460 tests，1457 pass、3 个既有 skip、零 fail/cancelled。此前定向捕获测试发现去掉合并后的 unknown 写入边界缺口，已补显式检查；成功 fixture 补齐可靠 usage，原缺失用量用例保留。旧 no_changes 的 workflow、runtime 和 TUI 断言更新为独立完成对话分类，仍不等于 verified。

保留所有中间失败：gates-001 在补齐恢复与准入边界时中断；gates-002 发现候选去重元数据比较及旧 no_changes 预期问题后停止；gates-003 完整跑完为 1456 pass／1 fail／3 skip，失败为 TUI 旧预期，未 build；修复后 gates-004 从 typecheck 完整重跑通过。原生隔离测试较慢，不删减覆盖。离线准备的 14 个 Python 回归、177 个文档链接、959 项双语与 diff 检查通过；最终文档更新后再核对。


## 事实保留优化：离线准备已完成，生产接入待原批次结算

2026-11-04 用户批准实施通用 Memory 优化，覆盖当前工作区普通完成对话，仍保留编码经验 verified 准入。用户计划同时明确：015 结算前只做独立用例、离线重放及候选清单，之后才修改生产源码与重新构建。本轮遵守此时序；**完整优化尚未完成**。待办仍包括严格解析与确定性保留的生产接入、事实存储与普通对话捕获、消息来源定位、检索融合、工具兼容、生命周期回归、四门禁及新预算下的 live 评测。没有新的模型请求。

新增 `scripts/benchmark/prepare-memory-facts.py`（prepare／verify）、`tests/fixtures/memory-fact-preservation.json`（24 个合成任务）、`tests/unit/benchmark/memory_fact_preparation_test.py`；协议入口 [事实保留优化](benchmark/MEMORY_FACT_PRESERVATION.md)。只新增 scripts／fixtures／测试与文档，未修改本次开始时的 src、native、dist、package.json、锁文件或 SDK。当前生产 sourceDigest 仍为 `eb972c8da229a10cc7d4384451b63a042b12e7848a675b66ea921e058a2aea7a`，buildDigest 为 `24832ffbe27968433eaa7ac0b034a7c68ebe73961bd618af6566c2609731327e`；prepare 读取预检实际身份并核对。

有效准备目录 `.cache/memory-fact-preservation/preparation-002/`：整组历史划分为开发 60、保留 120、unused 320；开发六类各 10，保留六类各 20，所有已审计题都在开发侧，无缺额或超额。开发 300 回答项、保留 360 模板项、合成 48 任务项均 not_started；保留模板中的 SELECTED 尚未绑定候选。构建输入与问题及 grader 引用分离，16 个生成 JSON 有 SHA 收据；新预算 UNSET，productionIntegrated/liveReady 均 false。保留集后续如被逐题审阅或调优，必须登记失效，不能继续称为未审阅保留集。

从 snapshot-005 的冻结副本重放 5971 条有响应的提取收据：4289 合法空、1665 合法非空、13 结构不符、4 非法 JSON。合法候选的全部来源出现次数得到保留；重放未模拟生产 store、容量、跨轮冲突、提交或 reader。真实啤酒 `16c90bf4`／重复 2／历史 41 的 pilsner/lager 在离线规则中保留，原合并没有保留。这不证明原先未提取的 Luna 已修复，也不证明回答正确率提升。

14 项 Python 回归通过，typecheck、lint、177 个文档路径／链接、959 项双语及 diff 检查通过。全量 test/build 尚未重跑：pretest 会重建原生文件，build 会改写仍运行批次绑定的 dist；用户明确要求结算后再做。第一次 prepare 因把上游对象摘要误当文件字节摘要而拒绝，零模型调用、未创建准备目录；已改用 Node 精确核验 JSON.stringify 摘要。preparation-001 是验证器完善期间的中间产物，保留原状；002 才是最终准备产物。

既有模型进程和收尾分析等待器继续运行；本轮最后一次日志读取显示 504/4500 项已结算，stopReason 为 null，run-state 尚未生成。这只是运行中快照。没有增加自动生产改造进程，原收尾等待器仅负责分析，不会实现或启动新候选。

2026-11-04：当前 Go／DeepSeek Memory 批次 015 仍在运行，编码 pilot 已完成。用户已批准保留失败和全部用量缺口继续未运行项，并进一步批准离线差距分析与完整 harness 分层对标。新阶段报告已交付，不修改生产 Memory、不重试旧失败、不新增模型实验；阶段快照不代表全部问答完成。原始 usage 停止记录见 [历史交接](archive/HANDOFF-2026-11-04-memory-usage-stop.md)。本轮既有 live 批次 task／campaign 上限仍为 null；未授权提交、推送、改展示版本、tag 或 Release。

沿用分支 `codex/source-candidate-evidence-2026-11-01`，HEAD `b30f993`，展示版本 `0.6.0-rc.4`。保留已有 Go、网页与文档改动。此前 Go smoke、历史失败和已知部分用量见 [上一交接](archive/HANDOFF-2026-11-04-go-smoke.md)，不与本轮混为正式对照。

## Memory 差距分析交付

用户批准的分析已实现，报告入口 [Memory 差距分析](benchmark/MEMORY_GAP_ANALYSIS.md)，来源矩阵 `docs/benchmark/memory-comparison-sources.json`。新脚本 `scripts/benchmark/analyze-memory.py` 与离线生产投影 helper 保存在 scripts/benchmark，未进入冻结生产源码摘要；public SDK、provider 和生产 Memory 均未修改。

有效快照 `.cache/memory-analysis/go-flash-native-015/snapshot-005/` 固定公开结果集合于北京时间 13:41:41：450/4500 已结算，4050 未结算。no-memory 151 completed／14 correct；learned-memory 135 completed／14 failed／10 correct；BM25 150 completed／82 correct。主配对 149 组来自 50 个独立问题：Memory 10/149、BM25 82/149；双方成功子集 135 组为 10/135 对 70/135，描述性差异 -44.44 pp，不报告正式区间。共同子集来源覆盖 72/253 对 164/253；Memory active 最大 41、review／归档零，不能把失败首先归因于容量。

138 条 learned 审计记录来自固定种子抽取的 46 个独立问题，六类可用／抽取数量为 6／8／2／10／10／10；三次重复和全部三组均保留。信号包括 65 条 gold Session 提取均为空、1 条已提取的啤酒类型在 merge 丢失、3 条木乃伊数量锚点未保留、14 条基础设施失败、7 条正确、48 条未确定。Luna 三次均未提取；啤酒 repetition2 的候选日志保留 pilsner/lager，但 merge 仅生成食谱规则，active 条目中未保留，不能误称 active 漏召回。AI 审计未人工复核，字面未命中不自动推断语义丢失。

账本在结果固定后的读取区间采样：015 及祖先已知累计 27288546 tokens，独立诊断另计 211；累计已关闭 unknown 为 15，当次账本 pending 为零（不是后续实时保证）。共同成功子集的 Memory／BM25 已知 tokens 为 19646510／310720，含建库与评分，不能外推生产单次查询成本。on/off 编码分别 36/36 passed，tokens 2984099／2705527；首轮验证全通过、diagnosticRounds 全零，工具失败 20／21、同任务重复工具失败均零。混合源码、短合成序列不支持长期生产率结论。

外部 Hindsight 逐题文件保存于 `.cache/memory-analysis/external-source-001/`：500 行、473 correct；压缩 SHA `d0bcc75fb4060f0a395239a353d2066d3f7d252bbe16d674c951d9855deaf9cf` 与发布方 manifest 一致，解压 JSON SHA `186cf0b05a5cbdd8223cea4336d5585a11677f774ddb7c743637c1e9c19a5222`。reader Gemini 3.1 Pro Preview、judge Gemini 2.5 Flash-Lite，平均上下文 43624.5 tokens。500 个 ID 和题面相同不证明历史语料相同。Mastra 宏平均 94.87% 与公开计数重算的微平均 93.6% 分列；其他模型和数据条件缺项保留，开发者材料不标第三方复现。

冻结副本 `replay-005/` 的统计（剔除读取时间）完全相同，cases、投影、全部状态、外部矩阵逐字节一致，`verification-001.json` 留证；覆盖 4500 公开项与 72 编码项。7 个 Python 回归通过，typecheck、lint、176 个文档文件链接、959 项双语与 diff 检查通过。没有重跑全量 test/build：pretest 会重建原生二进制，build 会改写 dist，可能破坏仍运行批次的冻结身份；本轮仅新增分析脚本、测试与文档。前述生产完整门禁仍是历史证据，不能写成此次重新执行。

收尾分析已通过隐藏本机进程启动，PID 29748；记录 `.cache/memory-analysis/go-flash-native-015/follow-completion.json`、stdout `.log` 和 `.err`。它只等待现有批次 run-state，然后用同一脚本产生新目录 `settlement-001/`，不调用模型、不恢复或重试实验。故障停止也生成明确不完整快照。实验继续运行，当前阶段不能宣称全量已完成。

准备过程保留 snapshot-001（首次证据文本目录未创建导致失败、零模型请求），snapshot-002/003/004 为分析器完善中的独立快照；005 与 replay-005 才是本次交付复算对照。每份只读原始实验、独立输出，不覆盖任何旧结果。

## 本轮修复与接续

旧 Session 仅证明最后 usage 为 null，没有原始终态，无法判定旧漏报发生在哪一层，也不能补回该请求消耗。独立诊断两次 streaming、两次 buffered，四次全部计量完整，input/output 148／54，共 202 tokens；证据在 `.cache/go-usage-repair/diagnostic-001/` 与 summary.json，另计于正式实验之外。

Go 专用流边界对未计量终态继续 drain，只接受同 ID／状态后续终态的实际 usage；没有实际计量仍 unknown，不重复 inference。RequestExecutor 保留受限协议 ID、终态和固定 error code，checkout worker 把完整请求账本原子写到隔离 sessionsRoot/request-ledgers。未知用量／服务故障只停新准入，其他在途请求先结算，用户取消同时取消在途。非法评分或已计量 incomplete 样本保留失败并继续。

新增显式 prepare --continue-from：父批次只读并冻结摘要，保留整条四任务链都 verified、独立验收通过且计量完整的结果。当前选择旧批次九条完整链，共 36 项；其余链从初始代码和空 Memory 开始。旧 1 次失败与历史 unknown 不删除，合计消耗持续 incomplete；跨源码身份编码结果只作为合成完成证据。公开 4,500 项全部使用新候选。编码 artifact 改为按链／任务存放，已完成 answer 检查点可直接恢复评分。

012 候选 `.cache/memory-bench/go-flash-native-012/` 已完成编码阶段，包含固定数据与 continuation。009／010 是零模型请求的中间准备候选；009 门禁启动后补齐账本落盘与来源链验证，源码身份已过期，不能用于 live；中断后团队回归持续等待，显式结束该测试，原日志保留 1 项被终止失败，不能算作通过。011 重跑完整门禁时，MCP 重定向测试一次返回通用 HTTP 错误，保留 1439 项／1435 pass／1 fail／3 skip 的原日志，未执行 build 或模型实验。独立本地 HTTP 诊断 300 次未复现；测试改为每个永久策略失败情形使用独立连接，保留全部 45 种组合断言；MCP 15 项定向回归通过。012 再次从 typecheck 开始执行完整门禁。最终候选 typecheck → lint → test → build 全通过，1439 项中 1436 pass／3 个既有 skip／零失败；四门禁耗时约 1.40／0.95／396.37／1.65 秒。十二项 fixture proof 与原生 sandbox 探针通过。sourceDigest `fc4767b716a16701f90b6a1449cde3d2b1523fa50482a3301055758c006c3a88`，buildDigest `b0afd5e5d9dfe071ec685be83e5ff2e60f0208d398c0cff405963ad4078dc0d4`。174 个文档路径／链接及 959 项双语检查通过。

012 真实 smoke 已通过，十次请求均 complete，input/output 3828／534，共 4362 tokens，最大并发 2，评分均合法 yes/no。编码共 72/72 passed、0 failed、0 skipped：保留 008 的完整链 36 项，新跑 36 项全部通过；359 次新请求全部计量完整。新编码 input/output 为 2709310／94365，共 2803675 tokens；408 reasoning 已包含在 output。编码跨源码身份，只作合成闭环完成证据，不推断统一候选的配对效果。

012 于北京时间 08:31:32 以 storage_failed 自动停止，exec session 35586 已退出 1。公开问答实际仅 3 项：no-memory 1 completed（答错）、learned-memory 与 BM25 各 1 infrastructure failed，其余 4497 未开始。Memory merge 的模型请求尚未发出，账本可靠结算 rejected／零消耗，无新增 unknown；首次原子 rename 失败的已 fsync 暂存文件保留。该旧错误未记录底层 code，不能断言当时具体占用来源。公开及 smoke 共 15 次实际请求、1 次拒绝，全部已结算，input/output 12676／1010，共 13686 tokens。012 新阶段共 2817361 tokens；连同 008 已知消耗共 5738736，另加独立诊断 202，已知合计 5738938 tokens，旧 1 次 unknown 仍保留。

独立 Windows 文件锁诊断 `.cache/go-usage-repair/storage-probe-001/` 复现 EPERM／rename；修复后 probe-002 先记录 EPERM，再在锁解除后成功提交同一暂存文件，模型请求数为零。仅对 Windows EPERM／EBUSY／EACCES 作 10／25／50／100／200 ms 有界等待，不删旧证据、不重发模型；永久失败保留操作／错误码，持久化后重新检查取消。新增存储与取消回归通过。

013 的四门禁运行到一半时补齐永久账本故障的 executor 准入锁定与 worker.storageFailed 传播；1439 pass／3 skip／零测试失败，但源码摘要变化被拒绝，零模型请求，不能算作最终候选验证。

当前 `.cache/memory-bench/go-flash-native-014/` 冻结父批次 012，保留全部 72 项 verified 编码结果；新 coding 阶段只引用旧结果，新增模型编码任务为零。RequestExecutor 将持久化故障转为 PersistenceError，拒绝该 executor 后续请求；无论故障发生于 provider 前后都不重发，已知计量仍保留，worker 独立传播 storageFailed。新增定向回归通过。

014 typecheck → lint → test → build 全通过，1444 项中 1441 pass／3 个既有 skip／零失败；四门禁耗时约 1.42／0.90／394.90／1.54 秒。十二项 fixture proof 和原生 sandbox 探针通过。sourceDigest `475887b7ebbd0d3dbd80879c33bab0992f7248e7dfa5f401f0172c05e48929d0`，buildDigest `6094f9c88182d102f63220127a0dc09531428a5d0c2ee2aba4e3413dc54b1661`。014 的十次真实 smoke 均计量完整，共 4377 tokens、最大并发 2、评分合法；coding/live-result.json 引用全部 72 项通过结果，新增编码 attempts／tokens 均为零。

014 全量公开问答于北京时间约 08:54:49 启动，09:14:45 以 service_error 自动停止；统一 exec session 75263 已退出 1。全部在途请求已结算，无 pending。公开清单最终为 56/4500 completed、2 infrastructure failed、4442 skipped，自动评分正确 14 项。两条故障同属问题 031748ae 的 learned-memory：repetition2／history34 提取约 6.37 秒后失败，repetition1／history43 合并约 60.04 秒后失败；两条均为 transport_failure／usage null，不是已成功响应的 usage 解析遗漏。底层 HTTP 状态未被当时账本保存，不能断言具体服务代码或原始原因。

014 共 1282 次模型请求，其中 1280 计量完整、2 次 unknown；input/output 为 2825860／75639，共 2901499 tokens，reasoning 为零，观察到 cache 输入 1726464。新 storage 修复后未再遇到存储／清理／隔离失败，实际峰值并发 2。report.json／report.md／campaign-usage.json 已自动生成最终不完整报告，包含完整 4500 个公开计划项与 72 个编码计划项；主／次比较正式区间均为 null，不声称 Memory 有效。未人工复核。

独立诊断 `.cache/go-usage-repair/diagnostic-002/` 在约 09:19 完成：Go 模型列表 HTTP 200、包含冻结模型；唯一一条新的合成小请求约 1.22 秒成功，input/output 8／1，共 9 tokens，计量完整，清理完成。没有重发任何失败样本。本轮两次独立诊断合计 211 tokens；014 及全部历史 campaign 已知 8640235，含诊断总计已知 8640446 tokens，累计 3 次未知用量（008 一次、014 两次），不能作为完整账单。

普通 resume 按冻结协议继续禁止：unknown 不清零、不自动重试。已准备 `.cache/go-usage-repair/continuation-proposal-001.json`，核对 56 completed＋2 failed＋4442 remaining＝4500，保留父证据 SHA-256 和原调度顺序，编码无需重跑。草案请求允许服务故障结算后保留全部缺口与失败，只继续未运行项，正式区间继续禁用；鉴权、存储、清理、隔离与身份故障仍需停止。用户已明确选择“允许按新规则继续剩余项”，允许修改严格停止规则；新候选仅继续 4442 项，保留 56 completed 和 2 failed，编码保留 72 项通过。新规则不清除历史 unknown、不重试失败，正式区间固定禁用；新候选尚待最终门禁和 live。旧 012 的 3 项公开结果及旧 unknown 都保留原目录。

新增获批接续候选 `.cache/memory-bench/go-flash-native-015/`：冻结 `continue-unrun` 策略，保留父公开 56 completed／2 failed、72 项编码通过，仅执行剩余 4442 项；四门禁 typecheck → lint → test → build 全通过，耗时约 1.42／0.93／358.71／1.54 秒。1452 项测试中 1449 pass、3 个既有 skip、零失败；fixture proof 与原生 sandbox 探针通过。sourceDigest `eb972c8da229a10cc7d4384451b63a042b12e7848a675b66ea921e058a2aea7a`，buildDigest `24832ffbe27968433eaa7ac0b034a7c68ebe73961bd618af6566c2609731327e`。真实 smoke 十次均 complete，input/output 3809／515，共 4324 tokens、峰值并发二；编码 72 项结果全部保留，新增编码请求为零。北京时间约 11:05，公开累计 63 项结算（61 completed／2 个原 failed），剩余 4437；新增请求 24 条，其中两条当时在途，已知新增 15096 tokens，含诊断及历史累计已知 8655542、累计 unknown 仍为 3。该数字是运行中快照，不是最终消耗。进程 exec session 35397 仍运行，live.log 保留调度；状态脚本 `.cache/go-usage-repair/status-continuation.mjs` 只读采样，report 命令不调用模型，最终会由 runner 自动生成报告。继承场景没有新编码流水时，冻结文件缺席并核对所有结果均来自已验证链，禁止以后补写改变证据。

015 后续运行快照（北京时间约 11:12）：公开 81/4500 已结算，79 completed／2 个原 failed，剩余 4419；编码 72/72 passed。当前 441 条新请求检查点中两条在途，新增已知 input/output 945215／30751，共 975966 tokens；含历史与独立诊断累计已知 9616412，已结算 unknown 仍为 3、没有新增服务 pause。实验仍运行，不能声称已完成。运行中 report 的 unknownRequests 同时列出 pending；永久用量缺口应按已 settled 且 usage incomplete 区分，最终报告需等全部在途结算。新文档／diff 检查及 174 文件链接、959 项双语检查通过。

## 实现与配置

新增 `pnpm benchmark:memory-batch` 的 prepare／preflight／run／resume／report，协议见 [Memory 批量评测](benchmark/MEMORY_BATCH.md)。公开 adapter 复用生产内部提取／候选整理，独立 store 不创建虚假 verified job。生产验证准入、epoch、租约和提交检查保持原边界。

固定 Go 地址 `https://opencode.ai/inference/go/openai/v1`，原始模型 `deepseek-v4.1-flash`，登记 ID `9e850e73-381d-42ef-b89f-193f931c4442`，显式 deepseek profile。Key 仅由 AuthStorage／系统 keyring 读取，不写入配置、命令或日志。主任务 high、输出 32,768；Memory 保留生产 800／关闭推理，评分关闭推理／输出 16。

LongMemEval-S cleaned 全量 500 题，三组各三次，共 4,500 个问答计划项；learned-memory 构建独立重复，不按分数调整策略。原始文件 277,383,467 字节，SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`。六类分布为 70／56／30／133／78／133（用户／助手／偏好／时间／更新／跨会话）。共 23,867 个历史 Session，三次构建对应 71,601 次提取，合并另计。13 个题目的历史 ID 有重复，保留原记录，用历史序号隔离并映射回来源。

代码 pilot 保留三个四任务序列、on/off 各三次，共 72 项。新 Session 保留同链代码及允许的 Memory；显式关闭个人 Skills、LSP、Session 历史，MCP／网页关闭。仅宿主验证与外部验收同时通过才捕获，零空闲延迟属于评测设置。

## 父批次验证与停止记录

最终候选 `.cache/memory-bench/go-flash-native-008/` 已取得 `preflight.json` 与 `preflight.sha256`。typecheck → lint → test → build 全通过，耗时约 1.39／0.89／332.98／1.52 秒。全量 1432 项中 1429 pass、3 个既有平台／环境 skip，零失败／取消。十二项 fixture proof 和生产原生 sandbox 探针也通过。执行身份 sourceDigest `8e93638e47872e9ed54e16f4ff1039a6152d89fbcbe1b4df3a216ced94e3b63a`，buildDigest `7fb2272a09a27f2934ae64f5d18c278234687aa26f979c6bb9bb7300a33641e1`。后续执行持续核对该身份。

真实合成 smoke 已通过，最大并发为 2；10 次请求全部计量完整，共 4447 input+output tokens，其中提取 2、合并 4、回答 2、评分 2。未使用公开评分题调参。编码 pilot 实际执行 37/72 项，36 passed、1 failed，其余 35 项因 usage_unknown 跳过。on 已执行 20 项且全部通过，off 已执行 17 项、16 通过；两组不完整且未配齐，不能据此判定 Memory 收益。公开问答为 0/4500，未启动。

失败点为 numeric-policy／repetition2／off／stage1，开始于 01:43:19，约 27.9 秒后停止。该任务六次模型请求中一次 `coding:missing_usage`，Session 最后一次 `usage_recorded` 为 null；runner 终态 stopped／usage_limited，计量 incomplete，功能验收未完成。pilot 的真实停止原因是 usage_unknown；顶层 run-state 只保存通用 Error，须结合 coding/live-result.json 和 coding-live.log 定位。没有检测到清理、存储或隔离故障；记录的工具调用失败共 18 次，请求重试和流恢复均为零。

已知用量：编码 input/output 为 2828043／88885，共 2916928；smoke 为 3859／588，共 4447。本轮合计已知 input/output 为 2831902／89473，共 2921375 tokens，另有一次请求用量未知，因此不是完整消耗或账单。共 382 次模型请求（编码 372、smoke 10），其中 381 次计量完整。编码记录中的 733 reasoning tokens 已包含在 output，不重复相加。详见 campaign-usage.json、coding/live-result.json、report.json；原始记录保留，不自动重发未知用量请求。统一 exec session 23595 已退出，退出码为 1。

新定向回归覆盖标签隔离、并发二、未知／未决请求禁止恢复、已结算响应重用、已知失败重试、裁剪与冲突 review；既有 Memory hardening／恢复回归也通过。此前全量候选分别 1429/1430/1431 项，均零失败、三个既有平台／环境 skip；它们不代替当前最终候选的门禁。日志保留在 `.cache/memory-implementation/` 及各候选的 `gate-*.log`。

准备／诊断历史全部零模型请求：001 有目录与连接错误；002 的解析器错误拒绝上游重复历史 ID；003 保存固定数据缓存；004 在 live 前被新实现取代；005 的预检托管器锁住 pretest 的编译目标，已改为宿主开发检查启动；006 检查通过但源码身份过期而拒绝；007 源码一致、全部检查通过，但准备构建与最终构建摘要不同而拒绝。原记录保留。008 将门禁后的实际构建冻结为执行身份，同时拒绝任何源码变化，不修改原 manifest；preflight 收据另存 hash，所有真实请求前先核对它。

文档路径／链接和 959 项双语文案检查通过。实际运行后应补充本交接的最终门禁、smoke、编码与公开问答状态；结果完整性和 Memory 效果分别判断，不因实验启动就记为成功。
