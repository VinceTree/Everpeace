# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](HANDOFF.md)。此前计划见 [连续性历史](archive/HANDOFF_CONTINUITY.md) 与 [PLAN_HISTORY](archive/PLAN_HISTORY.md)。

## 当前里程碑：按需项目地图与受控容错编辑

用户授权离线实施并自动更新展示版本、提交推送 main；不创建／推送 tag、不更新 Release，不调用真实模型，保留原有未跟踪内容。提交包含 [skip publish]，不跳过测试 CI。默认 high／32,768、原生 sandbox、Responses 和宿主验证规则保持。

- [x] 共享 coding／Plan 只读 project_map，按需枚举、Node 元数据、声明与候选分离、ignore／链接／工作区边界及完整上限。
- [x] 显式 line_whitespace 唯一完整行块定位，默认 exact、拒绝歧义、预览／结果展示方式与行范围，保留审批／并发／回滚边界。
- [x] Windows／Linux 非 TTY owned output writer，完成 callback ACK、父进程取消／超时、pending／close／exit 清理顺序和迟到错误处理。
- [x] fake provider 生产闭环及地图／编辑／输出进程回归，IPC 就绪／取消／清理证据。
- [x] 工具、运行时、状态、决策和双语说明更新，归档前一轮交接与实际 CI 失败。
- [x] 串行重新发现并执行现有 typecheck → lint → test → build，首败停止，明确缺少 lint，差异与文档链接检查。
- [ ] 自动提交推送 main，等待 Windows／Linux Test CI，核对 Release job 跳过与已有 Release 不变；相关失败继续修复，本轮不重复递增版本。

## 独立后续

离线回归证明工具行为与宿主闭环，不能证明真实 DeepSeek 编码成功率或 token 成本改善。真实 Windows Terminal 手工验收、Windows LSP backend 门禁和有数值预算的 live／dsh 评测独立处理；本轮不扩展 MCP、LSP、多 Agent 或新协议。
