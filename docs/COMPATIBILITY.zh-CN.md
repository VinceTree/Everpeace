# 公开兼容契约

[English](COMPATIBILITY.md) · [贡献指南](../CONTRIBUTING.zh-CN.md)

单 Agent `exec --json` 默认使用 JSONL v1，团队默认 v2，选择规则保持不变。两种协议在整个 0.x 系列继续支持。Exec 输出与 Session 存储分别版本化；不能从 Session 格式号推断输出协议号。Schema 位于 `contracts/exec-v1.schema.json`、`contracts/exec-v2.schema.json`。

同一协议不删除或重命名字段，不改变类型、单位、缺失值含义或现有枚举语义。消费者应容忍新增可选字段；新增事件或破坏性变化须显式选择新协议。弃用须同时提供迁移指南和替代接口，至少提前两个次版本且不少于 90 天公告，删除安排在后续主版本。

| 退出码 | 含义 |
| --- | --- |
| 0 | 验证通过、无改动或已审批计划；仍须检查 `workflowResult` |
| 1 | 运行错误，包括持久化和清理失败 |
| 2 | 参数或启动配置错误 |
| 3 | 宿主验证失败或不可用 |
| 4 | 达到步数、Token、用量完整性或时限限制 |
| 5 | 需要审批或结构化用户输入，不自动批准 |
| 130 / 143 | 系统允许正常传递时，SIGINT / SIGTERM 清理后的终止 |

SDK 结果新增可选 `errorCode`，JSONL 最终事件对应 `error_code`。稳定标识为 `CONFIGURATION_ERROR`、`RUNTIME_ERROR`、`VERIFICATION_FAILED`、`LIMIT_REACHED`、`INTERACTION_REQUIRED`、`CANCELLED`、`OUTPUT_CLOSED`、`PERSISTENCE_FAILED`、`CLEANUP_FAILED`，不随界面语言改变。`error` 是诊断详情，不能作为稳定判别字段。清理失败优先于普通取消或成功。

配置失败可能没有 Session，只输出 `run_finished`。Session 开始事件位于任务活动前。工具事件用调用身份关联，启动先于同一调用的结束；团队成员可交错，不能因此推断主任务验证通过。SDK 可异步回调，宿主等待回调保持交付顺序；回调异常停止任务并等待清理，不作为模型请求重试。

输出健康且正常结算时只有一个最终事件，之后无进度事件。管道关闭、强制杀进程或输出中断允许没有最终事件或末行不完整。消费者必须将缺少最终事件、不完整末行或中间损坏记录判为未完整结算，不能根据助手声称“完成”推断成功。

SDK `runTask` 不发起终端审批。操作失败返回分类结果，调用方须检查；`signal` 支持取消，`onEvent` 可以异步。取消后的可靠迟到用量仍计入；缺失 Usage 保持未知，不填零。

迁移方式：保持旧字段解析，容忍未知可选字段；如存在新错误码则用于分类，否则回退到旧状态、分类和退出码；保留独立的 `workflowResult` 和完整结算检查。不要只看退出码 0、最后一段文本或测试数量。

`tests/fixtures/public-contract` 固定了旧消费者、基线样例和完整性摘要；测试通过公开 SDK 包入口和构建后的 CLI 验收。不能与实现同时修改旧样例以隐藏不兼容。实际安装包还有独立消费者和原生门禁。
