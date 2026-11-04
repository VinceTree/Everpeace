# 当前交接

2026-11-04：Go／DeepSeek Memory 批量评测在北京时间 01:43:47 因一次编码请求缺少 usage 自动停止，当前没有运行进程。用户已授权本轮真实实验，task／campaign token 上限显式 null；unknown 停止及禁止恢复规则继续生效。未授权提交、推送、修改展示版本、tag 或 Release。

沿用分支 `codex/source-candidate-evidence-2026-11-01`，HEAD `b30f993`，展示版本 `0.6.0-rc.4`。保留已有 Go、网页与文档改动。此前 Go smoke、历史失败和已知部分用量见 [上一交接](HANDOFF-2026-11-04-go-smoke.md)，不与本轮混为正式对照。

## 实现与配置

新增 `pnpm benchmark:memory-batch` 的 prepare／preflight／run／resume／report，协议见 [Memory 批量评测](../benchmark/MEMORY_BATCH.md)。公开 adapter 复用生产内部提取／候选整理，独立 store 不创建虚假 verified job。生产验证准入、epoch、租约和提交检查保持原边界。

固定 Go 地址 `https://opencode.ai/inference/go/openai/v1`，原始模型 `deepseek-v4.1-flash`，登记 ID `9e850e73-381d-42ef-b89f-193f931c4442`，显式 deepseek profile。Key 仅由 AuthStorage／系统 keyring 读取，不写入配置、命令或日志。主任务 high、输出 32,768；Memory 保留生产 800／关闭推理，评分关闭推理／输出 16。

LongMemEval-S cleaned 全量 500 题，三组各三次，共 4,500 个问答计划项；learned-memory 构建独立重复，不按分数调整策略。原始文件 277,383,467 字节，SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`。六类分布为 70／56／30／133／78／133（用户／助手／偏好／时间／更新／跨会话）。共 23,867 个历史 Session，三次构建对应 71,601 次提取，合并另计。13 个题目的历史 ID 有重复，保留原记录，用历史序号隔离并映射回来源。

代码 pilot 保留三个四任务序列、on/off 各三次，共 72 项。新 Session 保留同链代码及允许的 Memory；显式关闭个人 Skills、LSP、Session 历史，MCP／网页关闭。仅宿主验证与外部验收同时通过才捕获，零空闲延迟属于评测设置。

## 当前验证状态

最终候选 `.cache/memory-bench/go-flash-native-008/` 已取得 `preflight.json` 与 `preflight.sha256`。typecheck → lint → test → build 全通过，耗时约 1.39／0.89／332.98／1.52 秒。全量 1432 项中 1429 pass、3 个既有平台／环境 skip，零失败／取消。十二项 fixture proof 和生产原生 sandbox 探针也通过。执行身份 sourceDigest `8e93638e47872e9ed54e16f4ff1039a6152d89fbcbe1b4df3a216ced94e3b63a`，buildDigest `7fb2272a09a27f2934ae64f5d18c278234687aa26f979c6bb9bb7300a33641e1`。后续执行持续核对该身份。

真实合成 smoke 已通过，最大并发为 2；10 次请求全部计量完整，共 4447 input+output tokens，其中提取 2、合并 4、回答 2、评分 2。未使用公开评分题调参。编码 pilot 实际执行 37/72 项，36 passed、1 failed，其余 35 项因 usage_unknown 跳过。on 已执行 20 项且全部通过，off 已执行 17 项、16 通过；两组不完整且未配齐，不能据此判定 Memory 收益。公开问答为 0/4500，未启动。

失败点为 numeric-policy／repetition2／off／stage1，开始于 01:43:19，约 27.9 秒后停止。该任务六次模型请求中一次 `coding:missing_usage`，Session 最后一次 `usage_recorded` 为 null；runner 终态 stopped／usage_limited，计量 incomplete，功能验收未完成。pilot 的真实停止原因是 usage_unknown；顶层 run-state 只保存通用 Error，须结合 coding/live-result.json 和 coding-live.log 定位。没有检测到清理、存储或隔离故障；记录的工具调用失败共 18 次，请求重试和流恢复均为零。

已知用量：编码 input/output 为 2828043／88885，共 2916928；smoke 为 3859／588，共 4447。本轮合计已知 input/output 为 2831902／89473，共 2921375 tokens，另有一次请求用量未知，因此不是完整消耗或账单。共 382 次模型请求（编码 372、smoke 10），其中 381 次计量完整。编码记录中的 733 reasoning tokens 已包含在 output，不重复相加。详见 campaign-usage.json、coding/live-result.json、report.json；原始记录保留，不自动重发未知用量请求。统一 exec session 23595 已退出，退出码为 1。

新定向回归覆盖标签隔离、并发二、未知／未决请求禁止恢复、已结算响应重用、已知失败重试、裁剪与冲突 review；既有 Memory hardening／恢复回归也通过。此前全量候选分别 1429/1430/1431 项，均零失败、三个既有平台／环境 skip；它们不代替当前最终候选的门禁。日志保留在 `.cache/memory-implementation/` 及各候选的 `gate-*.log`。

准备／诊断历史全部零模型请求：001 有目录与连接错误；002 的解析器错误拒绝上游重复历史 ID；003 保存固定数据缓存；004 在 live 前被新实现取代；005 的预检托管器锁住 pretest 的编译目标，已改为宿主开发检查启动；006 检查通过但源码身份过期而拒绝；007 源码一致、全部检查通过，但准备构建与最终构建摘要不同而拒绝。原记录保留。008 将门禁后的实际构建冻结为执行身份，同时拒绝任何源码变化，不修改原 manifest；preflight 收据另存 hash，所有真实请求前先核对它。

文档路径／链接和 959 项双语文案检查通过。实际运行后应补充本交接的最终门禁、smoke、编码与公开问答状态；结果完整性和 Memory 效果分别判断，不因实验启动就记为成功。
