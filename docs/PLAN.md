# 当前开发计划

## 本轮：公共网络、工程门禁与当前候选验收

用户授权按网络修复 → lint/源码安装 → 无凭据验收工具及离线证明的顺序实施；实现后另行明确授权按补丁版本提交、推送、更新版本与 GitHub Release。发布前重新核验候选并执行完整门禁，两平台 CI 通过后才创建 tag/Release。不执行付费模型调用。保持仓库内 pnpm 源码安装，HTTP/HTTPS 代理与直连同时受控。

| 阶段 | 交付边界 |
| --- | --- |
| P0 | 公共 DNS 地址绑定实际 socket、TLS 原域名身份、逐跳校验、响应租约、宿主代理 CONNECT、认证 Git relay 与继承配置隔离；真实本地网络回归 |
| P1 | 锁定 Oxlint correctness 与警告失败、Windows/Linux 门禁顺序；固定 node-pty、实际补丁检查、干净候选源码安装及 CLI/SDK/PTY 验收 |
| P2 | 可选 team 贯穿 benchmark adapter/worker/config，总账幂等汇总；当前候选无凭据 preflight、同模型离线对照及固定目录 proof，冻结摘要和待授权分阶段配置 |
| 待授权 | 实际模型/profile 与 task/campaign 数值预算确定后才运行协议探测、六次 smoke、六十次正式对照；unknown、清理/隔离失败停止阶段，失败/skipped 保留分母 |

当前风险、历史修复、设计限制及验收缺口在 [NETWORK](architecture/NETWORK.md)分开记录；候选冻结与预算草案见 [TEAM_READINESS](benchmark/TEAM_READINESS.md)。独立补丁交付和干净消费者安装包验收仍阻塞独立分发，不引入消费者 postinstall。执行与未完成证据见 HANDOFF。

## 已交付基础：多 Agent、可靠性与开发体验

用户已授权实施 opt-in 团队：根拆任务，最多两个成员调查、编码或审查，根串行整合，宿主完整验证。默认关闭，保留 DeepSeek、Windows、Node/TypeScript 单包方向。具体契约见 [TEAMS](architecture/TEAMS.md)，实际检查、当前版本和实机证据只在 [HANDOFF](HANDOFF.md)。

| 阶段 | 实现与验收范围 |
| --- | --- |
| P0 共享基础 | 不可 reset 的团队计量 scope、集中准入／在途预留、sticky unknown、稳定请求 ID、持久 ownership 与诊断分类；单 Agent 回归 |
| P1 只读协作 | 角色模型冻结、独立上下文、只读成员并行、依赖、取消／权限传播、恢复不继承旧审批 |
| P2 并行编码 | 当前内容快照、detached worktree、真实原生隔离、范围／并发版本检查、串行幂等整合、根最终检查 |
| P3 产品入口 | 英文 /team 面板、状态／诊断、CLI／SDK 共享配置、schema v2 事件、显式继续与产物清理；真实 Windows Terminal 验收 |
| P4 效率与扩展 | project_map 入口／import／测试候选、内容指纹缓存、团队重复调用观察、Skill 来源／更新预览／卸载、MCP 显式重连、离线固定对照 |

阶段先跑定向回归，最终串行 typecheck → lint→ test → build，首败停止并执行 git diff --check。原生 Windows/Linux 与真实 Windows Terminal 的实机证据不能用 mock 或 CI skip 替代；当前状态以交接为准。

固定单 Agent／团队 fixture 使用合成 Responses、实际 Git/native executor 和独立断言，记录评分、耗时、tokens、重复调用、冲突与人工介入。它验证工程行为，不证明实际模型质量或效率；不改变默认循环策略。后续付费对照需新的 campaign/task 数值预算授权。

## 保留的后续范围

DeepSeek 既有协议工程及付费 A/B 准备保留；历史候选不能代表当前团队实现，源码变化需重绑定 source/build/harness/evaluation digest。预算草案见 [BENCHMARKING](BENCHMARKING.md)，不构成调用授权。递归团队、成员互调、远程分布式执行、Web/Desktop、OAuth、私有 Skill 和插件市场留待独立设计。

此前团队交付已完成，证据见交接归档。本轮补丁发布依据新的明确授权，不继承旧授权；保留用户全部既有 tracked/untracked 内容。
