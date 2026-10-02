# 当前开发计划

产品保持 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript、Responses 与 inline TUI。当前提交、版本、门禁和未验收项见 [HANDOFF](HANDOFF.md)；稳定机制从 [知识库](README.md) 进入；已完成阶段保存在 [PLAN_HISTORY](archive/PLAN_HISTORY.md)。

## 当前里程碑：长任务恢复与后续四项对齐

比较基线为本轮开始的 Everpeace `63b40af5a7896fbfc35c20b1355f4b4910b11bbe` 与本地 DeepSeek Harness 官方 checkout `639ed015397290b3745d163aafe02ffee4aa3f84`。当前实现保持既有模型默认参数、权限和宿主验证规则。

- [x] 持久化大工具输出，并提供同工作区 `session_search`、`session_event_search`、`session_event_read`；跨压缩和重启保留恢复引用，learned Memory 保持独立。
- [x] 为每个 MCP server 增加独立重连生命周期、原子工具目录热更新和 step 绑定；中断的工具调用不重放，旧定义不能在重连或变更后调用。
- [x] 固定 `@vscode/ripgrep@1.18.0`，通过包内绝对路径和 `--no-config` 接入 search/glob、`@` 选择器与 doctor；缺少平台 optional package 时明确 unavailable。
- [x] 公开 `everpeace exec`：位置参数或 stdin 输入、ID/唯一名称模型解析、普通 Session、共享生产 runner、任务级预算/时限/step、纯文本或 schema 1 JSONL、固定退出码和交互停止。
- [x] 增加空闲本地 Session 的 `/fork [title]`、独立附件副本、lineage、持久 `fork_pending_resume` 与只读 `session_relations`。
- [x] 在自动压缩压力和 context-limit recovery 前尝试可恢复的无模型工具结果裁剪；`context_pruned` 先持久化，累计 usage 不变，只有当前 `context_tokens` 变为 unknown。
- [x] 同步双语 README、开发安装、架构、决策、交接和历史归档。
- [x] 串行完成本工作区最终 `pnpm typecheck → pnpm test → pnpm build`，再做本轮差异与文档一致性检查；实际结果只写入 HANDOFF。
- [ ] 在真实 Windows Terminal 手工验收恢复、分支、取消、resize/scrollback 和单 prompt；自动化不能替代此项。

## 已冻结的交付边界

| 领域 | 当前契约 | 详细说明 |
| --- | --- | --- |
| MCP | 500 ms 起步、30 秒封顶、最多十次；稳定 30 秒才重置；断连移除工具，五秒关闭超时即停止恢复；调用不重放 | [Codex 能力](architecture/CODEX_CAPABILITIES.md) |
| exec | CLI + JSONL；每次新建可恢复 Session；读取既有 Memory、关闭本次 capture；审批或问题以退出码 5 停止 | [状态与界面](architecture/STATE_AND_UI.md)、[运行时](architecture/RUNTIME.md) |
| 分支 | 只分支空闲 Session 已提交 EOF；父子附件独立；验证债务保留，Goal/观察/审批/旧成功证据清除 | [状态与界面](architecture/STATE_AND_UI.md) |
| 裁剪 | 只处理早期闭合且可由持久历史唯一恢复的大工具结果；最近两个单元、open chain、Memory、历史/续读结果等受保护 | [Agent Loop](architecture/AGENT_LOOP.md) |
| 搜索 | 不使用系统 `PATH` 中的 rg；平台包缺失即明确 unavailable，不静默回退 | [工具](architecture/TOOLS.md)、[开发](DEVELOPMENT.md) |

## 独立后续

1. 解决 Windows TypeScript LSP 原生隔离探针失败，并在不回退宿主直跑的前提下扩展通用 server pool。
2. 如确有调用方需求，再设计公开 TypeScript SDK；当前 `everpeace exec` 不承诺 ACP 或通用 app-server。
3. 单独评估 MCP OAuth、header helper、elicitation、sampling、tasks、resources/prompts 热更新和按工具持久审批。
4. 只有在固定任务、真实 provider 证据和明确数值预算齐备后，才进行真实模型比较或协议/性能调优。

图片、多 Agent、Web/Desktop、完整插件化、自研 sandbox 和新协议仍不属于当前产品方向。持久 undo、LSP pooling 与 item-level 工具提前执行继续作为独立项目，不因本里程碑自动获得授权。

## 验收与真实性约束

不得破坏文件并发保护、取消清理、验证债务、unknown usage、工具配对和旧 Session 兼容。没有 lint script 时明确记录未运行；平台跳过、基础设施失败和手工未验收分别报告。

fake provider、fixture proof 和退出零只证明对应宿主路径，不证明真实模型成功率、速度或 token 改善。真实 API smoke、正式 dsh 比较与付费调用需要另行授权及 task/campaign 数值预算；campaign 未完整执行不得排名。
