# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据只见 [HANDOFF](../HANDOFF.md)。上一轮 Plan 修订、批准等待与显式执行的 [计划](PLAN_PLAN_EXECUTION.md) 和 [交接](HANDOFF_PLAN_EXECUTION.md) 已归档。

## 当前里程碑：整体框架与验证基线

本轮只实施全项目渐进优化的第一阶段：明确分层、状态归属和验证标准，沿用现有实现。后续每轮围绕一个明确问题，开始前再细化方案。本阶段不新增产品能力，不改变公共 CLI/SDK 参数、Session schema 或用户流程；不调用真实模型，不进行 Release 操作，保留原有未跟踪内容。

- [x] 类型检查显式包含全部源码与测试 TS/TSX；构建包含源码 TSX、排除测试，严格选项和 ES2022 不变。
- [x] 按真实接口修正测试替身、可选参数、联合类型、Memory/Skill 数据与回调，保留原有断言。
- [x] 使用已有 TypeScript 解析 API 建立核心模块禁止 UI 依赖的回归，覆盖导入、类型导入、重导出、字面量动态导入和合法入口。
- [x] 项目地图与架构决策记录五层职责、状态所有者及依赖方向，修正公开 SDK 的过时描述。
- [x] 更新开发指南、当前计划和交接，旧计划与证据归档，不建立平行知识库或空模块。
- [x] 对照 tracked TS/TSX 清单检查类型覆盖，完成 TUI、Plan、Session、SDK 回归。
- [x] 串行执行实际存在的 typecheck → lint → test → build，首败停止，记录缺少 lint；检查差异和文档链接。

## 后续模块顺序

1. 任务与会话协调：按状态所有者逐步提取任务准入、取消、Session 切换和 Plan 批准。
2. Agent 引擎：整理请求准备、上下文维护和工具调度的内部边界。
3. 工具与进程：统一错误反馈、资源归属和取消清理，保持权限与文件观察约束。
4. 存储与恢复：整理 Session、usage、历史附件和 Memory 的状态边界。
5. 终端交互：完善输入、审批、resize、重放和真实 Windows Terminal 验收。

以上仅确定推进顺序，不把待办视为新的执行授权。各模块在方案细化、回归和交接完成后再进入下一项；整体框架见 [PROJECT_MAP](../architecture/PROJECT_MAP.md#整体分层与状态归属)。

## 独立验收

本轮离线回归与真实 Windows Terminal 分别记录。修订输入、取消、resize／scrollback 和单 prompt 尚需终端手工验收；自动测试不能替代。真实模型规划质量、编码成功率或 token 收益不在本阶段证据范围；live 评测仍需明确授权及数值预算。
