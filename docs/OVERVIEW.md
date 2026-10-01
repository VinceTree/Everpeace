# 产品定位与能力全景

Everpeace 是 **DeepSeek 优先、Windows 优先的个人开发 CLI**：在终端理解需求和项目约束，读取与修改代码，执行检查，修复失败，交付有宿主验证依据的结果。当前重点是 Node/TypeScript 单包项目。

当前版本、提交和最近验证见 [HANDOFF](HANDOFF.md)，后续范围见 [PLAN](PLAN.md)。本页说明已经接入的能力与限制，不表示全部经过真实模型或所有平台端到端验收。

## 技术与运行形态

Node.js + TypeScript ESM；React/Ink 提供 inline 终端交互。一个 Responses ReAct Agent 调用工作区工具，`CodingTaskRunner` 统一任务清理、诊断、最终检查和完成结算。模型 shell 使用固定原生执行后端；用户直接 `!` 使用独立交互 PTY。

支持官方 DeepSeek、OpenAI 和兼容 Responses 端点；保留原始 model ID。供应商能力显式声明，未知端点保守处理。编码默认 `high` 推理、32K 输出预算；这是产品默认，不代表未知模型的硬上限。详见 [运行时](architecture/RUNTIME.md)。

## 能力地图

| 能力 | 当前行为 | 深入说明 |
| --- | --- | --- |
| 需求与项目理解 | root-to-target `AGENTS.md`、package scripts、按需 Skill、Memory 与运行中 guidance | [工具](architecture/TOOLS.md)、[Memory](architecture/MEMORY.md) |
| 文件与搜索 | 分页读取、目录、有界保留的 ripgrep search/glob、结果续读、显式配置的 TS 语义导航 | [工具](architecture/TOOLS.md) |
| 受保护的编辑 | 宿主读版本、审批绑定、BOM/换行保留、排他创建、冲突回滚和进程内 undo | [工具](architecture/TOOLS.md) |
| 命令执行 | 受权限约束的 sandbox shell、任务所有的后台命令、poll/stop、有界预览与持久完成通知 | [sandbox](architecture/SANDBOX.md) |
| 验证与修复 | 最新 manifest 全集合检查、三轮诊断、快照过期检测与验证债务 | [运行时](architecture/RUNTIME.md) |
| Plan / Task / Goal | Plan 与 coding 结构化问题、持久执行清单；Session 绑定 Goal、预算与宿主完成门槛 | [状态](architecture/STATE_AND_UI.md) |
| 长任务 | 完整工具配对、按能力选择压缩、取消/失败保留 context、按 attempt 计量 | [运行时](architecture/RUNTIME.md) |
| Session | JSONL、分离的 timeline/context、恢复模型和目录、跨请求 usage | [状态](architecture/STATE_AND_UI.md) |
| Learned Memory | 项目/用户分层召回、聊天策略、验证后后台提炼与审查 | [Memory](architecture/MEMORY.md) |
| 外部信息与扩展 | 公共 Web、MCP tools/resources/prompts、主机 Skills 与安装向导 | [集成](architecture/CODEX_CAPABILITIES.md) |
| 终端体验 | 英文宿主 UI、Markdown、独立命令窗口、输入历史、steering、PTY、取消和重放 | [状态](architecture/STATE_AND_UI.md) |
| 诊断与评测 | `/doctor` 本地探测、显式 live；内部 campaign、独立评分、固定 fixtures | [评测](BENCHMARKING.md) |

命令的参数和用户操作以 [中文 README](../README.zh-CN.md#使用) / [English README](../README.md#usage) 为入口，开发定位使用 [PROJECT_MAP](architecture/PROJECT_MAP.md)。

## 成功的定义

模型声称完成不等于代码验证通过。宿主追踪本轮变化，收束后台任务，对当前内容运行项目声明的完整检查。`verified / unverified / failed / no_changes` 分别保留，取消、预算停止和环境不可用不得转为成功。

恢复 Session 不能清空未验证债务；只有适用的当前完整验证才能结算代码 Goal 和成功学习。benchmark 还需 evaluator-owned 独立评分，工作区内脚本退出零不能独自决定通过。

## 明确的边界

- 主产品仍是单 Agent 终端工具；内部 benchmark launcher 不等于公开 headless/SDK/ACP。没有多 Agent 调度、Web/Desktop 或完整插件架构。
- MCP OAuth/elicitation/tasks 等高级生命周期、私有认证 Skill 安装及 Skill 更新/删除不属于当前完整支持范围；具体支持列表见集成文档。
- 读取和编辑有宿主路径/版本保护；不要把所有本地工具都描述成 OS sandbox 隔离。显式配置的 LSP 通过固定原生 read-only sandbox 启动并先验证网络隔离；后端不满足探针时失败关闭，当前固定 Windows 后端因此尚不可用。
- Learned Memory 是不可信召回背景，不替代当前指令、项目规则、真实工具结果或验证证据。
- 自动测试、fixtures 离线证明、真实模型比较与真实 Windows Terminal 是不同验收。尚无充分证据宣称编码成功率或性能优于 dsh。
- 真实 API 评测需额外授权和数值预算；token 准入不能保证供应商账单硬封顶，在途请求可能超出剩余预算。

具体未验收项只在 [HANDOFF](HANDOFF.md) 跟踪，避免每份概览维护不同进度。
