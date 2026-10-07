# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前版本、提交和验证证据见 [HANDOFF](HANDOFF.md)，稳定机制见 [知识库](README.md)，已完成阶段见 [PLAN_HISTORY](archive/PLAN_HISTORY.md)。

## 当前里程碑：可靠性、MCP 资源访问与长会话成本

用户明确授权本轮 P0／P1／P2／P3 实施。比较参考继续固定为 DeepSeek Harness 官方 checkout `639ed015397290b3745d163aafe02ffee4aa3f84`，不扩大为全部 MCP 协议或实验调度。既有历史/附件、exec、fork、重连、裁剪继续复用；模型默认值、权限和宿主验证不变。

- [x] MCP 使用 SDK 公共 request/result schema，宿主持有完整定义和独立 output validator；完整发现与编译成功后原子发布，binding 覆盖 outputSchema/execution。required-task 不广告，状态明确 unsupported；资源/提示专用 server 可 ready。
- [x] MCP 资源、模板、提示使用一次一页的 cursor 接口；单页最多 1,000 项／1 MiB，超限不给部分条目或跳项续点，二进制投影不注入 base64。真实 SDK stdio/HTTP fixture 覆盖目录更新、调用校验和失效会话恢复。
- [x] LSP 宿主输入和返回位置校验 denied roots；验证 UTF-16 与 open/close 能力，hover 安全截断，production factory 统一 permission revision。
- [x] Windows 固定后端门禁加入宿主正对照与 allowed/denied/inconclusive 证据。实测仍 allowed，保持 unavailable；通用 registry/pool 按批准的条件后移。
- [x] exec 可等待输出贯通 Agent loop，工具/工作流在执行或提交边界交付。schema 1 助手正文完整分块转义写出，其他事件整行最多 64 KiB 且明确截断，编码缓冲有界，30 秒无进展取消清理。
- [x] Windows 非 TTY 输出由 CLI host 拥有的 writer 子进程处理，避免标准 pipe 同步写阻塞取消；真实子进程 fixture 验证慢消费者、断管、不读、信号边界和回收。
- [x] Session load/list/search 流式解析记录，保留旧 JSONL 和 crash tail 语义；历史输出定位使用 256 项只含 metadata 的 LRU，命中仍验证记录与调用来源。
- [x] v1 附件按 header＋范围读取，保留文件身份、精确长度、锁、取消、淘汰、UTF-8 continuation 与转义后响应上限，无存储迁移。
- [x] 集成审查、Windows 串行 typecheck → test → build、差异/链接检查与最终交接。
- [ ] 真实 Windows Terminal 手工验收恢复、fork→Plan→coding→取消→再次 coding、resize/scrollback、单 prompt 与退出清理。

## 验收与边界

验收使用 fake provider、本地真实 SDK/server 和临时工作区，不读用户凭据或发送付费模型请求。真实 stdout/process 集成与 fake host 回归分别报告；Windows 管道信号 handler fixture 不等同于 Windows Terminal Ctrl+C。半条 JSONL frame 已写出后通道失败或取消时不能补写可靠终态，Session 仍按持久化/清理规则收束。

长会话 fixture 固定为 128 MiB replay、100 个 Session 冷/热列表/搜索，以及 2 MiB 附件连续 16 个 24 KiB 页面。门禁使用解析/读取字节与结果等价，耗时/堆只作离线诊断。附件读取量最多 512 KiB，日志来源重验另计，不宣称整个调用只读一页。原格式没有正文 hash，本轮不新增该保证。

Test CI 的 Windows/Linux 矩阵执行新增 fixture 并设置有界超时；本机原生 sandbox 和真实终端体验单列。没有 lint script 时不臆造检查。文档与 README 只说明已实现能力，版本和测试数量只在 HANDOFF 维护。

## 独立后续

1. 固定 Windows native backend 的网络隔离仍受阻；本轮不更换 sandbox、不关闭门禁、不回退宿主执行。后续候选是上游共同 Windows backend 的网络拒绝修复，先以独立分支审查具体 revision，不能只因版本变新就放行。升级回归必须保持宿主正对照、明确拒绝证据，并分别记录 IPv4/IPv6 和其他实际测试传输，重验工作区写入、应用状态读取、shell/patch 权限、取消及进程树确认退出。只有原生门禁通过后再实现用户 lsp.json、通用 registry 与四实例池及其生命周期。
2. 公开 TypeScript SDK、CLI Plan、OAuth/header helper、elicitation、sampling/tasks、持久审批和资源订阅仍需独立场景与方案。
3. 持久 undo、item-level 提前执行、图片、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议不进入本轮。
4. 真实模型比较需要另行明确授权与 task/campaign 数值预算；离线宿主 I/O、进程数和耗时证据不代表模型成功率、质量或 token 提升。

用户随后明确授权更新版本、提交并推送。交付只推送 `main`，使用 `[skip publish]` 保持 Test CI 并阻止分支发布，不创建或推送 tag，不创建或更新远程 Release。
