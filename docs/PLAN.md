# 当前开发计划

目标：把既定 Agent 定位实现完整、补齐功能与验收证据，使用户可以开始有预算的付费模型测试。产品定位仍是 DeepSeek 优先、Windows 优先的个人 Node/TypeScript 单包编码 CLI；能力清单以 [OVERVIEW](OVERVIEW.md) 和双语 README 为依据。不能把某轮局部修复或通过单测等同于完成此目标。

第六阶段已交付的 Composer 修复见 [归档计划](archive/PLAN_COMPOSER_LIFECYCLE.md) 与 [归档交接](archive/HANDOFF_COMPOSER_LIFECYCLE.md)。当前基线、执行记录和限制只在 [HANDOFF](HANDOFF.md) 维护。

## 完整定位验收清单

每一项都须核对当前实现、失败回归与生产路径；现有文档和历史测试只提供定位，不能替代本轮证据。发现缺陷就修复，缺失功能就按既定定位补齐，不以标成“不支持”代替实现。

| 要求 | 完成依据 | 当前状态与下一动作 |
| --- | --- | --- |
| DeepSeek/Responses 请求、原始模型 ID、用途配置与计量 | provider/attempt/stream/预算回归；生产 fake provider 实际请求与停止证据 | 正在实施：流关闭与逐次请求计量已接入生产结算；手动压缩计入 Goal、互斥并由 dispose 等待；辅助操作准入与累计 unknown 分开，同一 Memory job 不能在缺口后继续请求；其他请求项仍逐项复核，真实付费效果留到授权评测 |
| 理解项目、规则、搜索、文件编辑与变更审阅 | root-to-target 规则、地图、观察版本、审批并发修改、undo、搜索/附件/审阅生产回归 | 待逐项复核；Windows 语义导航网络隔离缺口需实证解决，不能静默放开 |
| 编码、修复与宿主验证闭环 | 当前 manifest 全 suite、首败停止、修复次数、过期检查、Goal/Memory 结算生产回归 | 待逐项复核；无检查、环境失败、取消不得成功 |
| 长任务、进程、权限与取消 | 原生 shell/后台命令/评测进程的真实退出、错误保留、迟到输出及准入回归 | 正在实施：buffered/duplex、shell/评测、搜索/地图和 Skill Git 已共享清理等待与故障结算；真实 Windows native fixture 覆盖 detached 后代，任意后代和其他原生平台仍待验收 |
| Session、恢复、分支、上下文、usage 与 Memory | 持久化故障、重启、fork、压缩/裁剪、unknown usage 与验证债务的生产闭环 | 正在实施：Memory 持久请求状态阻止中断/unknown job 在重启或租约到期后重发；手动请求取消、关闭等待、存储故障及提交前复核接入生产 TUI，可靠任务与未开始队列保留恢复；整项任务与单轮暂停分离，Plan/验证/Goal 续跑持续暂停，最终退出及重建重新计满空闲期，无学习材料也恢复旧队列；其余项目待逐项复核，不能借恢复或压缩重建授权 |
| Windows inline TUI、审批与输入所有权 | Ink 回归 + 实际 Windows Terminal 的取消、审批、命令 Esc、resize/scrollback/单 prompt 验收 | Composer 已有证据，剩余输入所有权与真实终端仍待验收 |
| 公共 exec/SDK、Web、MCP 与 Skills | 当前公开接口、错误/取消/重连/安装确认与真实协议 fixture；文档与广告能力一致 | 待逐项复核，不把附带能力清单当作完整可用性证明 |
| 付费测试准备 | 当前 candidate identity 的无凭据 preflight、fixture proof、独立评分、可审阅 task/campaign 数值预算与计划 | 待按最终代码重新核对；不提前调用真实模型 |
| 交付门禁与可追溯记录 | 串行 typecheck → lint → test → build、缺项记录、双语文档和本地链接、真实平台限制 | 每轮执行，最终逐项复查以上所有要求才能关闭总目标 |

架构重构、额外平台或协议扩展是否必要，按定位与真实缺陷判定。保持单 Agent 与共享 production runner；不另建平行的任务/验证/存储实现。任何未完成或证据不足的行都使总目标保持 active。

## 当前实施：请求所有权与预算边界

1. 流关闭、恢复控制器与逐次计量已完成当前切片；在生产路径继续核对手动操作、取消、退出及累计用量，不只检查主 coding 请求。
2. 手动压缩绑定 Goal，拒绝已受限准入；与 turn、task reset、设置变更互斥，Agent 关闭取消并等待 turn/压缩。
3. 独立辅助操作使用独立准入账本，实例累计显示始终保留 unknown；同一 Memory job 在用量缺口后禁止合并及自动重试，持久请求状态让该限制跨进程恢复。Memory 和辅助服务共享实际请求的 scope，准入前拒绝为零样本，取消保留可靠 usage，旧资源故障不重复累计；后台认领后再次检查实时策略。手动 provider、存储与取消由 runtime/TUI 服务持有，Esc 忽略迟到结果，关闭保留故障；继续逐项复核剩余请求与恢复路径。
4. Memory 空闲范围接入现有 runner 的任务开始/结束，轮次结束不能提前解除 Plan、验证、修复或 Goal 续跑的暂停；任务退出和 runtime 重建重新计满五分钟，失败/停止或无新材料的任务仍恢复可靠旧队列。继续核对其余 Session 与公共接口边界。
5. 以生产 Agent/Session/Goal、实际 SDK fake-fetch、Memory jobs 和 Ink 回归验证，更新双语说明及稳定契约，执行最终门禁并核对授权交付。
6. 继续清单中的剩余项目，不把当前切片标成产品全部完成。

原生 buffered/duplex launcher、宿主 Bash、评测、搜索／地图及 Skill Git wrappers 已接入共享清理等待；suite/campaign 已保留清理失败并停止后续任务。后台任务、前台工具及宿主验证的故障到 runner、Goal/Memory 与未验证债务已接通；导航和 Skill 管理器另关闭自身故障后的准入。真实 Windows native fixture 覆盖主动 detached 后代；任意后代、其他原生平台及直接用户 PTY 的实际资源证据仍需继续验收，不能将受控 fixture 扩大为普遍保证。实际验证证据见交接。

## 授权边界

用户当前明确授权本地 Memory 修复的提交、推送和展示版本更新，禁止更新 Release；实际执行状态见 HANDOFF。提交使用 [skip publish]，保留独立测试 CI，不创建或推送 tag，不创建或更新 Release。后续开发不自动重复交付交易。保持原有未跟踪内容；本次交付不代表完整产品验收已完成。付费模型测试另需明确授权及 task/campaign 数值预算。真实终端必须取得实际操作证据，自动测试不能代替。
