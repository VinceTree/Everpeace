# DeepSeek Memory 批量评测

本协议比较当前 learned-memory、无记忆与 BM25 原文检索。公开部分使用无工具 reader，测提取、整理与 snapshot 召回；编码部分使用生产 runner 与独立验收。结果标注 Go／DeepSeek 适配评测，不与其他模型或官方 GPT-4o 评分直接排名。

## 设置与入口

Go `deepseek-v4.1-flash`，显式 deepseek profile；回答／编码 high、输出 32,768。cleaned LongMemEval-S 全部 500 题，三组各三次，共 4,500 项，learned-memory 独立构建 1,500 次；另跑 72 项串行编码 pilot。公开请求最多并发二，种子 16716，task/campaign budget 均为 null，保留全部辅助与失败计量。没有核对价格时只报告 token。

数据 revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`；评分提示 revision `9e0b455f4ef0e2ab8f2e582289761153549043fc`。prepare 校验结构并保存原文件、MIT 许可、SHA-256、类别、题目与冻结执行顺序。

在 build 后选取不存在的新绝对证据目录：

```powershell
pnpm benchmark:memory-batch prepare C:\absolute\evidence-root
pnpm benchmark:memory-batch preflight C:\absolute\evidence-root
pnpm benchmark:memory-batch run C:\absolute\evidence-root --live
pnpm benchmark:memory-batch resume C:\absolute\evidence-root --live
pnpm benchmark:memory-batch report C:\absolute\evidence-root
```

preflight 不取凭据，串行执行 typecheck、lint、test、build，首败停止，随后证明编码 fixture。run/resume 需要用户已授权 live；凭据仅从系统 keyring 读取。顺序为独立合成 smoke、编码 pilot、全量问答。普通答错继续；运行、服务、存储、清理、隔离异常停止新请求，等待结算并保留证据。

prepare 记录准备身份；preflight 在四门禁完成后将实际构建冻结到独立收据，并保存收据 hash。源码、revision、Node 与入口必须仍匹配准备身份。run/resume 和运行中的复查使用该验证后的构建身份，不修改原 manifest。

请求检查点在 provider 准入前持久化。可靠结算的响应可重用，未知或未决请求禁止续跑；恢复核对源码／构建、数据、提示和 manifest。修改实现必须建立新根，不覆盖失败。编码任务有单独的 pending 标记，进程中断的未决任务不重放。

用户明确要求修复后继续时，可创建有来源链的新批次：

```powershell
pnpm benchmark:memory-batch prepare C:\absolute\new-root --data-cache C:\absolute\old-root --continue-from C:\absolute\old-root
pnpm benchmark:memory-batch preflight C:\absolute\new-root
pnpm benchmark:memory-batch run C:\absolute\new-root --live
```

`--continue-from` 仅接受已停止且没有未决请求／任务的父批次。冻结父 manifest、验证收据、计划、逐项结果、用量与停止记录的 SHA-256；模型／数据配置和编码验收器必须一致。只保留整条四任务链均 verified、独立验收通过且计量完整的结果；未完成链从空 Memory 和初始代码重新运行，父批次的失败尝试不删除。普通 resume 的 unknown 禁止规则不变，新进程不能清空旧缺口。

默认来源链的新批次公开问答全部使用新冻结候选。编码完成状态可引用保留链，但报告标注跨源码身份，不能当作统一候选的配对效果。新阶段计量与父批次计量分别列出；父批次有 unknown 时，合计永远标记 incomplete。诊断请求保存在独立目录，另计消耗。编码 artifact 按链和任务存放，避免后续任务覆盖。

Go 流式响应若在缺少合法 usage 的终态之后还有同一响应 ID／状态的计量终态，provider 延迟交付并合入实际 usage；正常完整终态立即交付。没有实际计量时保持 unknown，不能改用估算、零值或重复 inference。请求账本保存受限协议 ID、状态和错误 code，禁止正文／headers／供应商错误消息。usage／服务故障关闭新准入，等待在途结算；用户取消同时取消在途请求。非法 yes/no 和已计量的 incomplete 样本保留失败并继续其他样本。

Windows 检查点使用同一份已 fsync 的暂存文件原子替换；仅对 `EPERM/EBUSY/EACCES` 的共享占用作 10／25／50／100／200 ms 有界等待，禁止删除原文件再写入。其他错误或等待耗尽立即停止，并保存操作阶段和固定错误码。该恢复只重试文件替换，不重新调用模型；检查点等待期间取消会在 provider 启动前被拒绝，计为零消耗。旧 storage_failed 批次仍不允许普通 resume，修复源码后建立新来源链候选。

永久账本故障同时锁定 RequestExecutor 准入，并以 PersistenceError 传播，不能被采样恢复重试吞掉。已经返回的可靠计量仍保留；独立 checkout worker 额外传播 storageFailed，父 pilot 关闭整批准入。

## 获批的未运行项继续规则

用户已明确批准本次协议变更。新目录的 prepare 可追加 `--continue-from <已停止目录> --continue-unrun`；该标志冻结在 manifest，普通入口仍采用严格停止规则。该模式同时保留父批次全部 completed／failed 公开结果及逐请求账本摘要，校验原调度顺序、模型与数据身份，保存每条结果的原始源码身份。只执行没有终态检查点的项目，不重试失败请求或失败样本；编码保留规则仍是整条 verified 链。

```powershell
pnpm benchmark:memory-batch prepare C:\absolute\new-root --data-cache C:\absolute\old-root --continue-from C:\absolute\old-root --continue-unrun
```

公开样本共享最多两个在途请求。服务／传输失败或 usage 缺失关闭该样本，等待全部在途请求结算且冷却结束，再继续独立未运行项；冷却从 60 秒指数增加到最多 15 分钟，并尊重受限 Retry-After。只记录固定 HTTP 状态、错误类别与白名单 code，不保存供应商错误正文或 headers。鉴权、余额、能力配置、存储、清理、隔离、身份或未决请求错误仍停止整批；用户取消中断在途请求。

恢复仍拒绝 pending、openRequests 非零及没有终态检查点的 unknown。只有该模式、请求已可靠关闭且对应样本保留为 failed 时，才允许跳过该失败继续。所有历史未知消耗持续累计，合计计量永远 incomplete；后续成功不消除缺口。report 分开保存 executionComplete 与正式完整性，此模式固定禁用正式置信区间和明确质量提升声明。各组公开成本包含保留请求，campaign 总量只把祖先总量加一次。独立诊断仍另计。

## 数据边界

重新准备候选时可在 prepare 追加 `--data-cache <旧准备目录>`，复用已下载的固定数据；读取前核对下载 URL、revision 与原始文件 SHA-256，评分器仍取固定上游 revision。原准备目录保持原样。

构建阶段仅接收日期、来源 ID、角色和正文；问题、答案、has_answer 不进入提取。隔离 adapter 复用生产内部管线，不生成虚假 verified job、工具调用或人工复核。保留生产提示、24,000 字符 transcript 裁剪、三条候选、100 条 active、8,000 字符召回、冲突 review 和脱敏规则。历史日期作为内容保存，条目时间使用导入时间。

BM25 使用 Unicode 小写词项、512 词片段和 64 词重叠，k1=1.2、b=0.75；前 20 个候选按完整片段装入 8,000 字符。每个题目／重复／组别独立存储，不共享模型生成记忆。三个 reader 提示相同，无文件、网页或 Session 历史工具。

编码任务各自新建 Session，on 组保留同链 Memory，两组均保留同链代码；仅宿主验证与独立 acceptance 同时通过才捕获。零空闲延迟是评测设置。前序失败保留后续 skipped，三个合成序列不证明真实长期编码生产率。

## 报告

report.json 保留所有公开和编码计划项的结果／skipped、构建／回答／评分消耗、失败、召回覆盖、条目状态、裁剪和延迟。reasoning 不重复加入 output，cache 缺失保留 null。report.md 提供摘要。blind-review.json 按类别导出最多 60 条盲审样本，未有人工记录时标注未人工复核。

主比较 learned-memory 对 BM25，次比较对无记忆。按相同历史聚类保留三次重复，固定种子进行 2,000 次配对 bootstrap；数据、评分或用量不完整时不生成正式区间。下界大于零才描述本设置中有明确质量提升。完整运行与有效提升分别判断。实际执行和验证证据只在 HANDOFF 维护。
