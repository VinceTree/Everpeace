# 当前开发计划

目标：把既定 Agent 定位实现完整、补齐功能与验收证据，使用户可以开始有预算的付费模型测试。产品定位仍是 DeepSeek 优先、Windows 优先的个人 Node/TypeScript 单包编码 CLI；能力清单以 [OVERVIEW](OVERVIEW.md) 和双语 README 为依据。不能把某轮局部修复或通过单测等同于完成此目标。

第六阶段已交付的 Composer 修复见 [归档计划](archive/PLAN_COMPOSER_LIFECYCLE.md) 与 [归档交接](archive/HANDOFF_COMPOSER_LIFECYCLE.md)。当前基线、执行记录和限制只在 [HANDOFF](HANDOFF.md) 维护。

## 完整定位验收清单

每一项都须核对当前实现、失败回归与生产路径；现有文档和历史测试只提供定位，不能替代本轮证据。发现缺陷就修复，缺失功能就按既定定位补齐，不以标成“不支持”代替实现。

| 要求 | 完成依据 | 当前状态与下一动作 |
| --- | --- | --- |
| DeepSeek/Responses 请求、原始模型 ID、用途配置与计量 | provider/attempt/stream/预算回归；生产 fake provider 实际请求与停止证据 | 待逐项复核，真实付费效果留到授权评测 |
| 理解项目、规则、搜索、文件编辑与变更审阅 | root-to-target 规则、地图、观察版本、审批并发修改、undo、搜索/附件/审阅生产回归 | 待逐项复核；Windows 语义导航网络隔离缺口需实证解决，不能静默放开 |
| 编码、修复与宿主验证闭环 | 当前 manifest 全 suite、首败停止、修复次数、过期检查、Goal/Memory 结算生产回归 | 待逐项复核；无检查、环境失败、取消不得成功 |
| 长任务、进程、权限与取消 | 原生 shell/后台命令/评测进程的真实退出、错误保留、迟到输出及准入回归 | 正在实施：buffered launcher 不再用固定延时冒充清理完成；共享 shell/评测清理等待与任务级错误结算已实现，继续审计 legacy wrappers、原生 backend 后代归属 |
| Session、恢复、分支、上下文、usage 与 Memory | 持久化故障、重启、fork、压缩/裁剪、unknown usage 与验证债务的生产闭环 | 待逐项复核；不能借恢复或压缩重建授权 |
| Windows inline TUI、审批与输入所有权 | Ink 回归 + 实际 Windows Terminal 的取消、审批、命令 Esc、resize/scrollback/单 prompt 验收 | Composer 已有证据，剩余输入所有权与真实终端仍待验收 |
| 公共 exec/SDK、Web、MCP 与 Skills | 当前公开接口、错误/取消/重连/安装确认与真实协议 fixture；文档与广告能力一致 | 待逐项复核，不把附带能力清单当作完整可用性证明 |
| 付费测试准备 | 当前 candidate identity 的无凭据 preflight、fixture proof、独立评分、可审阅 task/campaign 数值预算与计划 | 待按最终代码重新核对；不提前调用真实模型 |
| 交付门禁与可追溯记录 | 串行 typecheck → lint → test → build、缺项记录、双语文档和本地链接、真实平台限制 | 每轮执行，最终逐项复查以上所有要求才能关闭总目标 |

架构重构、额外平台或协议扩展是否必要，按定位与真实缺陷判定。保持单 Agent 与共享 production runner；不另建平行的任务/验证/存储实现。任何未完成或证据不足的行都使总目标保持 active。

## 当前实施：原生命令取消生命周期

1. 取得定时器提前结算、重复清理、迟到输出和 observer 异常的语义失败证据。
2. 在现有 native launcher 内以一次 cleanup promise 绑定取消/超时，等待 child close 与进程树终止请求；保留清理失败。
3. 用受控事件以及 Windows/Linux 真实 Node 父子进程验证，另记录原生 sandbox、脱离进程组后代和真实终端的证据边界。
4. 验证上层 Bash/后台任务/runner 回归，更新双语行为说明与稳定契约，执行最终门禁。
5. 继续清单中的剩余项目，不把当前切片标成产品全部完成。

原生 launcher、宿主 Bash 和评测 wrappers 已接入共享清理等待；suite/campaign 已保留清理失败并停止后续任务。实际验证证据见交接；后台任务、前台工具及宿主验证的故障到 runner、Goal/Memory 与未验证债务已接通；真正原生 backend 的后代所有权、legacy wrappers 与平台实际资源证据仍需继续验收。

## 授权边界

用户已再次明确授权提交、推送和更新展示版本，本次只交付当前已实现的改动；提交使用 [skip publish]，保留独立测试 CI，不创建或推送 tag，不创建或更新 Release。保持原有未跟踪内容；本次交付不代表完整产品验收已完成。付费模型测试另需明确授权及 task/campaign 数值预算。真实终端必须取得实际操作证据，自动测试不能代替。
