# 当前交接

本轮实施公开契约与核心体验计划。基线为已发布源码候选 `v0.6.0-rc.1`、commit `1e805410b713ab90ee09040fced7137416186d0c`；工作分支 `codex/public-contract-core-experience`。本轮不改包标识、不移动旧标签，不开发 IDE/ACP 或扩大其他语言支持承诺。

用户已明确暂停真实模型测试，等待后续资金准备：不得继续调用模型、付费预检或实验。此前较新 deepseek-flash 返回 503、另一配置返回 402，不能作为有效模型证据。当前继续实现和离线验收。Linux 本机不可用，专用 Windows native Runner 尚缺；真实输入法、NVDA 和原生安装门禁分别保持未执行。

公开接口、文案和状态投影的实际结果、待验收列表统一见 [实施状态](core-experience/STATUS.md)。JSONL v1/v2 契约及旧消费者完整性冻结，稳定错误码是可选增量字段。TaskStatusSnapshot 只投影宿主事实；取消保留准入直至清理完成，清理失败继续阻塞。中英文设置使用既有原子存储机制，命令行与环境变量优先；助手、用户、源码和第三方正文不按关键词改写。

最终 `fce2321` 源码四门禁通过：1274 项、1271 通过、3 跳过；安装烟测 7/7，干净源码安装通过。末轮补齐迟到清理所有权与 Session 绑定后完整重跑，不复用前轮收据。源代码检查顺序仍为 typecheck → lint → test → build；增加 ui:verify 和 docs:verify，另行执行安装烟测。独立阶段提交和最终源码摘要将在实施状态记录。

贡献入口见 [中文指南](../CONTRIBUTING.zh-CN.md)，[终端人工矩阵](TERMINAL_ACCEPTANCE.md)、[安装准备](INSTALLATION.md) 与 [候选变更](RELEASE_NOTES.md) 分别记录未覆盖边界。机器专属原始收据位于忽略的本地证据目录，公共文档和当前归档仅保留可重现命令、相对路径、Commit 与摘要。旧历史/标签不重写。

上一轮十项优化的已发布结果见 [历史交接](archive/HANDOFF-2026-10-12-optimization-rc.md) 和 [原验收报告](implementation/REPORT.md)。这些结果不冒充本轮候选验收或优化收益。保留用户既有 question、test-me、NUL 和私有 .cache 数据。

Windows 开发打包的固定 SBOM 下载被代理中断，较早私有包未验收；正式消费者/历史升级未执行。npm 身份查询未登录，包名 E404 不证明发布权限。公共收据见实施状态；真实模型 150 个计划位置全部未执行，fixture/harness 仍须后续冻结。
