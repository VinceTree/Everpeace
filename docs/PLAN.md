# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据见 [HANDOFF](HANDOFF.md)，机制见 [知识库](README.md)，此前计划见 [PLAN_HISTORY](archive/PLAN_HISTORY.md)。

## 当前里程碑：个人开发任务连续性与工具反馈

用户授权离线实施，参考固定 DeepSeek Harness `639ed015397290b3745d163aafe02ffee4aa3f84`；随后明确授权更新展示版本、提交与推送，但不更新 Release。只推送 `main` 并使用 `[skip publish]`，不创建或推送 tag；不调用真实模型，已有未跟踪内容保留。默认模型参数、Responses、原生 sandbox 和 runner 成功判定不变。

- [x] 固定八章摘要交接，assistant 背景回注，旧摘要请求投影兼容与 /context 展示。
- [x] 完整交互边界、连续压缩及无效摘要保留原 context；不追加摘要修复请求。
- [x] 共享 production IO 提供当前工作流事实，每 step 冻结、retry 复用，保留恢复与历史验证债务。
- [x] 文件／搜索、shell／后台和 patch 的显式错误分类及修正提示，保留超时部分输出与不重放边界。
- [x] fake provider 和临时 Git 工作区验证失败反馈 → 压缩 → fork／重启 → 重新读取 → 修正 → 完整宿主验证。
- [x] 更新运行时、工具、决策和双语说明，修正 exec Plan 矛盾，归档旧交接证据。
- [x] 最终重新发现并串行执行现有 typecheck → lint → test → build，首败停止；记录缺少 lint，并检查差异／本地链接。

## 验收与独立后续

回归证明宿主机制与持久化边界，不证明 DS 摘要语义完整性、真实编码质量或 token 节省。真实 Windows Terminal 手工验收继续独立待办；Windows LSP 不可用原因仍为固定 backend 网络隔离门禁失败。MCP 扩展、LSP backend 升级、多 Agent、新协议不在本轮。

真实模型 smoke 和 dsh 对照仍需另行明确授权及 task／campaign 数值预算。Goal 与成功 Memory 只由宿主验证结算，不以摘要或执行清单代替。
