# DeepSeek 实测准备

Agent Loop 的协议基线 A 与显式优化候选 B 使用独立的两组流程，见 [评测指南](../BENCHMARKING.md#deepseek-loop-ab-acceptance)。该流程先验证中转的 reasoning 连续性，再准备六次 smoke 与六十次正式任务；下文已有个人任务及 dsh 三组方案保留为独立准备，不与新预算合并。Windows 的新任务工作区使用显式配置的短临时路径，报告和 Session 保存在本地报告根；工作区不共享日常状态。

本轮面向 Windows、DeepSeek、单 Agent、Node/TypeScript 单包个人项目。离线准备通过以后，真实模型的成功率、稳定性和成本仍须分别授权实测。具体候选、当前证据和未完成项只记录在 [HANDOFF](../HANDOFF.md)。

## 隔离目录

每轮创建新的绝对目录，写入 `ownership.json`，其中 `kind` 为 `everpeace-readiness`、`baseline` 为本轮开始时完整 Git SHA。基线 clone、本轮个人任务、Session、Memory、dsh home、proof 和产物均位于该目录。原有 `.everpeace-benchmark/` 不作为本轮可写目录。参考补丁和验收器位于模型工作区外；工作区与日常凭据目录不共享。

开发准备入口（不新增用户 CLI）：

```powershell
pnpm exec tsx tests/fixtures/prepare-personal.ts <owned-root> <absolute-pnpm.cjs>
pnpm exec tsx tests/fixtures/personal-offline-preflight.ts <owned-root>
pnpm exec tsx tests/fixtures/prepare-readiness.ts proof <owned-root>
pnpm exec tsx tests/fixtures/prepare-readiness.ts configs <owned-root>
pnpm benchmark:campaign -- --config <owned-root>/smoke.json --preflight
```

基线副本须在目录的 `baseline/`，安装 frozen lock 并构建；dsh 副本在 `dsh/`，检出 [固定上游](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84) 后按其当前 manifest 构建。也可给 configs 入口第三个参数，复用该 revision 的干净、已构建外部 checkout，只读使用其源码与构建；所有 dsh profile、home 和运行状态仍在 owned-root。候选源码、依赖、构建或 HEAD 变化后重新生成 configs 并 preflight。旧 proof 失败记录保留，重做采用新目录。

## 个人四任务

| 任务 | 起始状态与范围 | 独立验收 |
| --- | --- | --- |
| 理解执行与恢复 | 冻结基线，只读 | 源码引用准确；解释全检查、首败停止、过期证据、fork 债务、全新授权及清理 |
| 用量缺陷修复 | 注入 nested reasoning 为零；只改 status 实现及对应回归 | nested reasoning=3、output=5、cache=7；实际 package 检查；失败必须是指定断言 |
| Provider 小功能 | 基线没有 `isSupportedProvider`；只改 provider 实现及回归 | valid/invalid、大小写和空白与 parseProvider 一致，未知值不抛错；实际 package 检查 |
| 长任务取消与恢复 | 新增 readiness note；模型 usage 可靠后在宿主验证中取消 | 后代退出、待验证债务落盘；重启 fork 保留债务、重新授权、重新执行完整检查 |

提示词、允许路径、独立验收、参考补丁、装配和用量设置写入外置 `personal.json` 与 `personal-evaluators/`。离线 provider 只验证装配、runner、采集与恢复，不能说明真实模型已掌握任务。任何装配失败、缺依赖、超时、取消或未知用量均不能冒充参考通过。

## 固定对比与预算草案

复用 [十项固定任务](DEEPSEEK_NODE_TASKS.json) 和外置验收器。每项必须在新 clone 证明原始通过、缺陷产生指定断言失败、参考修复通过；模块缺失、进程启动失败和超时不能充当缺陷证明。基线、本轮最终候选、固定 dsh 三组都须无凭据 preflight，记录 revision、source/build digest、实际请求设置、usage、网络零调用和清理。

| 阶段 | 运行数 | 每任务 token 草案 | campaign token 草案 |
| --- | ---: | ---: | ---: |
| 个人项目 | 4 | 100,000 | 400,000 |
| Smoke | 3 任务 × 3 harness = 9 | 100,000 | 900,000 |
| 正式对比 | 10 任务 × 3 harness × 3 次 = 90 | 100,000 | 9,000,000 |

统一 `deepseek-flash`、high、32768 输出上限、十五分钟任务期限、最多三轮实际修复。数值只用于审阅，不是付费授权或严格账单上限。三阶段分别授权；先个人与 smoke，请求、计量、隔离或清理异常立即停止并重做候选准备，再考虑正式对比。

成功率、首次成功率、人工介入、成功任务耗时及 token、缓存和计量完整性分别记录。取消和跳过保留在计划分母；unknown usage 不能由之后成功覆盖。现有 exec/SDK 与共享 production runner 保持为生产入口。
