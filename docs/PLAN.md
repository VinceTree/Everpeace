# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](HANDOFF.md)。第四阶段后台任务的 [计划](archive/PLAN_BACKGROUND_JOB_LIFECYCLE.md) 和 [交接](archive/HANDOFF_BACKGROUND_JOB_LIFECYCLE.md) 已归档。

## 第五阶段首轮：Session 搜索快照隔离

本轮处理一个具体的存储状态问题：搜索把内部缓存中的 summary 直接交给调用方，返回值的临时修改会污染后续匹配和恢复状态显示。继续使用现有 SessionStore 和 JSONL，不建立第二套缓存、存储或恢复系统。

1. 以现有 list／load 的持久事实建立冷读与 warm hit 回归，复现标题、模型及嵌套恢复状态被返回引用污染。
2. 在搜索返回边界深度复制 summary，让调用方独立拥有快照；保留 match／preview、字面量匹配、scope、分页和 LRU 的原行为。
3. 验证 Goal、workflow 债务、TaskProgress、Memory policy 与 fork lineage 不受污染，usage unknown 和 fork 重置仍按既有记录恢复。
4. 用实际日志读取计数器确认复制没有关闭缓存或触发重复扫描；通过真实 SessionStore 与 picker 验证入口选择／再次搜索。
5. 更新状态契约、架构决策、项目地图、开发指南和交接；串行执行实际门禁，记录缺项与独立验收边界。

- [x] 确认状态所有者并取得修复前的语义失败证据。
- [x] 隔离冷读和缓存命中的返回快照，不改变公共接口或 Session schema。
- [x] 覆盖嵌套恢复状态、fork、usage、缓存读取成本和 picker 回调。
- [x] 完成扩大恢复回归、同步文档及串行 typecheck → lint → test → build，首败停止；记录类型首败修正和 lint 缺项。
- [x] 检查差异、文档链接和原有内容保留情况，完成交接。
- [ ] 按新增授权更新版本、重新执行交付门禁、提交并推送 main；核对双平台 CI 与 Release 未变，不推送 tag。

## 后续顺序

第五阶段后续按具体问题逐项整理 Session 重放／状态投影、usage、历史附件与 Memory；之后推进终端交互。第三阶段其余请求／上下文职责和第四阶段原生进程取消仍保留独立事项，不在本轮混合实施。整体框架见 [PROJECT_MAP](architecture/PROJECT_MAP.md#整体分层与状态归属)。

## 独立验收

真实 Windows Terminal 手工验收仍单独 pending，自动测试不能替代；不调用真实模型。用户已明确授权更新版本、提交并推送，提交均带 `[skip publish]`，不创建或更新 Release、不推送 tag，保留用户所有原有未跟踪内容。
