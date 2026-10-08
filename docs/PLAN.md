# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](HANDOFF.md)。第五阶段 Session 搜索快照的 [计划](archive/PLAN_SESSION_SEARCH_SNAPSHOTS.md) 和 [交接](archive/HANDOFF_SESSION_SEARCH_SNAPSHOTS.md) 已归档。

## 第六阶段首轮：Composer 提交与草稿生命周期

本轮只处理一个输入状态边界：提交等待中，React 状态更新前可重复调用宿主；旧完成回调又可以覆盖共享输入引用中的新草稿。沿用现有 Prompt、App 与应用协调，不建立第二套任务准入或存储。

1. 使用实际 Ink 输入和受控 Promise 复现连续 Enter、同步重入及旧回调覆盖草稿。
2. 在调用宿主前同步占用输入，阻止当前挂载的重复提交、输入和粘贴；React 状态只控制显示／订阅。
3. 成功接收前核对挂载、提交与原 ComposerState；宿主恢复草稿或卸载后的迟到回调不得修改新草稿、历史导航或界面。
4. 保留 false、同步抛错、Promise 拒绝后草稿与显式重交；正常提交、resize 与任务切换保持可用。
5. 用真实附件解析和 App 证明 guidance、任务收束、空闲 Ctrl+C、命令 Esc 重放与单 prompt；同步双语 README、状态契约、结构、决策、项目地图、开发指南及交接。
6. 串行执行实际存在的 typecheck → lint → test → build，首败停止；记录 lint 缺项，并检查差异、文档链接和原有内容。

- [x] 取得修复前的语义失败证据并确认状态所有者。
- [x] 同步占用输入，完成回调绑定原挂载与草稿；不改变公共接口或 Session schema。
- [x] 覆盖重复输入、粘贴、重挂载、宿主替换、失败重交与实际 App 附件／guidance／replay。
- [x] 完成定向离线回归，同步稳定契约并归档第五阶段证据。
- [x] 完成最终串行门禁、差异与文档链接检查，更新交接证据；lint 脚本缺项，真实 Windows Terminal 验收仍独立 pending。
- [x] 按新增授权更新展示版本、提交并推送 main；修正 CI 暴露的测试输入订阅时序，重新通过本地门禁与双平台 Test CI，Release workflow 实际跳过，未推送 tag；证据见交接。

## 后续顺序

第六阶段后续先细化审批、命令输入、取消、resize 或重放中的一个实际问题，再逐项处理；真实 Windows Terminal 验收单独保留，不用自动测试替代。此前 Agent 请求／上下文、原生进程取消与存储事项不在本轮混合实施。整体框架见 [PROJECT_MAP](architecture/PROJECT_MAP.md#整体分层与状态归属)。

## 独立验收

仅执行离线回归，不调用真实模型。用户已明确授权更新版本、提交并推送，提交使用 `[skip publish]`，不创建或更新 Release、不推送 tag，保留用户所有原有未跟踪内容。真实终端步骤见 [DEVELOPMENT](DEVELOPMENT.md#离线-windows-terminal-手工验收)，执行后才记录终端版本、步骤与结果。
