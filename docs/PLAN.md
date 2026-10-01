# 当前开发计划

产品目标是 DeepSeek 优先、Windows 优先的个人编码 CLI，以可验证完成率和日常使用效率为首要目标。当前版本、提交和实测结果只见 [HANDOFF](HANDOFF.md)；机制见 [知识库](README.md)。旧阶段计划完整归档至 [PLAN_HISTORY](archive/PLAN_HISTORY.md)，不再作为当前待办。

## 本轮：Daily coding reliability

- [x] 普通 coding 与 Plan 共用阻塞式 `request_user_input`，分别保持活动任务取消和规划取消语义；回答按标准工具结果持久化，不能授予权限。
- [x] 增加 Session 持久化的 `TaskProgress` / `update_plan`、请求动态上下文、状态栏摘要和只读 `/tasks`；repair、Goal continuation 与显式 resume 保留，新用户任务清空，验证权仍归宿主。
- [x] 后台 job 终态以 task generation 隔离并在下一 step 持久送达；运行项和未送达通知合计最多 20，取消先关闭通知准入，正文继续通过 poll 获取。
- [x] 搜索 continuation 最多保留 16 个搜索和 8 MiB 序列化 payload；读完、淘汰和 dispose 释放，未终止超长记录也受单次 2 MiB 输入边界约束。
- [x] 完成本轮串行 `typecheck → test → build`、本轮文件定向空白检查和差异审阅；全局 CRLF 差异及真实 Windows Terminal 验收在 HANDOFF 单独记录。

用户随后明确授权更新版本、提交并推送；交付使用 `[skip publish]`，仅推送分支，不更新 tag/Release。无需依赖升级或付费评测；功能验证使用确定性的 fake provider/process fixture，不发 live 模型请求。

## 已实现的能力里程碑

正确性与长任务机制已接入生产：任务所有的后台进程、统一 runner 结算、attempt 级请求与 usage、超时流关闭、有序有界读取池、原始字节文件版本、nested AGENTS、分页搜索、可选 TypeScript 导航。新的日常能力复用这些边界：附件不授予写权限，人工 diff 不改变模型工具，Session 搜索不创建持久索引，请求检查不从历史伪造快照。具体机制按 [RUNTIME](architecture/RUNTIME.md)、[TOOLS](architecture/TOOLS.md) 和 [STATE_AND_UI](architecture/STATE_AND_UI.md) 理解。

内部评测具有生产 factory、固定 fixtures、seed/reference proof、隔离评分、随机运行计划、固定 dsh instrumentation 和数值预算准入。详见 [BENCHMARKING](BENCHMARKING.md)。不得用本地模拟或命令退出零宣称模型比较胜出。

## 后续优先顺序

| 顺序 | 工作 | 完成判据 / 前提 |
| --- | --- | --- |
| 1 | 真实 Windows Terminal 验收 | `/tasks`、coding 问题、resize、scrollback、Esc/Ctrl+C、一个 prompt、后台完成通知与 Session 恢复 |
| 2 | 模型可访问的压缩后历史检索 | 先定义不泄露权限/凭据且不让旧历史覆盖当前投影的范围、索引和引用失效契约 |
| 3 | 公开 headless execution | 复用 `CodingTaskRunner`、验证权、预算和清理，不把内部 benchmark adapter 直接当公共 API |
| 4 | Session conversation branching | 定义 timeline/context/Goal/workflow/TaskProgress 的分支所有权及 JSONL 兼容迁移 |
| 5 | 取得可用的 LSP 原生网络隔离 | Windows 固定 backend 仍允许直接 socket，运行时失败关闭；后续 backend/platform 必须通过相同探针 |

这些待办用于规划，不授权付费请求、安装任意扩展、提交或发布。当前保持单 Agent、Responses、inline TUI、现有权限、high/32K 默认和完整最终验证。

持久 undo 是独立恢复项目。LSP pooling/更多 semantic operation、模糊编辑和模型速度/token 调优作为后续工作；固定 dsh preflight 与真实模型比较仍需对应环境及单独预算授权。图片附件、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议继续后置。output-item 提前执行工具仅在供应商和持久化/恢复证据充分时单独评估，当前仍等待完整响应。

## 验收门槛

修改前根据 [PROJECT_MAP](architecture/PROJECT_MAP.md) 确认对应回归；尤其不得回退文件并发保护、取消清理、验证债务、unknown usage、工具配对和 Session 兼容。交付按 `typecheck → test → build` 串行执行，再运行 `git diff --check`；仓库当前没有 lint script。把无法执行、真实 Windows Terminal 未验收和已有无关差异单独报告。

真实性能实验必须先没有正确性回归，固定样本的独立验收通过次数不低于当前基线；速度/token 实验还需测得双方均成功任务耗时或每成功任务 token 至少 15% 改善才考虑默认开启。campaign 未完成不排名，不把未知缓存状态称为冷缓存。

计划只维护当前目标和验收标准；本轮进展与新证据写 HANDOFF，长期机制更新相应专题，已确定契约变更同步 [DECISIONS](architecture/DECISIONS.md)。
