# 当前交接

2026-11-04：已完成 OpenCode Go 登录预设、模型目录路由、会话标识和 Bing 搜索目标链接解析。用户已明确授权提交与推送；本次使用已验证的独立副本和 `codex/opencode-go-flash` 分支，保留原工作树正在运行的 Memory 批量预检及全部未提交改动，不修改其 HEAD。未调整展示版本、创建 tag 或 Release。

## 当前验证证据

Go 原始模型 `deepseek-v4.1-flash`；task／campaign token 上限显式 null，保留计量、超时、取消与 unknown 停止。23 项功能最新复测均通过，包含实际工具、MCP／LSP、恢复、压缩、Memory、辅助生成与双 worker 团队整合。合成宿主的授权／回答不算人工 TUI 验收。原 history／web／team 失败保留，分别记录测试授权、Bing URL 解析与来源评分、成员命令审批原因。

隔离副本按 typecheck → lint → test → build 串行全通过，1421 项中 1418 pass、3 个既有平台／环境 skip、0 fail；UI、文档、CI 配置、原生文件与进程清理检查通过。冻结源码 digest `41af77e8201890c63c8f1be85ae2e500aa8cb20cefdc55444e19fd9ff2ee1f74`；源码、测试、manifest／lock 输入保持验证时字节，后续仅整理本次提交的文档范围。证据索引 `.cache/opencode-go-all-2026-11-04/final-evidence.json`、`summary.json` 和 `snapshot-gates.json`。提交会改变 Git revision；旧实验 plan 不能复用于新请求。

扩展功能阶段 118 次真实请求及 118 个 HTTP 200，已知 input/output 782,208/28,530；主动取消一次用量 unknown，账本拒绝继续准入、资源已收束，不能当作零费用。包括早期诊断与 smoke 共 138 次请求，三次 unknown；906,690 只是已知 tokens，不是完整账单。本轮不推断质量排名或节省。

## 范围与历史

完整阶段记录、验收器修正、并行修改及冻结限制见 [Go 功能交接](archive/HANDOFF-2026-11-04-go-smoke.md)。早期接入／区域诊断见 [Go 接入交接](archive/HANDOFF-2026-11-03-opencode-go.md)，上轮 Memory 修复见 [Memory 交接](archive/HANDOFF-2026-11-02-memory-hardening.md)。本提交不包含另一个工作树仍在开发的 Memory 批量评测，不把隔离副本门禁外推到其最新源码。
