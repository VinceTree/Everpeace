# 当前交接

## 2026-11-04：Go Flash 全功能测试

用户要求把其余测试跑一遍，task／campaign token 阈值继续显式为 null。当前功能覆盖 23 项，最新一次均通过：十四类工具验收，Session 恢复与 fork，手动／自动压缩，主动取消、steering，手动／自动 Memory，标题与 Skill 生成，以及两个真实 worker 的隔离、验证、整合和根验证。合成宿主的授权／回答不作为人工 TUI 验收；不属于正式质量或节省比较。

主 Agent 显式 deepseek/high、32,768 输出上限；压缩、Memory、title／Skill 保留生产用途参数，总量不限额不改变每请求输出约束。自动压缩由声明的 context pressure fixture 触发，确认真实摘要请求、checkpoint 持久化及原 marker／约束召回，不代表真实满窗长上下文质量。

首轮工具为 12/14；历史读取因 fixture 给隐私授权问题返回无效答案而拒绝原文，网页则暴露 Bing 编码点击链接未解析及评分器只认可旧 IANA 路径的问题。已修复目标 URL 解析，严格限制已知 HTTPS Bing host／route，验证编码及最终 URL，保留实际连接的公网检查；补充三项回归及双语 README／网络文档。新目录历史读取及网页复测均通过，网页沿真实发现链读取官方 reserved 页面并正确引用。团队首轮非交互宿主需要成员命令审批而停止；复测仅授权合成工作区补丁及精确 pnpm 检查命令，两名 worker 与根各自四项检查通过，受保护脚本字节不变，整合与清理完成。

本次扩展保留 26 次功能执行，包括原 history／web／team 三次失败；合计 118 次真实请求，已知 input/output 782,208/28,530，共 810,738 tokens。主动取消有一次预期 unknown，功能断言验证该账本拒绝继续准入、资源已收束；不能把该请求记为零费用。全阶段清理失败为零。连同此前基础 smoke 和诊断共有 138 次请求，三次历史／取消 unknown；906,690 仅为已知 tokens，不是完整账单。摘要与逐阶段身份见 `.cache/opencode-go-all-2026-11-04/summary.json`，早期完整明细仍在下文，不清除失败分母。

运行中检测到另一个聊天新增 `src/benchmark/memory-*` 并修改 Memory。用户确认仍在开发，要求优先完成 ds-flash 功能测试。原工作树门禁均退出成功（1421 项中 1418 pass、3 个既有 skip），但期间身份变化，不作为最终工作树证据。原 runtime 在后续 Memory 请求前被源码身份检查停止；初次工具复测又在网页请求前因门禁重建原生产物而停止，两处均零新增请求，原 plan／日志保留。后续使用 HEAD `b30f993` 加本轮 Go／网页 overlay 的隔离副本，不包含并行 Memory 改动；副本及十四个 overlay 哈希索引在同目录 `snapshot.json`。历史、网页、Memory 及团队分别以新根重新冻结，不修改旧 plan。

隔离副本最终 typecheck → lint → test → build 全通过，1421 项中 1418 pass、3 个既有 skip、0 fail。跳过为无文件 symlink 权限、Windows 临时目录 alias 由 clean-checkout CI 覆盖，以及 Unix 超时子进程场景。最终 sourceDigest `41af77e8201890c63c8f1be85ae2e500aa8cb20cefdc55444e19fd9ff2ee1f74` 与最后网页复测候选一致，收据 `final-evidence.json`、`snapshot-gates.json` 和 `snapshot-gate-*.log` 均在上述忽略目录。最终检查时主工作树的 benchmark production 及双语 README 已有并行变更，因此这些结果始终只绑定隔离副本。

UI 文案、CI workflow、原生文件字节冲突读写及进程树清理 smoke、公开文档路径／链接与 diff 检查均通过。118 次扩展请求与 HTTP 观测逐项一一对应，全部 HTTP 200；这不消除主动取消的用量缺口。没有提交、推送、改展示版本或创建 Release。下文是此前基础 smoke 的独立历史记录，代码身份及门禁不得当作并行开发后当前工作树的证据。

## 此前基础 smoke

2026-11-04：OpenCode Go Flash 已跑通基础 Responses、连续读取及一个真实模型编码 smoke。用户最新指示为「token 阈值先解除，先跑通，再看是否节省」：本轮后续 task／campaign token 阈值显式为 `null`，保留计量、unknown 停止、十五分钟任务超时、取消和清理；每请求输出保持生产默认 32,768，不当作总量预算。尚无节省或正式质量对照。

沿用分支 `codex/source-candidate-evidence-2026-11-01`、HEAD `b30f993`，展示版本仍为 `0.6.0-rc.4`；保留上一轮 Go 接入的全部工作树改动。该基础 smoke 阶段只新增忽略目录中的实验材料和文档，未改产品源码、提交、推送、tag 或 Release；后续网页修复与扩展测试见上文。此前接入及区域诊断完整记录见 [归档](HANDOFF-2026-11-03-opencode-go.md)。

## 实测配置

原始 ID `deepseek-v4.1-flash`，地址 `https://opencode.ai/inference/go/openai/v1`，登记 ID `9e850e73-381d-42ef-b89f-193f931c4442`。Key 仅由 AuthStorage／系统 keyring 读取，未重新保存或写入命令、日志、Session、JSON。用户已启用 Global，后续请求成功。

测试显式 `deepseek` profile／`high`，不修改日常登记的保守默认能力。关闭个人 Skills、MCP、Memory、LSP、网页，仅使用新建合成工作区。编码 shell 和宿主检查使用生产 Windows 原生 sandbox、禁用网络，无宿主直跑回退。Go 返回推理摘要，不能称为完整内部推理或完整 DeepSeek 官方 Responses 契约通过。

## 阶段与结果

不同验收标准及阶段独立；后续通过不清除原失败、unknown 或 skipped，不替换失败分母。各根的本地索引在下表所列目录，根内保存 plan、验收器摘要、Session、账本和结果。

| 阶段 | 结果 | 索引／日志 |
| --- | --- | --- |
| 初始兼容 | 文本一次请求失败、usage unknown，读取项 skipped | `.cache/opencode-go-2026-11-03/compat-root.json`、`compat-live.log` |
| 独立诊断 | 一次 HTTP 400，区域／隐私提示，usage unknown；不是评分项 | 同目录 `diagnostic-root.json`、`diagnostic.log` |
| Global 后原标准 | 文本通过；两次真实 read 及 marker 回答完成，但读取项 13,936 tokens 超过原 10,000 阈值，整项失败。四次 HTTP 200、总计 18,225 tokens，计量完整 | 同目录 `compat-global-root.json`、`global-live.log` |
| 摘要验收初稿 | 文本通过；读取项因验收器错误要求每个读取轮次均有推理而失败。实际首轮无推理，后续才有摘要；四次 HTTP 200、18,333 tokens，计量完整 | 同目录 `compat-responses-root.json`、`responses-live.log` |
| 无阈值 Go 验收 | 文本、两轮读取、实际推理项保存与回传均通过；四次 HTTP 200、18,300 tokens，计量完整 | `.cache/opencode-go-2026-11-04/compat-root.json`、`live.log` |
| 编码 smoke | 修复、原生沙箱四门禁、独立功能验收通过；六次 HTTP 200、41,094 tokens，计量完整 | 同目录 `coding-ready-root.json`、`coding-live.log` |

摘要初稿是本地验收器假设错误，不记为服务端故障。后续新验收只检查服务实际提供的项，不要求每轮提供推理，不将摘要通过改记为原 `reasoning.content.reasoning_text` 标准通过。新 helper 在 live 前通过 dense full-content 和 sparse summary 两组离线回归，后者覆盖首轮无推理、第二轮和最终回复才提供摘要。原验收器及失败目录均保留。

最初编码离线准备遗漏 `runBenchmarkVerification` 的 signal 参数而失败，零模型请求；修正实验 helper 后使用新目录准备，旧 `coding-root.json` 和 `coding-prepare.log` 保留，不计为真实模型失败或有效 seed proof。

## 已通过的闭环

Go 验收入口 `.cache/opencode-go-2026-11-04/go-compat.ts`，digest `2ee3c0957af98769479231d4c04c70357ce70b6266bc0c3978f0e86e089299a6`。文本一次请求，input/output 4,284/2，约 6.45 秒；读取三次请求，input/output 13,670/344，约 8.74 秒。两次 read 均成功、调用结果配对，正确报告随机隐藏 marker，文件字节不变。输入推理项数 `[0,0,1]`，一次实际回传经过原对象深比较验证；所有实际返回的非空项完整持久化。该阶段进程约 16.88 秒，正常清理。

编码入口同目录 `coding-smoke.ts`，冻结摘要及材料哈希在 plan。准备器只复制本机已安装的 TypeScript 5.9.3，无下载；证明参考修复检查通过、seed 因预期行为断言失败，并先通过真实原生沙箱探针。模型修复 clamp 的下界裁剪和反向边界校验，只修改 `src/clamp.ts`；package、tsconfig、测试、lint 和完整工具链哈希不变。

生产 runner 最终 `completed`／`verified`，typecheck → lint → test → build 全通过，独立 evaluator 校验负数、等值边界、区间内外值及 RangeError。零诊断修复轮、工具失败、重试、流恢复及清理失败；六次模型请求、九次工具调用，input/output 39,810/1,284，runner 约 46.31 秒。审批由声明的合成 benchmark 宿主策略提供，不当作人工交互证据。补丁 `repair.patch`、检查结果、HTTP 状态和逐次用量均保留。

全流程真实请求共 20 次，最早两次用量仍 unknown；已知 input/output 93,583/2,369，95,952 仅为已知部分，不是完整费用。最后两个无阈值成功阶段共十次请求、59,394 tokens，计量完整，但不消除历史 unknown。汇总 `.cache/opencode-go-2026-11-04/summary.json` 保留所有阶段及验收差异，不做成本或成功率排名。

## 代码身份与后续

本轮前后 904 份产品源码、测试、脚本、原生、manifest／lock 输入与先前四门禁候选完全一致，SHA-256 `157eeb20df47398844af0de9e19e833d66aa9776019e65a0172ac83b794be29d`，收据 `.cache/opencode-go-2026-11-04/identity.json`。同一源码先前 typecheck／lint／test／build 全通过，1418 项中 1415 pass、3 个既有 skip，日志保留在前一天目录。本轮只新增实验材料及文档，不重复无关产品门禁；更新后单独复核公开文档路径／链接和 diff。

「先跑通」已有小范围功能证据。尚无正式多任务 benchmark、节省对照、独立重复或完整历史账单。后续衡量节省时应冻结相同任务、参数、评分及对照臂，计入失败消耗，不能用本轮调试重跑或不同缓存状态直接推断收益。用户解除 token 阈值的指示适用于本轮测试，计量、超时、取消和 unknown 停止继续保留。
