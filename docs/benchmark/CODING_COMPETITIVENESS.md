# DeepSeek 编码效果与成本评测

本阶段实现评测工程和可执行离线准备。官方 DeepSeek、修复策略、团队、外部 dsh、Memory 与性能收益均须经过另行授权的真实模型测量。离线 proof、合成 provider preflight、项目自动门禁不能当作正式成功率或费用排名。实际执行结果只在 [HANDOFF](../HANDOFF.md) 维护。

主端点为 `https://api.deepseek.com`；登记 ID 与供应商原始模型 ID 分开冻结，默认使用阻止 live 的占位符。准备器不读取 keyring 或个人模型凭据。`responsesProfile: deepseek` 是本地协议选择，不证明供应商的 Responses、reasoning、工具调用或 Usage 能力；先单独验证兼容，再进行 smoke 和正式实验。自定义中转另建配置和证据，不合并官方结果。

[真实任务目录](real-fixtures/catalog.json) 保存 12 项公开上游改动的实际父提交：真实缺陷、依赖兼容、跨模块重构各四项，来自 Chalk、Commander 和 Day.js。任务链接、原始改动提交、参考补丁摘要与 MIT 许可证留在 evaluator 材料中。`startingState: upstream` 不注入作者制造的 seed；健康基线回归与新增缺陷断言分开，参考修复后再次执行独立回归。此样本不能代表全部大型 Issue、依赖冲突或长期重构。

修复 baseline/candidate、单 Agent/团队、Everpeace/dsh、loop baseline/candidate 分为独立实验，保持相同任务、原始模型、请求设置、源码、时间和完整任务预算。每任务每臂五次，正式每实验 120 次；smoke 选三类各一项，每臂一次，共六次。默认串行，交替先执行的臂；双臂预算不混用 `null` 与数字，有限 campaign 启动一对前要求足额两份 task budget。预算是准入限制，不是服务商账单上限。

| 阶段 | task / campaign token 草案 | 范围 |
| --- | --- | --- |
| 官方兼容 | 10,000 / 20,000 | 文本终态、Usage、两轮文件读取；输出上限 1,024 |
| smoke | 100,000 / 600,000 | 三项、两臂、各一次 |
| 每项正式对照 | 100,000 / 12,000,000 | 十二项、两臂、各五次；输出上限 32,768 |
| Memory coding pilot | 100,000 / 7,200,000 | 三个四任务序列、on/off、各三次，共 72 个计划任务 |

这些数值只用于审阅计划，不构成调用授权。默认生产单 Agent、最多三轮修复不因本计划改变。

先完成最终代码的 `pnpm build`。下面的根目录必须是新绝对目录，保留每次失败和旧候选，不覆盖重跑：

```powershell
pnpm exec tsx tests/fixtures/prove-real-tasks.ts <新证明目录> <固定源码缓存目录>
pnpm exec tsx tests/fixtures/prepare-official-experiments.ts <新实验目录> <固定dsh目录> <固定源码缓存目录>
pnpm exec tsx tests/fixtures/deepseek-loop-acceptance.ts prepare <新仓库外兼容目录> --official
pnpm exec tsx tests/fixtures/deepseek-loop-acceptance.ts offline <兼容目录>
pnpm exec tsx tests/fixtures/memory-coding-pilot.ts prepare <新pilot目录>
pnpm exec tsx tests/fixtures/memory-coding-pilot.ts prove <pilot目录>
pnpm exec tsx tests/fixtures/prove-real-web.ts prepare <新网页目录>
pnpm exec tsx tests/fixtures/prove-real-web.ts prove <网页目录>
```

正式准备支持 `--model-id <登记ID> --raw-model <供应商原始ID>`；只填写元数据，不取凭据或请求模型。已有网页快照可在新目录准备时追加旧目录参数，仅重试缺失页。缺页一直留在分母。网页报告是 DOM 参考块指标，未审阅注释不得称为正文准确率。

每次请求保留 purpose、终态和 Unknown Usage 原因，不存 provider 正文或 headers。Usage 缺失、非法字段、传输失败或流结束未返回 Usage 分开记录；run 数与 request 数分开，准备失败不记为真实请求。缓存字段缺失保持未观察，不补零。`campaign-started.json`、`campaign-plan.json` 和逐次 `results.jsonl` 排他落盘；存储、清理、隔离、Unknown Usage 或身份复核失败停止后续任务。最终不完整 live 返回失败退出码。

成功同时依赖生产 runner 的终态、项目检查和 evaluator-owned 功能断言。按任务类别报告修复收益、首次通过、人工介入、包括失败的 Token/每成功任务、耗时、请求数及重复失败。配对差异按任务聚类 bootstrap，重复运行不能冒充独立任务样本。Memory pilot 仅在验证和外部验收均通过后捕获，提取成本计入；前序失败保留后续 skipped。技术网页 pilot 不执行 JavaScript，也不证明复杂站点泛化。

[价格审阅模板](PRICING_TEMPLATE.example.json) 的价格、原始模型和审阅时间初始为 null；人工核对后通过现有 `/cost` 设置。缺价格或 Usage 时只报告已知部分，不把用户估算、预警阈值或 Token 准入当作服务商账单。

| 编号 | 本阶段交付 | 仍需证据 |
| --- | --- | --- |
| 24–28 | 官方端点/ID 草案、Usage 计量、串行预算、价格模板 | 官方付费编码闭环与账单 |
| 29–31 | 十二任务、五次配对、团队/并发协议 | 候选收益和独占资源时延 |
| 32–35 | 实际上游任务、独立验收、最终身份复核 | 更广任务覆盖和策略结论 |
| 36–38 | 连续 Memory、真实网页、性能 pilot | 长期净收益、站点泛化、实测效率 |
| 39–41 | 固定 dsh、兼容入口、可审查价格配置 | 外部真实对照和协议探测 |
