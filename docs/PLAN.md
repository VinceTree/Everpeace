# 当前开发计划

## DeepSeek Agent Loop 当前实施范围

工程实现已将 provider 指令投影、注册 profile、完整 reasoning 回传与恢复集中到共享生产入口；中转配置和实测能力分开。候选调度提示、精简描述及重复失败反馈显式 opt-in，默认 baseline；四路安全读取、危险操作屏障、持久化和验证结算边界保持。

新增两项离线兼容任务和 A/B 的六次 smoke、六十次正式配置，冻结实际候选及评测材料。本轮只运行无凭据证据，不发付费请求；原始报告保存在本地，首页不新增 DeepSeek 质量或节省宣称。当前工程门禁、fixture proof 和候选身份见 [HANDOFF](HANDOFF.md)，运行方式及待授权的数值预算见 [评测指南](BENCHMARKING.md#deepseek-loop-ab-acceptance)。

结论按三项维护：协议工程兼容、自然编码任务质量、token 效率。后两项在 live A/B 完成前保持 pending；逐任务质量不退、人工介入不增、安全结算无回退且计量完整，才能判断效率；共同成功任务 token 中位数下降至少 10% 才描述为该样本观察到节省。未经证实的候选优化不成为默认行为。

目标是完成 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript 单包个人开发 CLI 的工程能力，并取得付费实测条件。真实 Windows Terminal 必需场景已验收，实际发现的 resize 与历史监听器问题已修复并复验；最终候选门禁与交付状态见 [HANDOFF](HANDOFF.md)。工程准备与真实模型能力分开判断；当前版本、候选、检查数和收据只在交接维护。

本轮完善中转请求失败诊断、Web 搜索备用服务时限和重定向边界，并提供独立生产 runner 工具验收 fixture。后续继续完善 Responses 流结束诊断、Plan 修订审批与搜索相关性验收。详细实测结果只在本地保存；用户后续明确授权在双语 README 展示汇总图及范围说明。模型比较和成本优势需独立评测，不能从工具覆盖推断。

模型请求补齐环境 HTTP/HTTPS 代理及按 client 关闭连接；登录和主/辅助请求共用入口。验收器冻结自身摘要，网页场景增加搜索来源、实际读取与事实匹配断言。修复后的实测使用独立阶段，保留原阶段停止及未执行项；工程回归与 `/models` 连通性不能替代真实 Plan 或网页闭环。

## 九类能力验收矩阵

| 能力 | 生产入口 | 已有证据 | 剩余缺口 | 验收判定 |
| --- | --- | --- | --- | --- |
| 请求、DeepSeek 协议与预算 | ReactAgent / RequestExecutor / AuxiliaryRequestExecutor / TUI dependencies | 实际 SDK fake-fetch 契约；attempt ledger、stream、request settlement、auxiliary、Memory ownership 回归 | 真实模型稳定性、质量与成本留到授权付费阶段 | 工程回归；coding、修复、压缩、标题、Skill、Memory、doctor 逐请求准入与计量；unknown/预算停止/关闭禁止后续请求 |
| 项目理解与编辑 | 项目规则、project_map、read/search/attachments、apply_patch、workflow review | 根到目标规则、观察版本、审批并发、undo/rollback 回归；实际 TypeScript 四类查询，native write/state/network denial 与取消/权限收紧后的 PID 退出 | Windows Terminal 交互已验收；其他平台原生隔离不扩展承诺 | Windows 语义工程验收，探针失败继续阻止启动；恢复不重建观察或写授权 |
| 编码闭环 | CodingTaskRunner / CodingWorkflowRuntime / verifier | manifest 发现、全检查首败停止、repair 真正启动计数、无检查/环境失败/过期证据回归；native TUI test pass→build fail→repair→全 suite | 真实终端同流程已取得截图与 Session 证据 | 工程闭环；Windows 检查使用原生 batch shim；失败不能成功结算 |
| 长任务、权限与清理 | production executor、Codex buffered/duplex、后台命令、read wrappers、SkillManager | 实际取消、超时、后代 PID、迟到输出、cleanup settlement 和关闭准入；LSP cancel/permission-change 原生证据 | 真实 Windows Terminal Ctrl+C / 直接 ! 输入与进程收束已验收；任意后代不据受控样本扩大保证 | 受控工程验收；清理结束才退出，失败保持阻断 |
| Session、Memory 与恢复 | SessionStore / LearnedMemoryRuntime / store / runner | 重启/fork、压缩、unknown sticky、存储失败、idle 生命周期；个人副本真实长进程取消后重新装配 fork 债务；隔离 Memory UI | 真实终端恢复与 fork 已验收；真实模型学习质量需付费评测 | 工程回归；不恢复历史授权，运行任务不触发空闲学习 |
| Windows inline TUI | App / coordinator / Prompt / CommandScreen / terminal PTY | 真实 WT 窗口 Plan 修订/批准/显式执行、重复 Enter、guidance、权限变化、Ctrl+C、Esc、resize、中文/emoji、scrollback、滚轮/缩放、单 prompt、直接 !；隔离四扩展及重启恢复 | 真实模型质量另行付费验证；任意终端环境不据单一实机扩大保证 | 必需实际窗口验收通过；软件注入、截图和 JSONL 明确记录，失败尝试不记通过 |
| 公共入口与集成 | everpeace exec / everpeace/sdk runTask / Web / MCP / Skills | 共享 runner、退出码、输出背压与取消；MCP 真 stdio/HTTP、重连不重放；Web redirect / Skill preview confirmation 回归；SDK 安全补丁及锁文件 | 安装使用门禁和准确候选远端 CI 按最终交接记录；不扩展 OAuth/完整插件/多 Agent | 仅现有入口，兼容增量；SDK dependency alert 与实际调用路径分开记录 |
| 两套付费测试准备 | 开发 preparation fixtures / campaign preflight / 独立 evaluator | 四个隔离个人任务、冻结提示词/范围/断言/参考解及离线 accounting/cancel/fork；十项新 proof；三 harness 无凭据 preflight；9 smoke/90 正式 configs | 最终构建与 commit 后重新绑定 revision/source/build digest；真实终端门禁通过后才可提出付费阶段 | 准备与模型表现分开；每阶段独立数值授权，计划预算不构成授权 |
| 最终交付 | manifest gates / bilingual README / docs / Test CI | typecheck→不存在 lint→test→build 串行；真实候选绑定、安装、链接与 whitespace；[skip publish] 保留独立 CI | 每次代码变更重做相关证据；完整定位不能在必需项 pending 时关闭 | 门禁、失败、跳过与未验收在 HANDOFF 分别记录 |

源码与回归定位复用 [PROJECT_MAP](architecture/PROJECT_MAP.md)、[RUNTIME](architecture/RUNTIME.md)、[TOOLS](architecture/TOOLS.md)、[STATE_AND_UI](architecture/STATE_AND_UI.md)、[CODEX_CAPABILITIES](architecture/CODEX_CAPABILITIES.md) 与 [MEMORY](architecture/MEMORY.md)。本轮新增证据入口见 [实测准备](benchmark/READINESS.md) 与 [开发指南](DEVELOPMENT.md#离线-windows-terminal-手工验收)。

## 后续顺序与授权

1. 真实 Windows Terminal 必需验收已完成；发现的两项问题已修复并复验，失败尝试独立保留。
2. 将所有原生、公共安装及无凭据评测收据绑定最终候选；源码、锁文件或构建变化后重新准备。
3. 只有必需项均有通过证据才可写“可以开始有预算的 DeepSeek 实测”。用户分别授权个人任务与 smoke 后执行；发现请求、计量、隔离或清理异常立即停止并重做候选，再考虑正式比较。

用户已明确指定本轮展示版本，并授权提交和推送，禁止创建或更新 Release。提交包含 `[skip publish]`，不得 `[skip ci]`；不创建或推送 tag。保留本轮开始前用户全部未跟踪目录。真实工具检查已获授权；个人四任务、smoke 与正式 DeepSeek 对比仍是独立范围，其预算草案不构成授权或账单硬上限。本轮完整通过/失败结果与候选收据只保存在本地，当前交接记录本地入口与交付约束。
