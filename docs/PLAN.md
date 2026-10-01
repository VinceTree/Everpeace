# 当前开发计划

产品目标是 DeepSeek 优先、Windows 优先的个人编码 CLI，以可验证完成率为首要目标。当前版本、提交和实测结果只见 [HANDOFF](HANDOFF.md)；机制见 [知识库](README.md)。旧阶段计划完整归档至 [PLAN_HISTORY](archive/PLAN_HISTORY.md)，不再作为当前待办。

## 本轮：让项目知识可以直接复用

- [x] 根 `AGENTS.md` 提供启动顺序、全局不变量与任务路由。
- [x] `docs/README.md` 提供唯一索引；`dosc/` 仅导航，避免副本分叉。
- [x] 新增产品概览、源码/测试地图、运行时、工具、状态/UI 和开发指南。
- [x] 保留现有权限、sandbox、集成、Memory、Agent Loop、TUI、评测深入说明，修正发现的过时结论。
- [x] 当前交接与历史记录分离，双语 README 加入知识库入口。
- [x] 核对新链接、文档差异和交付门禁；实际结果已写入 HANDOFF。

本轮不改变运行时行为。用户随后明确授权把展示版本提升至 `0.3.2` 并提交、推送；交付仍禁止 tag 和 GitHub Release。

## 已实现的能力里程碑

正确性与长任务机制已接入生产：任务所有的后台进程、统一 runner 结算、attempt 级请求与 usage、超时流关闭、有序有界读取池、原始字节文件版本、nested AGENTS、分页搜索、可选 TypeScript 导航。具体已知边界按 [RUNTIME](architecture/RUNTIME.md) 和 [TOOLS](architecture/TOOLS.md) 理解，不根据本列表推断真实模型验收完成。

内部评测具有生产 factory、固定 fixtures、seed/reference proof、隔离评分、随机运行计划、固定 dsh instrumentation 和数值预算准入。详见 [BENCHMARKING](BENCHMARKING.md)。不得用本地模拟或命令退出零宣称模型比较胜出。

## 后续优先顺序

| 顺序 | 工作 | 完成判据 / 前提 |
| --- | --- | --- |
| 1 | 验收固定 dsh checkout/profile 启动 | 安装/build 与无模型请求的配置、启动证据；失败如实记录 |
| 2 | 补 LSP 原生执行边界 | 保持显式配置和协议只读，补取消、进程清理及隔离回归；当前 host spawn 不算实现 |
| 3 | 真实模型九次 smoke | 另行授权 task/campaign 预算，验证三组执行器、计量、独立评分和产物 |
| 4 | 九十次正式比较 | 同模型、推理、预算与 OS；随机交错；统计完整才报告对比，不足样本不推广结论 |
| 5 | 真实 Windows Terminal 验收 | 失败→修复→完整通过、Ctrl+C、后台 writer 清理、Session 恢复和界面重放 |
| 6 | 日常能力增量 | 同项目历史检索、`@file`；按独立需求设计并补回归 |

这些待办用于规划，不授权付费请求、安装任意扩展、提交或发布。当前保持单 Agent、Responses、inline TUI、现有权限、high/32K 默认和完整最终验证；不以减少检查制造提速。

公开 headless/SDK/ACP、Session 分支、图片附件、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议继续后置。output-item 提前执行工具仅在供应商和持久化/恢复证据充分时单独评估，当前仍等待完整响应。

## 验收门槛

修改前根据 [PROJECT_MAP](architecture/PROJECT_MAP.md) 确认对应回归；尤其不得回退文件并发保护、取消清理、验证债务、unknown usage、工具配对和 Session 兼容。交付运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`，把无法执行和已有无关差异单独报告。

真实性能实验必须先没有正确性回归，固定样本的独立验收通过次数不低于当前基线；速度/token 实验还需测得双方均成功任务耗时或每成功任务 token 至少 15% 改善才考虑默认开启。campaign 未完成不排名，不把未知缓存状态称为冷缓存。

计划只维护当前目标和验收标准；本轮进展与新证据写 HANDOFF，长期机制更新相应专题，已确定契约变更同步 [DECISIONS](architecture/DECISIONS.md)。
