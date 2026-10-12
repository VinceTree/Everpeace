# 当前交接

更新日期：2026-10-09。先读 [AGENTS](../../AGENTS.md)，按 [索引](../README.md) 定位。

## 当前范围与授权

用户本轮明确选择 **0.4.1**，已同步 package.json 与双语 README；单 Agent、Responses 与现有 TUI/exec/SDK 公共入口不变。沿用提交、推送授权；提交包含 `[skip publish]`，不使用 `[skip ci]`，不创建 tag、Release 或发布 npm。本轮只更新展示元数据并核算官方测试费用，没有取得独立 DeepSeek live 阶段授权，付费请求为零。

当前交付本地根：`C:\Users\39850\Desktop\Everpeace-test-report-0.4.1\metadata-update-ae0b55f9fa774c43a4e611ccc98563fb`。上一实现提交为 `12ea59c29cc3ead6f87cf2c9ad7ec6511521d04a`，其 Windows/Linux CI 已通过。本轮最终提交与重新绑定的候选以新根的 `delivery-receipt.json`、`prepared-ci-fix/` 为准；旧 source digest 因 manifest 更新而过期，旧报告保留。

本轮首次元数据提交 `85e08e05cfdba01c8dba87a650e6619ccc64940e` 的 Windows CI 通过，Linux 在真实取消验收中遇到 procfs ESRCH 竞态。测试现同时接受进程读取期间消失的 ENOENT/ESRCH，仍拒绝其他错误和存活状态；未改生产清理或放宽安全边界。原 CI 失败记录在本地保留，后续准确提交 CI 以交付收据为准。package 修改触发的 Release workflow 已实际 skipped，tag/Release 无变化。

原始报告继续本地保存。README 保留既有 Grok 汇总图及明确范围，本轮只同步 profile 设置说明，不增加 DeepSeek 质量或成本宣称。本地报告根：`C:\Users\39850\Desktop\Everpeace-test-report-0.4.0\deepseek-loop-final-2001540786224eafb9e2b881d7008a49`。前次交接保存在该根的 `handoff-before.md`。

保留原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`；不纳入提交。工作起点为 `68ecccb6bc42d4a805e5099024b01327396e6030`，原始源码归档位于本地 `original-0.4.0.zip`。最终提交及 source/build/harness/evaluation digest 以本地 `delivery-receipt.json` 和提交后重新生成的 `prepared-final/` 为准，不复用修改前的候选身份。

## 本轮实现

- Provider 指令投影集中到 `request-projection`：DeepSeek 的稳定 instructions 与最新 system 宿主状态分开；generic 保守，官方 OpenAI 保持缓存布局，不改写历史。
- 模型注册与 Session 增量支持 `responses_profile: auto|generic|deepseek`。未知中转不按模型名推断能力；显式 deepseek 标为 configured，保留真实 provider 身份。profile 绑定注册、地址、原始模型 ID；修改清除旧请求设置，恢复不覆盖当前注册。密钥仍由 AuthStorage/keyring 管理。
- `/model profile` 仅空闲可改，保留兼容 context 和累计 unknown、使 Plan 批准失效并重建 Agent；旧 opaque context 与目标 profile 不兼容时，在请求资源创建前拒绝恢复。`/status`、`/models` 显示 profile、能力来源与实际发送的 reasoning。
- 完整 reasoning/message/function call 终态按顺序回传，专用 SDK fixture 覆盖多工具、下一用户轮次、Session 恢复、summary 及稳定字节前缀；流式 delta 不重复拼接。未配对调用时不启动 summary，完整保留单元中的 reasoning 和验证债务。
- 内部候选策略精简提示与读取描述、提供按模型提交顺序的简短失败反馈及第二次连续重复失败提醒。默认仍是 baseline；四路安全读取、危险操作串行、完整响应先落盘、取消/权限/存储/unknown 与宿主验证不变。
- 评测记录实际请求、tool batch、重复失败、等待、usage/cache 和请求组成字节；worker 只转发安全计数与时间，不复制工具、模型或推理正文。新增质量门槛与 token 对比报告，精确 10% 边界有回归。
- 显式开发 fixture 准备两项中转兼容及六次 smoke、六十次正式 A/B；冻结源码/构建和全部评测材料。Windows 工作区采用短隔离路径。A 含必要协议修正，B 才启用候选策略，不与旧 dsh 三组预算混用。
- 双语 README/使用指南、RUNTIME、状态专题、评测指南、PLAN 和 DECISIONS 已同步。此前环境代理、网页来源链接和安全失败诊断保持。

## 当前验证证据

本轮最终串行门禁 `typecheck → lint（不存在）→ test → build` 通过实际存在的检查；**1090 项测试，1087 通过、3 跳过、0 失败**，耗时 69729.377 ms。lint 缺项，不记为通过。`git diff --check` 通过。完整回归含 TUI、exec/SDK、取消/持久化、混合工具屏障及原生 sandbox；新打包产物的 manifest、双语版本展示和图片已核对，构建后的 SDK 导入通过，不发模型请求。上轮隔离安装的 CLI help 与公共 SDK 导入证据保留在原报告中。

两项生产 runner 离线兼容验收通过；A/B fresh-worker 的实际 SDK 请求边界预检通过，high / 32768 / 原始 ID 与 configured profile 已核对，真实网络调用为零，进程清理已等待。提交后还须在新根重绑定 revision，交付收据记录准确提交的 Windows/Linux CI 与远端状态。

十项固定任务已重新取得 pristine pass → 指定 seeded assertion failure → reference pass。证据分布在本地 `fixture-proof-recheck.log`（前五项）、`fixture-proof-retry.log`（接着三项）及 `fixture-proof-final.log`（末两项）。首次路径长度失败、GitHub TLS 错误与不完整 promisor cache 的失败尝试均保留，未充当缺陷证明；最终余项通过真实源码克隆取得。proof 绑定同一 evaluationDigest，agent 代码变化不改变独立 fixture 断言。

首次完整回归两项测试仍假定旧 instructions 布局，已修正测试的宿主事实提取；一次 Windows 原生 LSP 清理失败也保留，定向与后续完整回归通过。早期候选目录及旧安装产物留存，但不替代最后构建的身份与证据。

## 分项结论与后续

| 维度 | 当前结论 | 后续门槛 |
| --- | --- | --- |
| 协议兼容 | 工程与离线契约通过；该中转真实 reasoning/usage 仍 pending | 独立中转兼容阶段 |
| 任务质量 | 自主编码任务 live A/B 未运行 | 总体及逐任务通过数不降、人工介入不增、安全与独立验证无回退 |
| token 效率 | 无真实消耗对比，不声称节省；候选默认关闭 | 完整计量且质量通过，共同成功任务中位数下降至少 10% 才描述样本观察到节省 |

后续分别授权：兼容每项 10,000/阶段 20,000；smoke 每项 100,000/阶段 600,000；正式每项 100,000/阶段 6,000,000。均为可审阅草案，不是已有授权或严格账单上限。固定 `https://cc2.caaa.tech/v1`、原始 `deepseek-flash`、high；编码输出 32768，十五分钟、最多三轮实际修复。unknown usage、隔离或清理失败停止整个阶段，旧账本和失败不能清空重跑。运行方式见 [评测指南](../BENCHMARKING.md#deepseek-loop-ab-acceptance)。
