# 当前开发计划

## 本轮：多 Agent、可靠性与开发体验

用户已授权实施 opt-in 团队：根拆任务，最多两个成员调查、编码或审查，根串行整合，宿主完整验证。默认关闭，保留 DeepSeek、Windows、Node/TypeScript 单包方向。具体契约见 [TEAMS](architecture/TEAMS.md)，实际检查、当前版本和实机证据只在 [HANDOFF](HANDOFF.md)。

| 阶段 | 实现与验收范围 |
| --- | --- |
| P0 共享基础 | 不可 reset 的团队计量 scope、集中准入／在途预留、sticky unknown、稳定请求 ID、持久 ownership 与诊断分类；单 Agent 回归 |
| P1 只读协作 | 角色模型冻结、独立上下文、只读成员并行、依赖、取消／权限传播、恢复不继承旧审批 |
| P2 并行编码 | 当前内容快照、detached worktree、真实原生隔离、范围／并发版本检查、串行幂等整合、根最终检查 |
| P3 产品入口 | 英文 /team 面板、状态／诊断、CLI／SDK 共享配置、schema v2 事件、显式继续与产物清理；真实 Windows Terminal 验收 |
| P4 效率与扩展 | project_map 入口／import／测试候选、内容指纹缓存、团队重复调用观察、Skill 来源／更新预览／卸载、MCP 显式重连、离线固定对照 |

阶段先跑定向回归，最终串行 typecheck → lint（不存在则记录缺项）→ test → build，首败停止并执行 git diff --check。原生 Windows/Linux 与真实 Windows Terminal 的实机证据不能用 mock 或 CI skip 替代；当前状态以交接为准。

固定单 Agent／团队 fixture 使用合成 Responses、实际 Git/native executor 和独立断言，记录评分、耗时、tokens、重复调用、冲突与人工介入。它验证工程行为，不证明实际模型质量或效率；不改变默认循环策略。后续付费对照需新的 campaign/task 数值预算授权。

## 保留的后续范围

DeepSeek 既有协议工程及付费 A/B 准备保留；历史候选不能代表当前团队实现，源码变化需重绑定 source/build/harness/evaluation digest。预算草案见 [BENCHMARKING](BENCHMARKING.md)，不构成调用授权。递归团队、成员互调、远程分布式执行、Web/Desktop、OAuth、私有 Skill 和插件市场留待独立设计。

实现完成后，用户已明确授权更新版本、提交、推送与 GitHub Release；沿用仓库工作流并核对远端结果。授权仍不包含付费模型实测或 npm publish；保留用户全部既有 tracked/untracked 文件。目标版本、commit、CI 和发布结果见 HANDOFF 及本轮交付收据。
