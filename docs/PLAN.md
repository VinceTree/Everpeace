# 当前开发计划

产品目标是 DeepSeek 优先、Windows 优先的个人编码 CLI，以可验证完成率和日常使用效率为首要目标。当前版本、提交和实测结果只见 [HANDOFF](HANDOFF.md)；机制见 [知识库](README.md)。旧阶段计划完整归档至 [PLAN_HISTORY](archive/PLAN_HISTORY.md)，不再作为当前待办。

## 本轮：Coding reliability

- [x] 可复现比较准备：以 `b226bfc` 为 tracked baseline，为 baseline/candidate 增加命名 checkout identity 与相同 fresh-process worker；三种 campaign 模式互斥，preflight 不读取凭据或发送真实 provider 请求。
- [x] 完整模型变更审阅：增加 captured `list_workspace_changes` / lazy `read_workspace_change`，复用 `/diff` 安全服务并保留旧工具兼容。
- [x] 精确编辑与恢复：update 支持唯一精确 replace，并在解析、预览、执行返回稳定错误原因和修复建议。
- [x] 隔离 LSP 导航：每次查询通过 pinned native sandbox 的 duplex 进程，验证 capability/UTF-16，限制协议流量、取消并等待清理。
- [x] 保持 JSONL 兼容、单 Agent、既有权限/取消/验证边界；双语 README 与相关架构文档同步。
- [x] 完成本轮串行 `typecheck → test → build`；全局 `git diff --check` 仅被任务前已有 `.gitignore` / `LICENSE` CRLF 差异阻断，本轮文件定向空白扫描通过，真实结果写入 HANDOFF。

本轮不升级依赖、不改版本、不提交、不推送、不创建 tag/Release，也不执行付费评测。Windows LSP native probe 已执行并证明当前 backend 的网络隔离不可用；固定 dsh checkout/profile preflight、Linux/macOS LSP 探针和 Windows Terminal 手工验收仍需相应外部环境，未执行时必须保持为待验收。

## 已实现的能力里程碑

正确性与长任务机制已接入生产：任务所有的后台进程、统一 runner 结算、attempt 级请求与 usage、超时流关闭、有序有界读取池、原始字节文件版本、nested AGENTS、分页搜索、可选 TypeScript 导航。新的日常能力复用这些边界：附件不授予写权限，人工 diff 不改变模型工具，Session 搜索不创建持久索引，请求检查不从历史伪造快照。具体机制按 [RUNTIME](architecture/RUNTIME.md)、[TOOLS](architecture/TOOLS.md) 和 [STATE_AND_UI](architecture/STATE_AND_UI.md) 理解。

内部评测具有生产 factory、固定 fixtures、seed/reference proof、隔离评分、随机运行计划、固定 dsh instrumentation 和数值预算准入。详见 [BENCHMARKING](BENCHMARKING.md)。不得用本地模拟或命令退出零宣称模型比较胜出。

## 后续优先顺序

| 顺序 | 工作 | 完成判据 / 前提 |
| --- | --- | --- |
| 1 | 验收固定 dsh checkout/profile preflight | 在 pinned upstream build 上运行无凭据启动门禁，核对 provider-boundary、socket guard、ledger 与进程清理证据 |
| 2 | 取得可用的 LSP 原生网络隔离 | Windows 已证明 workspace 写入与应用状态读取被拒绝，但固定 backend 仍允许直接 socket，运行时会失败关闭；后续 backend/platform 必须通过相同探针 |
| 3 | 真实模型九次 smoke | 另行授权 task/campaign 预算，验证三组执行器、计量、独立评分和产物 |
| 4 | 九十次正式比较 | 同模型、推理、预算与 OS；随机交错；统计完整才报告对比，不足样本不推广结论 |
| 5 | 真实 Windows Terminal 验收 | 文件候选、diff、resume、context、resize、Esc、Ctrl+C、后台 writer、Session 恢复与界面重放 |

这些待办用于规划，不授权付费请求、安装任意扩展、提交或发布。当前保持单 Agent、Responses、inline TUI、现有权限、high/32K 默认和完整最终验证。

持久 undo、LSP pooling/更多 semantic operation、模糊编辑、自动历史检索和模型速度/token 调优作为独立后续工作。公开 headless/SDK/ACP、Session 分支、图片附件、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议继续后置。output-item 提前执行工具仅在供应商和持久化/恢复证据充分时单独评估，当前仍等待完整响应。

## 验收门槛

修改前根据 [PROJECT_MAP](architecture/PROJECT_MAP.md) 确认对应回归；尤其不得回退文件并发保护、取消清理、验证债务、unknown usage、工具配对和 Session 兼容。交付按 `typecheck → test → build` 串行执行，再运行 `git diff --check`；仓库当前没有 lint script。把无法执行、真实 Windows Terminal 未验收和已有无关差异单独报告。

真实性能实验必须先没有正确性回归，固定样本的独立验收通过次数不低于当前基线；速度/token 实验还需测得双方均成功任务耗时或每成功任务 token 至少 15% 改善才考虑默认开启。campaign 未完成不排名，不把未知缓存状态称为冷缓存。

计划只维护当前目标和验收标准；本轮进展与新证据写 HANDOFF，长期机制更新相应专题，已确定契约变更同步 [DECISIONS](architecture/DECISIONS.md)。
