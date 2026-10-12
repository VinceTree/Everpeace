# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../../AGENTS.md)，再按 [文档索引](../README.md) 定位。上一轮任务清理故障结算与交付见 [归档](HANDOFF_CLEANUP_SETTLEMENT.md)。

## 当前目标、授权与工作区

总目标仍是完整实现 DeepSeek 优先、Windows 优先的个人 Node/TypeScript 编码 CLI，补齐功能后开始有预算的付费测试。目标保持 active；[PLAN](../PLAN.md) 保存完整验收矩阵，本次生命周期修复和交付属于 progress，不能宣布全部功能已经完成。

本轮基线为 main/origin/main 的 202d043d1db982358a5e43f833300862a7e2307f。该纯交接提交的 [Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37814495755) 已 completed/success，Windows/Linux jobs 均 success；这是基线证据，不替代当前改动验证。

用户再次明确要求提交、推送、更新版本，但不更新 Release。本轮将 package.json 和双语 README 从 0.3.18 同步到 0.3.19，使用 [skip publish]，仅推送 main，不创建或推送 tag。推送前记录的 27 个 GitHub Release 的 ID、tag 和更新时间在推送后均未变。实现提交和授权交付已完成，结果见下节；后续开发不自动重复交付交易，不请求付费模型。

## 当前实现与失败证据

审计发现 duplex launcher 使用五秒 watchdog、重复树终止和提前 child error 结算；搜索、项目地图与 Skill Git 仍使用未等待的 best-effort 清理。导航查询和隔离探针的清理失败可变成普通工具错误，旧 runtime 仍能启动后续进程。

修复前新增 duplex 四项语义回归全部失败，日志 everpeace-duplex-baseline-20261009.log；搜索／地图／Git 和管理器关闭七项语义回归全部失败，日志 everpeace-read-process-baseline-final-20261009.log。此前一份 fixture 参数错误日志不作为缺陷证据。现在实现：

- [共享 ownership](../../src/tools/process-completion.ts) 暴露 stopping/stop；[duplex](../../src/codex/cli.ts) 的取消、超时、传输错误和重复 terminate 共用一次 cleanup，并同时等待真实 close。清理失败以 ProcessCleanupError 保留，普通传输错误与成功清理分开；预取消不启动。
- [搜索](../../src/tools/files.ts) 与 [地图](../../src/tools/project-map.ts) 等待 close/cleanup，清理失败优先于取消。达到保留上限后停止收集并 drain，原期限继续生效；已经耗尽期限的地图不启动枚举。这样避免短命自然退出生产者的多余 taskkill，同时保留真正终止失败。
- [导航](../../src/tools/code-navigation.ts) 先通过 EOF 给 server 自然退出机会，再请求强制终止；宽限只是触发清理，不是成功证据。查询或 probe 清理失败永久关闭当前 runtime，已排队及未来查询不能启动 server，隔离证据仍保留 inconclusive/probe_cleanup_failed。
- [Agent](../../src/agent/react-agent.ts) 不再吞掉文件／导航 ProcessCleanupError；当前工具 cleanup_failed、后续工具 skipped/process_cleanup_failed 按顺序落盘，任务结算保持既有 Goal/Memory 拒绝和未验证债务。
- [Skill 管理器](../../src/skills/manager.ts) 拥有活动准备与 Git；Unix Git 创建独立进程组。close 永久关闭准入、取消下载和 Git、等待准备及所有进程后才删除安全预览；重复 close 共享 promise。清理失败 stage 保留，故障管理器拒绝后续安装。[TUI dispose](../../src/tui/app/dependencies.ts) 同时等待 Skill、MCP 与 Memory 服务，任何失败不阻止其余服务清理和终端恢复。

相关源码契约同步 [TOOLS](../architecture/TOOLS.md)、[RUNTIME](../architecture/RUNTIME.md)、[CODEX_CAPABILITIES](../architecture/CODEX_CAPABILITIES.md)、[SANDBOX](../architecture/SANDBOX.md) 与 [DECISIONS](../architecture/DECISIONS.md)，双语 README 同步用户可见清理语义。

## 实际原生证据与限制

[Windows native ownership fixture](../../tests/unit/tools/sandbox-boundaries.test.ts) 实际通过 pinned backend 分别启动 buffered/duplex payload，并让其创建主动 detached 子进程；取消后两个报告的 PID 都已退出。断言排除 fixture 自然自退出。这只证明受控 Windows fixture，不证明任意后代或 Linux/macOS 原生 backend。GitHub hosted Windows 和非 Windows 对这项 native integration 明确跳过。

Windows LSP 的网络 probe 仍允许直接连接，导航继续失败关闭。只读宿主检查已确认 BFE/MpsSvc 运行、三个 firewall profile 启用，以及 offline outbound block rules 启用；native payload 实际身份为 codexsandboxoffline，SID 与规则一致。因此不能把缺口简单归因于未启用防火墙或账号不匹配；真正网络限制原因和修复仍需独立证明，未修改系统 firewall/account，也没有宿主执行回退。

## 本轮验证

共享进程与导航／搜索／Git 定向检查 78/78 通过，日志 everpeace-process-ownership-focused-final-20261009.log；新增 Agent 配对、下载取消与原生退出断言后，相关检查 29/29 通过，日志 everpeace-process-ownership-closure-focused-20261009.log。

定向检查曾暴露三个自然退出竞态：已结束短命搜索、截断地图、正常 EOF 的 LSP 会触发 Windows taskkill 失败。修正的是生产输出排空、过期准入和 EOF 顺序，没有放宽清理失败断言。

更新展示版本及 TUI 退出装配后，最终宿主串行门禁为 typecheck 通过 → lint script 缺项 → test 906 项、903 通过、0 失败、3 项平台跳过（51,358.033 ms）→ build 通过。宿主临时目录日志使用 everpeace-delivery-0319-{typecheck,test,build}-20261009.log。git diff --check、25 份交付文件空白检查及 226 个本地文档链接路径检查通过；package.json 与双语 README 展示一致。当前实现已取得独立远端 Windows/Linux CI 证据，不使用基线 CI 替代。

## 授权交付结果

实现提交 a8339f8287f00b6bbb7fad24968185cd5053dc38 已推送 main，标题为 fix: await cleanup for navigation and read helpers [skip publish]。[Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37819342770) 已 completed/success；Windows/Linux jobs 均 success，包含实际 typecheck、test、build 和差异检查。这是当前实现证据。

[Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37819342938) 已 completed/skipped，Publish version job 实际 skipped。27 个 Release 的 ID、tag、更新时间与推送前基线完全一致，远端不存在 v0.3.19 tag，也没有补建 v0.3.18 tag。完整产品目标仍保持 active，本轮提交／推送／展示版本更新交易已完成。

推送后补充的本交接和 PLAN 记录目前仅保留本地，未暂存／提交。自动审批拒绝了追加纯文档提交与默认分支推送，理由是原授权已用于前一笔交付、未明确涵盖这笔额外远端写入；已向用户请求追加授权。拒绝发生在进程创建前，没有执行追加 Git mutation，不绕过该拒绝；若获明确批准，使用 [skip publish] 提交这两份文档并仅推 main。

## 下一步与完整目标未完成项

- 任意脱离进程组的后代、其他平台真正 native backend、直接用户 PTY 的实际资源退出验收；只剩用户 PTY 仍使用 legacy process-cancel，保持其独立输入语义。
- Windows LSP 网络隔离缺口仍待解决；禁止通过解除限制或宿主回退让它表面可用。
- 按 PLAN 逐项复核 provider/预算、项目规则与编辑、Session/Memory、公开 exec/SDK、Web/MCP/Skills 的当前生产证据。
- 真实 Windows Terminal 的审批、Ctrl+C、Plan 修订、resize/scrollback、命令 Esc、恢复与单 prompt 仍 pending。
- 最终 candidate identity 的 preflight/fixture proof 和可审阅付费 campaign 仍需准备。付费运行另需明确授权及 task/campaign 数值预算。

## 用户原有内容

未跟踪 .everpeace-benchmark/、.patch-node-pty/、NUL、benchmark/、question/、test-me/、{} 全部保留，未修改。新增 read-process-lifecycle 测试与本轮归档属于本次交付，不混入用户目录。
