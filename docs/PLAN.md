# 当前开发计划

目标仍是完成 DeepSeek 优先、Windows 优先、单 Agent、Node/TypeScript 单包个人开发 CLI 的工程能力，并取得付费实测条件。当前总目标保持 **active**：真实 Windows Terminal 的必需操作证据尚未齐备，不能因为自动回归、提交或评测装配通过就宣布定位完成。当前版本、候选、检查数和收据只在 [HANDOFF](HANDOFF.md) 维护。

## 九类能力验收矩阵

| 能力 | 生产入口 | 已有证据 | 剩余缺口 | 验收判定 |
| --- | --- | --- | --- | --- |
| 请求、DeepSeek 协议与预算 | ReactAgent / RequestExecutor / AuxiliaryRequestExecutor / TUI dependencies | 实际 SDK fake-fetch 契约；attempt ledger、stream、request settlement、auxiliary、Memory ownership 回归 | 真实模型稳定性、质量与成本留到授权付费阶段 | 工程回归；coding、修复、压缩、标题、Skill、Memory、doctor 逐请求准入与计量；unknown/预算停止/关闭禁止后续请求 |
| 项目理解与编辑 | 项目规则、project_map、read/search/attachments、apply_patch、workflow review | 根到目标规则、观察版本、审批并发、undo/rollback 回归；实际 TypeScript 四类查询，native write/state/network denial 与取消/权限收紧后的 PID 退出 | Windows Terminal 交互体验独立验收；其他平台原生隔离不扩展承诺 | Windows 语义工程验收，探针失败继续阻止启动；恢复不重建观察或写授权 |
| 编码闭环 | CodingTaskRunner / CodingWorkflowRuntime / verifier | manifest 发现、全检查首败停止、repair 真正启动计数、无检查/环境失败/过期证据回归；native TUI test pass→build fail→repair→全 suite | 真实终端同流程待取得实际操作证据 | 工程闭环；Windows 检查使用原生 batch shim；失败不能成功结算 |
| 长任务、权限与清理 | production executor、Codex buffered/duplex、后台命令、read wrappers、SkillManager | 实际取消、超时、后代 PID、迟到输出、cleanup settlement 和关闭准入；LSP cancel/permission-change 原生证据 | 真实 Windows Terminal Ctrl+C / 直接 ! 输入与进程收束；任意后代不据受控样本扩大保证 | 受控工程验收；清理结束才退出，失败保持阻断 |
| Session、Memory 与恢复 | SessionStore / LearnedMemoryRuntime / store / runner | 重启/fork、压缩、unknown sticky、存储失败、idle 生命周期；个人副本真实长进程取消后重新装配 fork 债务；隔离 Memory UI | 真实终端恢复与 fork 体验；真实模型学习质量需付费评测 | 工程回归；不恢复历史授权，运行任务不触发空闲学习 |
| Windows inline TUI | App / coordinator / Prompt / CommandScreen / terminal PTY | Ink 与生产 Plan 回归、ConPTY 修改修复流程、隔离 Memory/MCP/Skills/navigation 实际调用；真实 WT 启动尝试记录 | 焦点不可获得，真实按键、重复 Enter、guidance、审批期间权限变化、Ctrl+C、Esc、resize、中文/emoji、scrollback、滚轮/缩放、单 prompt 仍 pending | **未完成必需实际终端验收**；ConPTY 与自动化不冒充真实窗口结果 |
| 公共入口与集成 | everpeace exec / everpeace/sdk runTask / Web / MCP / Skills | 共享 runner、退出码、输出背压与取消；MCP 真 stdio/HTTP、重连不重放；Web redirect / Skill preview confirmation 回归；SDK 安全补丁及锁文件 | 安装使用门禁和准确候选远端 CI 按最终交接记录；不扩展 OAuth/完整插件/多 Agent | 仅现有入口，兼容增量；SDK dependency alert 与实际调用路径分开记录 |
| 两套付费测试准备 | 开发 preparation fixtures / campaign preflight / 独立 evaluator | 四个隔离个人任务、冻结提示词/范围/断言/参考解及离线 accounting/cancel/fork；十项新 proof；三 harness 无凭据 preflight；9 smoke/90 正式 configs | 最终构建与 commit 后重新绑定 revision/source/build digest；真实终端门禁通过后才可提出付费阶段 | 准备与模型表现分开；每阶段独立数值授权，计划预算不构成授权 |
| 最终交付 | manifest gates / bilingual README / docs / Test CI | typecheck→不存在 lint→test→build 串行；真实候选绑定、安装、链接与 whitespace；[skip publish] 保留独立 CI | 每次代码变更重做相关证据；完整定位不能在必需项 pending 时关闭 | 门禁、失败、跳过与未验收在 HANDOFF 分别记录 |

源码与回归定位复用 [PROJECT_MAP](architecture/PROJECT_MAP.md)、[RUNTIME](architecture/RUNTIME.md)、[TOOLS](architecture/TOOLS.md)、[STATE_AND_UI](architecture/STATE_AND_UI.md)、[CODEX_CAPABILITIES](architecture/CODEX_CAPABILITIES.md) 与 [MEMORY](architecture/MEMORY.md)。本轮新增证据入口见 [实测准备](benchmark/READINESS.md) 与 [开发指南](DEVELOPMENT.md#离线-windows-terminal-手工验收)。

## 后续顺序与授权

1. 完成真实 Windows Terminal 必需验收，失败项修复并复验，未执行保持 pending。
2. 将所有原生、公共安装及无凭据评测收据绑定最终候选；源码、锁文件或构建变化后重新准备。
3. 只有必需项均有通过证据才可写“可以开始有预算的 DeepSeek 实测”。用户分别授权个人任务与 smoke 后执行；发现请求、计量、隔离或清理异常立即停止并重做候选，再考虑正式比较。

用户已授权本轮完成后的版本更新、提交和推送，禁止创建或更新 Release。提交包含 `[skip publish]`，不得 `[skip ci]`；不创建或推送 tag。保留本轮开始前用户全部未跟踪目录。付费模型仍未授权；个人 400,000、smoke 900,000、正式 9,000,000 token 都只是审阅草案，并非账单硬上限。
