# 安全门禁与诊断契约

本专题覆盖问题 11–20；当前候选、实测数量和交付结果只在 [HANDOFF](../HANDOFF.md) 维护。

## 私密报告与供应链

[SECURITY.md](../../SECURITY.md) 使用 GitHub 私密漏洞报告入口，支持最新正式版本，main 接受尽力报告。七个工作日是确认收到的目标，不是修复期限；报告使用测试凭据，不公开利用细节。

共享 [security workflow](../../.github/workflows/security.yml) 对 PR 的 Required checks 和准确候选 Release 执行相同策略，每日北京时间 12:00 重扫 main。`pnpm audit` 检查完整锁文件，High/Critical 拒绝通过；扫描器失败、服务故障和缺失报告不能记为干净。固定版本及 SHA-256 的 Gitleaks 扫描全部 Git 历史和维护中的工作文件，报告完全脱敏。公开测试 PEM 例外绑定规则、精确路径与完整文件摘要；不排除测试目录。

SPDX AND/OR 按表达式解析；默认允许 MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、CC0-1.0。其他许可证必须有组件/准确版本/表达式/理由/审查记录例外。`spdx-exceptions` 数据包的 CC-BY-3.0 例外保留其发布包中的归属声明，不扩大允许集合。

固定 Syft 分别记录完整锁文件、实际打包 staging、两平台 npm/pnpm/global 实际消费者解析结果；目录扫描显式加入安装包 cataloger，并关闭远程许可证推断。锁文件范围与已安装版本分别表达。每种消费者安装的 SPDX 许可证报告与 SBOM 相互核对，原生二进制独立逐文件摘要。包收据记录原生原包完整性、补丁摘要、平台二进制清单及覆盖限制；无法识别的静态链接内部依赖不能声称已全面扫描。聚合收据校验 commit、tarball、锁文件、每份报告及消费者 SBOM 摘要后才允许发布；已公开资产也必须匹配。仓库安全设置是远端配置，YAML 不能代替实际启用和回读。

源码入口：[扫描](../../scripts/security/scan.mjs)、[策略](../../scripts/security/policy.mjs)、[聚合收据](../../scripts/security/receipt.mjs)、[发布](../../scripts/release/publish.mjs)。回归：[供应链拒绝路径](../../tests/unit/architecture/supply-chain.test.ts)。

## 外部内容与授权

宿主安全指令和当前用户请求保持各自身份。项目作用域规则、用户调用 Skill、MCP 服务说明和 Learned Memory 通过带来源的低信任记录进入上下文；MCP 说明不能拼入 developer/system/instructions。项目规则和 Skill 也不能授予宿主权限。普通文件、网页、搜索、MCP 返回、终端及历史结果附带 durable `_source` 标记，不能制造批准、凭据访问或验证成功。

官方 DeepSeek、配置型 DeepSeek 中转、显式缓存和通用 Responses 布局共同使用 [请求投影](../../src/providers/request-projection.ts)。[压缩指令](../../src/agent/conversation-checkpoint.ts) 要求保留来源；持久工具结果标记经过 Session 恢复和团队转交保留。Memory 内容始终作为外部来源处理。来源标签是模型语义提示；真正授权仍由宿主权限 revision、工具审批、文件边界、MCP 启动信任和网络层判定。

[攻击矩阵](../../tests/unit/runtime/injection-boundaries.test.ts) 使用生产 factory、coding runner、合成恶意模型响应、真实文件读写边界及隔离 fixture，覆盖 README、Skill、网页、搜索、MCP 和终端的权限提升、伪造批准、工作区外凭据读取、禁用网络、越界写入和拒绝后的替代请求。测试证明宿主零禁止副作用，不证明模型永远不会被误导；明确授权的 full-access 也不被描述为原生限制模式。

## 搜索与响应生命周期

Web 继续使用 DNS 绑定公共网络层及统一响应租约；MCP 不复用短租约。未消费 Body、dispatcher 与 socket 在清理结算后释放。[压力 fixture](../../tests/fixtures/web-lifecycle-stress.ts) 在独立 GC 进程覆盖重定向、缺失 Location、错误类型/状态、悬挂或异常正文、超限、超时与取消，记录每批连接/租约和内存，RSS 仅诊断。

Bing、DuckDuckGo 使用 htmlparser2 + css-select + DOM 文本提取，不执行脚本或加载资源；结果上限、去重、URL 校验和大小限制保留。未识别结构与挑战页报 inconclusive，不能伪装可靠的空结果。[真实最小结构快照](../../tests/fixtures/search-html/provenance.json) 保留来源及摘要，文字、URL 和跟踪属性已替换。

`/web` 默认 HTML；明确选择 Brave 后仅使用固定 HTTPS LLM Context 端点，经公共客户端连接，拒绝全部重定向。密钥仅在 AuthStorage/keyring，配置仅保存 provider/auth_ref。401、429、超时不触发付费重试或静默换提供方；保存不发验证请求。

## 能力诊断与费用

`/doctor` 不请求模型。`/doctor --live` 默认 Cancel，先展示端点、阶段、请求和预算再启动：最多八次、请求预算 20,000 token、单次输出 1,024、单次三十秒、零自动重试。检查流式文本、单工具、连续工具轮次、推理字段、Usage 和最后的取消。未知 Usage 停止后续阶段；认证失败、超时和缺失证据是 inconclusive，不是 unsupported。取消仅证明本地流/资源关闭，不保证供应商停止计费。

结果使用 verified/configured/unsupported/not_tested/inconclusive；只有端点结构化拒绝具体协议能力才记 unsupported，认证错误和无效模型不能伪装成不支持。结果绑定注册、端点、profile、有效设置和时间；设置改变失效、七天过期，不自动修改能力配置。[协议回归](../../tests/unit/providers/doctor.test.ts) 穿过真实 SDK 的离线 SSE fixture，不访问付费端点。

`/cost` 的单价由用户填写，默认未配置，无自动价格抓取、汇率或账单保证。按已结算请求派生估算，涵盖失败/重试、压缩、辅助请求及团队成员，reasoning 不重复计费；按币种分别汇总。缺 Usage、价格或必要缓存字段为 unknown/partial。单价随请求快照，不改写旧费用；请求 UUID 去重，冲突记录拒绝。阈值每任务每币种预警一次，不保证中断在途计费。Session、SDK/CLI JSONL 使用可选 estimate 事件，旧 Session 不推断金额或完整性。

## 评测证据

[扩展目录](../benchmark/EXPANDED_TASKS.json) 与 [证明](../../tests/unit/benchmark/expanded.test.ts) 区分八类合成场景和固定 node-pty 上游 Issue。外置评分器不在模型工作区；正常基线、缺陷与参考修复分别检查。#952 仅证明 helper 异常路径，不宣称完整 Windows 子进程清扫。源码树、依赖锁、seed/reference、评测代码共同冻结。

公开报告复用 planned/executed/skipped 账本，主指标为成功/计划；失败、超时、错误、取消和跳过并列，Unknown Usage 独立。来源/模型/端点标识/代码/构建/评测摘要与人工介入缺失时标证据不足。历史不同候选不合并，缺失日志不推断成功、失败或跳过。官方 DeepSeek 与中转的付费闭环保持未完成，未来需端点、原始模型 ID、凭据及明确 task/campaign 数值预算。

公开材料：[报告索引](../benchmark/PUBLIC_REPORT.md)、[历史导入](../benchmark/HISTORICAL_REPORT.json)、[未来 DeepSeek campaign](../benchmark/DEEPSEEK_CAMPAIGNS.json)。
