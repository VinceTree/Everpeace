# 当前交接

更新日期：2026-10-09。先读 [AGENTS](../AGENTS.md)，再按 [索引](README.md) 定位。此前工程准备、原生导航、协议和评测装配的完整证据见 [上一轮交接](archive/HANDOFF_READINESS_BEFORE_TERMINAL.md)。本轮完成真实 Windows Terminal 验收，并修复实际操作发现的两项问题。

## 当前结论与授权

Windows Terminal 必需场景、本地工程门禁、公共安装和三组无凭据预检均已通过，修复提交的 Windows/Linux CI 通过。**可以开始有预算的 DeepSeek 实测**，但须先取得对应阶段的数值预算授权。工程准备不证明真实模型的编码成功率、稳定性或成本。

- 本轮起点为 `9d466276fdc5b04158e36a7ae70e8b50125a5364`，个人任务冻结基线仍为 `197c3c48d5f789a7215a1ac6af5ce40cb10ba1ef`。展示版本 **0.3.24**，package.json 与双语 README 一致。
- 用户已授权更新版本、提交、推送，禁止更新 Release；提交带 `[skip publish]`，不关闭 Test CI，不打 tag、不 publish npm 包。
- 无付费模型请求。个人 400,000、smoke 900,000、正式 9,000,000 token 仍只是分别授权的草案，不是账单硬上限。
- 保留原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`，不纳入提交。

## 真实终端与修复

终端为 Windows Terminal **1.24.12741.0**，可执行文件 FileVersion **1.24.2610.01001**。用户将专属窗口置前后，由限定标题/PID/ownership/focus 的 helper 注入实际 GUI 按键、滚轮和 Ctrl+滚轮，使用 PrintWindow 截取该 HWND；这是实际窗口自动操作，不冒充用户亲手按键或 ConPTY 仿真。fake provider 只使用隔离配置，无个人凭据。

外置证据根 `C:\Users\39850\AppData\Local\Temp\everpeace-terminal-acceptance-1758ded3a5b548e999de9a7f7452a249`：`terminal-evidence/actions.jsonl` 和截图、`fixture/sessions/`、`acceptance-result.json`、`final-cleanup.json`。主子会话为 `0f84ab27-2a18-4b3d-b459-c2be41b5154e`。

| 场景 | 结果与关键证据 |
| --- | --- |
| Plan 修订、Esc/Ctrl+C、批准后空闲、显式执行 | 修订草稿 resize 保留（70/71）；批准和查看（73/75）；显式长任务、取消后旧批准拒绝（121–127） |
| 修改→test pass→build fail→repair→全检查 | /plan cycle 后批准、/plan execute；133 截图与 JSONL 记录 build 指定断言 exit 1，随后 typecheck/test/build 全通过、repair_attempts=1、债务清除 |
| 重复 Enter、运行中 guidance、Ctrl+C | 122–125；guidance 仍等待，Ctrl+C 取消实际活动请求；不是空闲退出 |
| 权限在审批期间收紧 | 168–176；切为 read-only 后旧 MCP 批准失效，MCP 与后续 navigation 均 cancelled |
| 中文/emoji、resize、scrollback、滚轮/缩放、单 prompt | 143–154；300 行保留，Ctrl+End 回到末尾；151/152 实际放大字体、153 恢复 |
| 直接 ! 输入独占、退出 | 155–160；子进程 10580 接收专属输入并退出，恢复单 prompt；对应文本仅在 timeline，不进入 context_append |
| 隔离扩展 | 134–141；Skill 内容、MCP pong、native hover 成功，Memory 窗口显示种子条目；不把 Memory UI 当作真实学习质量证据 |
| 同 root 重启、fork、债务与 unknown | 26/32、89、182–186；子会话及历史恢复，旧 Plan 批准不恢复，最终 status 仍 partial；成功验证没有覆盖未知用量 |

发现并修复：

1. 命令窗口 resize 后空白，下一按键才重绘。App 只在聊天视图执行 Static 历史清屏重放；命令窗口由 Ink 原位调整，保留草稿。旧代码回归失败，修复后实际修订和 status resize 均正常。
2. 恢复较长 Markdown 历史触发 MaxListenersExceededWarning。每个 stdout 共享一个列宽订阅，最后卸载时清理；不提高上限或屏蔽警告。新回归在旧代码复现 60 个订阅，修复为 1 个，resize 更新所有块，卸载归零；实际重启长历史无新警告。

helper 修正焦点恢复、NULL 标题查找、DPI/owned HWND 截图、真实 Ctrl+滚轮，并支持失败停止的连续控制。fixture 增加 wait-long、显式 Plan 场景。早期 79/98/111 是空闲退出，149 未产生字体缩放，不能算取消/缩放通过；最终 187 因焦点丢失拒绝发送，不记为成功 Ctrl+C。关闭专属 HWND 后记录后代退出，不关闭其他 Terminal 窗口。早期 05 截图方式不合格，已删除，不作为证据。

## 工程与候选门禁

最终重新发现 manifest 并串行执行：**typecheck pass → lint script 缺项 → test 1066 项、1063 pass、0 fail、0 cancelled、3 平台 skip（68,191.5033 ms）→ build pass**。完整日志保存于终端证据根 `.terminal-acceptance-final-*.log`；sandbox 内一次 App 附件测试超时单独保留，原生同回归通过，不把基础设施失败改写为通过。

公共安装已通过：隔离 consumer 安装本地打包产物，CLI/exec help、SDK import/runTask 的无模型配置结果与退出码契约通过，405 个安装构建文件与本地 dist 字节一致。收据位于终端证据根 `public-install-result.json`。提交后的准确 SHA、同 SHA Test CI、Release 未变化核对记录在 `final-delivery.json`；完成前不借用上一轮通过结论。

修复提交 `33a09e9129ee583a771efb5cff3e5cbee25d34fa` 已推送，[Windows/Linux Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37903249607) 均成功，[Publish version](https://github.com/VinceTree/Everpeace/actions/runs/37903249554) 实际 skipped。27 个 Release 的 ID/tag/更新时间/资产等与保护基线一致，没有创建 tag 或 Release。后续仅交接记录提交仍以最终收据绑定准确 HEAD 和 CI，不把这里的修复提交 SHA 冒充后续 HEAD。

## 两套付费测试准备

沿用独立根 `C:\Users\39850\AppData\Local\Temp\everpeace-readiness-2eb92be531ab475d80b9ac4f141fa66a`。`personal.json` 与外置参考验收器冻结四项任务；`personal-offline-preflight.json` 验证装配、计量、取消与恢复债务；`fixture-proof.json` 的十项 pristine→指定断言失败→reference 证明保持有效，任务与补丁未改。

`smoke.json` / `comparison.json` 分别准备 9/90 次，基线、当前候选、固定 dsh 三组；统一 deepseek-flash/high/32768、十五分钟、最多三轮修复。提交后重新 configs 和无凭据 preflight，绑定 revision/sourceDigest/buildDigest；本轮之前收据另行保留。源码/锁文件/构建/HEAD 再变化必须重做候选预检。

本轮首次最终预检中 dsh 达到 60 秒超时，基线和候选通过；失败原样保存为终端证据根 `preflight-first-failure.json` / `preflight.log`。未更改代码、超时或权限条件的独立复验三组全部通过，零网络调用、完整 usage、清理已等待；`preflight-result.json` / `preflight-retry-timing.json` 保留复验。超时原因未确定，不把首次失败改写为通过；后续实测遇到类似异常仍立即停止并诊断。

原生 TypeScript 四查询、写入/状态/网络拒绝、取消/权限变化后 PID 退出沿用上一轮有效证据，对应生产实现本轮未改。复现与授权边界见 [READINESS](benchmark/READINESS.md)、[DEVELOPMENT](DEVELOPMENT.md#离线-windows-terminal-手工验收)。后续先分别取得个人与 smoke 的数值预算授权；发现请求、计量、隔离或清理异常立即停止，修复并重新准备候选，再考虑正式比较。
