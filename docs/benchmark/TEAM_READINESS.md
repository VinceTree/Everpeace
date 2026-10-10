# 当前候选单 Agent／团队验收准备

使用 [prepare-team-readiness.ts](../../tests/fixtures/prepare-team-readiness.ts)准备本轮候选，保留既有单工具、其他候选和多模型 fixture 的历史证据；它们不能转记为当前候选团队实测成功。

```powershell
pnpm build
pnpm exec tsx tests/fixtures/prepare-team-readiness.ts prepare C:\temp\everpeace-team-readiness-new
pnpm exec tsx tests/fixtures/prepare-team-readiness.ts proof C:\temp\everpeace-team-readiness-new
pnpm exec tsx tests/fixtures/team-comparison.ts --same-model
```

准备目录必须新建、绝对且位于工作区之外。无模型参数时配置保留 REQUIRES_MODEL_AUTHORIZATION 与 provider.invalid 占位符，不能用于真实请求。确定模型后可追加注册 ID、供应商原始 ID 和端点参数；不读取 credential storage。准备脚本没有 live 路径，preflight 的 Responses 边界使用合成数据并阻断 socket。

单 Agent 与团队 harness 共用同一 revision、source/build digest、根模型、高 reasoning、32768 输出上限、任务和独立评分器。团队启用根加两成员，不配置角色模型，全部继承根模型。worker 参数和配置真实传入 production adapter；preflight 观察根及两个只读成员请求并核对全部计量。实际编码／整合由 `--same-model` fixture 与原生团队回归证明，不能把只读 preflight 当成编码隔离证据。

`candidate.json`冻结完整构建、源码、评测材料、准备 harness 和配置摘要；输入改变时重新生成新目录，不盲目继续旧候选。`fixture-proof.json`记录固定目录每项任务的 seed 被独立断言拒绝、reference 被接受；这是评分器证明。工作区验证仍独立于成员检查，已有回归覆盖成员通过而根失败、unknown、预算、权限及恢复债务。

独立评分器 proof 仅在 evaluationDigest 完全一致时可复用，必须另存来源目录与摘要核对记录；当前候选 preflight 和代码/构建身份仍重新生成，不能复用旧候选模型结果。

| 待授权阶段 | 范围 | 每任务 / 阶段 token 草案 |
| --- | --- | --- |
| 协议兼容 | text、reasoning-tools 两个短探测；明确的高 reasoning／1024 输出设置 | 10000 / 20000 |
| smoke | 固定目录前三任务，single/team 各一次，共六次 | 100000 / 600000 |
| 正式对照 | 全部十任务，single/team 各三次，共六十次 | 100000 / 6000000 |

`compatibility-plan.json`是待审阅协议探测说明，沿用既有短探测流程，不能直接交给 campaign CLI；smoke/comparison 是可由 campaign CLI 校验的配置。短探测输出设置与正式对照分开明确记录，不在预算不足时偷偷修改模型设置。后续实测需用户明确实际注册模型、端点/profile 和各阶段数值授权；这些文件不构成授权，也不是供应商账单硬上限。

正式结果保留独立通过率、首次验证、耗时、团队总 tokens、重复读取／失败、冲突和人工介入。团队总账是请求准入的唯一来源，评测在全部请求收束后按 teamId/requestId 幂等汇总 settled evidence，不能重复扣 reasoning 或用空根账本覆盖成员用量。unknown、资源清理失败及原生隔离失败停止整个阶段，剩余 skipped 仍留在完整计划分母，失败不以重跑替换。不宣称团队更快、更省或质量更高。
