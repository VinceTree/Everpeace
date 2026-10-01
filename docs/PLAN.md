# 当前开发计划

产品目标是 DeepSeek 优先、Windows 优先的个人编码 CLI，以可验证完成率和日常使用效率为首要目标。当前版本、提交和实测结果只见 [HANDOFF](HANDOFF.md)；机制见 [知识库](README.md)。旧阶段计划完整归档至 [PLAN_HISTORY](archive/PLAN_HISTORY.md)，不再作为当前待办。

## 本轮：日常使用优化

- [x] Composer 文件引用：`@` 文件候选、显式路径/行范围、提交前新鲜读取、有界一次性附件、guidance/持久化/规则发现与写权限隔离。
- [x] 可读 `/diff`：staged、unstaged、untracked 条目，惰性 unified diff/文本预览，特殊文件摘要、分页、刷新和分层 Esc。
- [x] 可搜索 `/resume [query]`：当前工作区默认、全部工作区切换、标题/对话字面量搜索、本地预览、分页和 16 MiB 瞬时投影缓存。
- [x] 只读 `/context`：在实际 coding 请求准入边界捕获内存快照，展示估算、来源、工具、附件、条目与脱敏预览。
- [x] 保持 JSONL 兼容、单 Agent、既有恢复路径、权限/取消/验证边界；双语 README 与相关架构文档同步。
- [x] 完成串行 `typecheck → test → build` 与 `git diff --check`，将真实结果写入 HANDOFF。

本轮不升级依赖、不创建 tag/Release，也不执行付费评测。用户随后明确授权把展示版本提升至 `0.3.3` 并提交、推送；交付使用 `[skip publish]`，测试 CI 仍保持启用。

## 已实现的能力里程碑

正确性与长任务机制已接入生产：任务所有的后台进程、统一 runner 结算、attempt 级请求与 usage、超时流关闭、有序有界读取池、原始字节文件版本、nested AGENTS、分页搜索、可选 TypeScript 导航。新的日常能力复用这些边界：附件不授予写权限，人工 diff 不改变模型工具，Session 搜索不创建持久索引，请求检查不从历史伪造快照。具体机制按 [RUNTIME](architecture/RUNTIME.md)、[TOOLS](architecture/TOOLS.md) 和 [STATE_AND_UI](architecture/STATE_AND_UI.md) 理解。

内部评测具有生产 factory、固定 fixtures、seed/reference proof、隔离评分、随机运行计划、固定 dsh instrumentation 和数值预算准入。详见 [BENCHMARKING](BENCHMARKING.md)。不得用本地模拟或命令退出零宣称模型比较胜出。

## 后续优先顺序

| 顺序 | 工作 | 完成判据 / 前提 |
| --- | --- | --- |
| 1 | 验收固定 dsh checkout/profile 启动 | 安装/build 与无模型请求的配置、启动证据；失败如实记录 |
| 2 | 补 LSP 原生执行边界 | 保持显式配置和协议只读，补取消、进程清理及隔离回归；当前 host spawn 不算实现 |
| 3 | 真实模型九次 smoke | 另行授权 task/campaign 预算，验证三组执行器、计量、独立评分和产物 |
| 4 | 九十次正式比较 | 同模型、推理、预算与 OS；随机交错；统计完整才报告对比，不足样本不推广结论 |
| 5 | 真实 Windows Terminal 验收 | 文件候选、diff、resume、context、resize、Esc、Ctrl+C、后台 writer、Session 恢复与界面重放 |

这些待办用于规划，不授权付费请求、安装任意扩展、提交或发布。当前保持单 Agent、Responses、inline TUI、现有权限、high/32K 默认和完整最终验证。

持久 undo、LSP 隔离、自动历史检索和模型速度/token 调优作为独立后续工作。公开 headless/SDK/ACP、Session 分支、图片附件、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议继续后置。output-item 提前执行工具仅在供应商和持久化/恢复证据充分时单独评估，当前仍等待完整响应。

## 验收门槛

修改前根据 [PROJECT_MAP](architecture/PROJECT_MAP.md) 确认对应回归；尤其不得回退文件并发保护、取消清理、验证债务、unknown usage、工具配对和 Session 兼容。交付按 `typecheck → test → build` 串行执行，再运行 `git diff --check`；仓库当前没有 lint script。把无法执行、真实 Windows Terminal 未验收和已有无关差异单独报告。

真实性能实验必须先没有正确性回归，固定样本的独立验收通过次数不低于当前基线；速度/token 实验还需测得双方均成功任务耗时或每成功任务 token 至少 15% 改善才考虑默认开启。campaign 未完成不排名，不把未知缓存状态称为冷缓存。

计划只维护当前目标和验收标准；本轮进展与新证据写 HANDOFF，长期机制更新相应专题，已确定契约变更同步 [DECISIONS](architecture/DECISIONS.md)。
