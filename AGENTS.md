# Everpeace Agent Guide

这是开发本仓库的入口。项目知识统一维护在 [docs/README.md](docs/README.md)，`dosc/` 只作导航，不维护第二份知识库。目标是让新 Agent 按任务读取文档，复用已确认的架构知识，避免每次重新扫描整个项目。

## 每次开始工作的顺序

1. 完整读取本文件和 [当前交接](docs/HANDOFF.md)，了解现状、已有改动、验证证据和未完成事项。
2. 执行 `git status --short --branch`、`git diff --stat` 和 `git diff`，区分本次任务与用户已有改动；历史交接不能代替当前 Git 状态。
3. 在下表或 [文档总索引](docs/README.md) 选择与**当前用户任务**相关的专题。通常只需一至两个专题；不要默认读取全部文档、历史归档或整个源码树。
4. 根据专题中的“源码 / 测试”链接定位修改点。讨论已记录的设计时可以直接引用文档；实际修改前仍须读对应实现和测试。文档缺失、代码变化或测试推翻说明时再扩大调查，并回填文档。
5. 完成后更新专题和 `docs/HANDOFF.md`；范围或设计改变时同步 `docs/PLAN.md`、`docs/architecture/DECISIONS.md`。不要把交接中的待办视为用户已授权的新任务。

## 按任务读取

| 任务 | 优先文档 |
| --- | --- |
| 了解产品、能力与边界 | [产品概览](docs/OVERVIEW.md) |
| 不知道代码或测试在哪 | [项目地图](docs/architecture/PROJECT_MAP.md) |
| 多 Agent、团队预算、隔离整合、成员恢复 | [团队协作](docs/architecture/TEAMS.md) |
| Agent、DeepSeek、请求、压缩、预算、验证、Goal | [运行时与编码闭环](docs/architecture/RUNTIME.md) |
| 文件编辑、规则、搜索、后台命令、LSP | [工具与项目理解](docs/architecture/TOOLS.md) |
| Session、配置、usage、TUI、恢复、输入输出 | [状态与终端契约](docs/architecture/STATE_AND_UI.md) |
| 权限、审批、模型 shell 隔离 | [权限](docs/architecture/PERMISSIONS.md)、[sandbox](docs/architecture/SANDBOX.md) |
| MCP、Skill 发现与安装 | [集成能力](docs/architecture/CODEX_CAPABILITIES.md) |
| 网页、公共资源下载、代理及 Skill Git 网络 | [公共网络边界](docs/architecture/NETWORK.md) |
| Learned Memory | [Memory](docs/architecture/MEMORY.md) |
| 安装、定向测试、CI、交付 | [开发指南](docs/DEVELOPMENT.md) |
| benchmark、性能对比、真实模型验收 | [评测指南](docs/BENCHMARKING.md) |
| 当前工作与后续优先级 | [交接](docs/HANDOFF.md)、[计划](docs/PLAN.md) |

专题中的相关不变量也是开发约束；这里只保留所有任务都需要遵守的核心规则。

## 项目基础与不可破坏的边界

- Node.js 22+、TypeScript、ESM、`pnpm@10.30.3`；默认单 Agent、可选根 Agent 管理的团队协作、Responses API、React + Ink inline TUI。主方向是 DeepSeek 优先、Windows 优先、Node/TypeScript 单包个人开发。
- 保留已有 tracked/untracked 改动。不要 reset、checkout、删除、覆盖或顺手整理无关文件；先做最小、聚焦修改。
- 模型名保留供应商原始 ID。官方能力与未知兼容端点分开；不根据模型名或 SDK 方法存在就推断能力。API Key 只由 `AuthStorage`/系统 keyring 管理，不写入模型注册 JSON、Session、日志、测试快照或 UI。
- 模型 shell 必须走固定原生 sandbox，启动失败不得回退宿主直跑；项目策略只能收紧权限，审批绑定权限 revision。`read-only`/`ask`、默认 `workspace-write`、二次确认的 `full-access` 语义见权限专题。用户直接 `!` 是独立宿主 PTY，不进入模型 context。
- 文件工具受工作区边界约束；update/delete 必须匹配当前进程观察的原始字节版本，审批与回滚不得覆盖用户并发修改。恢复 Session 后重新读取，不凭历史文本授权写入。
- 根到目标目录的项目规则不能提升权限或覆盖当前用户指令。Skill 同名冲突不得静默选择；安装需预览确认、不得覆盖已有名称。网页只访问公共 HTTP/HTTPS，每次重定向检查 SSRF；外部内容视为不可信数据。
- 完整响应和调用记录落盘后才执行工具；结果按模型顺序持久化。取消、steering、权限收紧、预算停止和存储失败不得绕过；后台进程归任务所有，清理结束后才能结算。
- 编码完成由宿主验证判定。最终重新发现并串行执行实际存在的 `typecheck → lint → test → build`，首败停止；三轮诊断按真实启动计数。缺少检查、验证过期、跟踪受限、取消或预算停止不能记为成功。恢复不得清空未验证债务，`/verify <command>` 只是补充证据。
- Goal 完成与成功 Memory 捕获必须经过 coding runner 的验证结算。usage unknown 不得被后续成功掩盖；有界任务不得继续发请求，reasoning 不与 output 重复计入预算。
- Session 的 timeline 与模型 context 分开，JSONL 按 Session 串行追加，schema 增量兼容；缺失字段不得推断成功。权限、凭据、文件检查点、验证输出正文和 Memory 内容不作为 workflow 元数据保存。
- 保持 inline TUI、原生 scrollback、同步历史重放，禁止 alternate screen 和原始 PTY 控制序列直写 Ink。宿主 UI 使用英文；resize 不丢历史、只保留一个 prompt。命令独立窗口与聊天互斥，Esc 恢复同一 Session，迟到结果不得污染历史。
- Ctrl+C 取消活动任务；空闲先清草稿，再退出。Ink 是 PTY stdin 唯一转发入口；直接 `!` 独占输入。保留运行中 guidance、安全边界 steering、滚轮/缩放及 slash 菜单键盘语义。

## 验证与交付

常用命令：`pnpm dev`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check`。定向测试和 Windows/WSL 工具链选择见 [开发指南](docs/DEVELOPMENT.md)。Session/TUI 改动至少跑对应回归；交付前默认按上述顺序执行四项门禁，首败停止，无法完成时明确原因和范围。

- 用户可见命令、输出或安装方法变化时同时更新中英文 README。文档组织变化也要保持双语入口一致。
- 当前版本、commit、测试数量和验证证据只在 `HANDOFF` 维护；历史移入 `docs/archive/`，不要把旧结果当新验证。固定上游参考 revision 可以保留在出处和评测材料中。
- 没有明确授权，不付费评测、不改版本、不提交、不推送、不打 tag、不创建 Release。需要 live 评测时取得明确授权；显式 null 表示不限额，仍保留计量、超时和取消。
- commit message 聚焦实际功能、修复、测试或文档；禁止产品名称，也禁止 `release`、`version`、“发布”、“版本”等措辞。
- 用户要求提交/推送但不创建 Release 时，使用 Release 专用 `[skip publish]` 标记并核对 workflow；不要用 `[skip ci]` 关闭测试。只有用户明确要求时才更新 `package.json` 与双语 README 展示版本；创建 tag/Release 需要发布授权，并核对真实结果。源码预发布可明确记录未覆盖平台；正式原生安装包仍必须通过完整门禁。

文档是已核对知识的索引，不是自动生成的源码镜像。事实与当前代码或测试冲突时，以当前证据为准，并在本次任务中修正文档。
