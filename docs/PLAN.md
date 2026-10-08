# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](HANDOFF.md)。上一轮见 [项目地图计划](archive/PLAN_PROJECT_MAP.md) 与 [交接](archive/HANDOFF_PROJECT_MAP.md)。

## 当前里程碑：Plan 修订、批准等待与显式执行

用户授权实施既定计划并离线验收，随后授权更新展示版本、提交和推送，但禁止更新 Release；只推送 main，使用 `[skip publish]`，不创建或推送 tag，不调用真实模型，保留原有未跟踪内容。待执行计划仅存在当前进程和会话中，不增加 Session schema。

- [x] 分离公共／coding／Plan 指令，Plan 不携带实施或 Goal 完成行动要求。
- [x] 审阅支持带非空意见修订，配对结果持久化后再继续；兼容旧字符串决定。
- [x] 批准后保持 Plan 并等待，新增 /plan show 与 /plan execute，执行明确携带完整正文且只消费一次。
- [x] 覆盖讨论、退出模式、成功会话变化和 Agent 替换的批准失效，以及取消、清理与 queued guidance 草稿恢复。
- [x] 离线 production TUI 闭环、fork 验证债务、exec／SDK 只读输出和问题停止回归。
- [x] 双语 README、运行时／状态契约、决策与历史归档同步。
- [x] 最终重新发现并串行执行 typecheck → lint → test → build，首败停止，记录缺少 lint；检查差异和文档链接。

## 独立验收

真实 Windows Terminal 的修订输入、取消、resize／scrollback 和单 prompt 尚需手工验收。离线回归不证明真实模型规划质量、编码成功率或 token 收益；live 评测仍需明确授权及数值预算。
