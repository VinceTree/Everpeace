# Everpeace 开发知识库

本次优化实现、真实评测限制和复现入口见 [优化验收报告](implementation/REPORT.md)。

从 [AGENTS.md](../AGENTS.md) 和 [HANDOFF.md](HANDOFF.md) 开始，然后按当前任务选一至两个专题。这里保存产品定位、实现契约、源码与测试入口、开发操作和未验收边界；不要求每次从头阅读全部项目文件。

`docs/` 是唯一维护目录。[dosc/](../dosc/README.md) 保留为拼写导航入口。面向用户的安装及命令说明继续维护在 [English README](../README.md) 和 [中文 README](../README.zh-CN.md)。

新人贡献从 [CONTRIBUTING](../CONTRIBUTING.md) / [中文贡献指南](../CONTRIBUTING.zh-CN.md) 开始，无需先读内部交接。公开接口见 [兼容契约](COMPATIBILITY.md)，本轮状态见 [核心体验实施](core-experience/STATUS.md)。

## 文档地图

| 文件 | 解决什么问题 | 何时读取 |
| --- | --- | --- |
| [HANDOFF](HANDOFF.md) | 当前基线、本轮结果、未验证项、下一步 | 每个新 Session |
| [OVERVIEW](OVERVIEW.md) | 产品目标、能力全景、支持边界 | 初次理解产品或评估需求 |
| [PROJECT_MAP](architecture/PROJECT_MAP.md) | 能力 → 源码 → 测试 → 专题 | 定位实现和回归入口 |
| [TEAMS](architecture/TEAMS.md) | 调度、模型、团队计量、原生隔离、整合与恢复 | 修改多 Agent 协作 |
| [RUNTIME](architecture/RUNTIME.md) | 请求计量、模型循环、压缩、workflow、Goal | 修改编码行为或性能 |
| [NETWORK](architecture/NETWORK.md) | 公共 DNS/IP 连接、HTTP/HTTPS 代理、Git Skill 转发器 | 修改网页或远程 Skill 网络 |
| [TOOLS](architecture/TOOLS.md) | 文件观察、编辑、规则、搜索、后台命令、LSP | 修改编码工具 |
| [STATE_AND_UI](architecture/STATE_AND_UI.md) | Session/凭据/usage/恢复与终端不变量 | 修改状态或 UI |
| [SECURITY_AND_DIAGNOSTICS](architecture/SECURITY_AND_DIAGNOSTICS.md) | 私密报告、供应链、来源、搜索、doctor、估算和公开成绩 | 修改问题 11–20 |
| [VALIDATION_PRIVACY_PERFORMANCE](architecture/VALIDATION_PRIVACY_PERFORMANCE.md) | 验证解释、隐私、Memory 到期、子目录、正文与性能 | 修改问题 20–30 |
| [DEVELOPMENT](DEVELOPMENT.md) | 工具链、命令、测试、CI、交付 | 开始修改及交付前 |
| [WINDOWS_RUNNER](WINDOWS_RUNNER.md) | 专用 Windows 原生验收部署、发布门禁与失败演练 | 接入 Runner 与交付候选 |
| [PLAN](PLAN.md) | 当前里程碑、剩余证据、后续顺序 | 规划工作 |
| [DECISIONS](architecture/DECISIONS.md) | 跨模块约束及设计理由 | 改变既有契约 |
| [AGENT_LOOP](architecture/AGENT_LOOP.md) | 循环细节、顺序、停止、上游出处 | 修改调度/stream/steering |
| [SECURITY_HARDENING](architecture/SECURITY_HARDENING.md) | 文件竞态、敏感外传、验证依据、MCP 和隐私加固 | 修改安全边界 |
| [PERMISSIONS](architecture/PERMISSIONS.md) | 审批 profile、持久策略及差异 | 修改权限和审批 |
| [SANDBOX](architecture/SANDBOX.md) | 原生执行边界、平台限制和后续加固 | 修改 shell/进程隔离 |
| [CODEX_CAPABILITIES](architecture/CODEX_CAPABILITIES.md) | MCP/Skills/原生后端集成范围 | 修改外部集成 |
| [MEMORY](architecture/MEMORY.md) | 召回、聊天策略、后台学习与存储 | 修改 Memory |
| [TUI_STRUCTURE](architecture/TUI_STRUCTURE.md) | 终端目录职责与依赖方向 | 增加/移动 UI 模块 |
| [BENCHMARKING](BENCHMARKING.md) | fixtures、执行器、独立评分和预算 | 跑离线证明或筹备 live 比较 |
| [实测准备](benchmark/READINESS.md) | 个人四任务、十项固定 proof、候选身份与三阶段预算 | 准备 DeepSeek 实测 |
| [团队实测准备](benchmark/TEAM_READINESS.md) | 当前候选冻结、单 Agent/团队无凭据 preflight 与待授权配置 | 筹备当前团队对照 |
| [English usage](USAGE.md) / [中文使用](USAGE.zh-CN.md) | 完整命令、SDK、恢复与交互契约 | README 上手后查阅细节 |
| [历史归档](archive/README.md) | 旧交接、旧计划、当时的结果 | 追查设计来历时才读 |

## 最小阅读示例

- 修复“检查失败却完成 Goal”：`AGENTS → HANDOFF → RUNTIME`，然后打开链接中的 runner/runtime 测试与实现。
- 增加一个文件工具：`AGENTS → HANDOFF → TOOLS`，涉及权限时再读 `PERMISSIONS`。
- 调整 `/resume`：`AGENTS → HANDOFF → STATE_AND_UI`，再定位 SessionStore、App 和对应回归。
- 比较 dsh：`AGENTS → HANDOFF → BENCHMARKING`；历史计划和模拟测试不能替代真实比较数据。

文档未覆盖的问题先用 `rg` 在对应模块检索；只有定位失败或证据冲突时才扩大范围。修改实现前仍需读取目标函数及相关测试，避免文档与代码之间的版本差异。

## 知识的维护规则

| 发生变化 | 同步位置 |
| --- | --- |
| 功能、默认值、协议、接口、持久化或权限 | 对应专题 + 受影响 DECISIONS + HANDOFF |
| 模块/测试移动或新能力 | PROJECT_MAP + 对应专题；新专题加入本索引 |
| 待办范围、优先级或验收门槛 | PLAN；执行结果另写 HANDOFF |
| 用户命令、输出或安装方法 | 中英文 README + 对应专题 |
| 工具链、测试或 CI | DEVELOPMENT + HANDOFF 的实际检查结果 |
| 新验证或交付 | HANDOFF；明确日期、环境、命令、结果和未验证项 |

全局规则放根 `AGENTS`；模块契约与机制放专题；当前事实放 `HANDOFF`；历史放 `archive`。不把同一套详细说明复制到 `dosc/` 或多个新文件。已有深入专题继续保留，概览通过链接复用。

记录实现入口和测试路径，尽量不用容易漂移的行号。每次改动都检查本次文档相对链接有效、命令与 `package.json` 一致，核对交接中的“已完成”是否有依据。

“源码已接通”“本地回归通过”“真实环境已验收”是不同证据；分别描述。文档不得保存凭据、真实请求正文、用户文件内容或敏感验证输出。旧记录、待办和文档描述均不提供执行授权。
