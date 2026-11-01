# 当前交接

2026-11-01：用户在六 PR 合并完成后明确要求创建 Release，授权取代上一轮不创建 Release 的限制。沿用当前 `0.6.0-rc.4`，准备创建 `v0.6.0-rc.4` 源码预发布，不修改展示版本。交付范围为准确 main 提交的带标签源码与脱敏验证证据；不提供原生安装包，不发布 npm，不进行付费模型评测。

六 PR 的合并交付已核实：#21–#26 全部为 MERGED，main 为 `d5230726ef58929071bf1bf49322078cfad0f289`，git tree 为 `4d4098d51b8a4f10173c01edf3a59fd27a53ec2e`，与最终本机验证候选完全一致。[main 检查](https://github.com/VinceTree/Everpeace/actions/runs/41276010711) 的 Windows、Linux、安全扫描和 Required checks 均成功。原始来源提交都已进入 main，工作树干净，临时保持运行进程已退出。收据 `.cache/pr-integration-2026-11-01/github-delivery.json`。

本轮复用 checkout，新分支 `codex/source-candidate-evidence-2026-11-01` 仅补交接和源码交付范围说明。文档合并后重新绑定最终 main、当前成功检查和该提交的安全扫描 artifact，再创建 tag/Release 并核对实际远端结果；证据目录 `.cache/release-2026-11-01/`，公开说明与附件以 [源码候选入口](https://github.com/VinceTree/Everpeace/releases/tag/v0.6.0-rc.4) 为准。该链接在创建前不代表已发布成功。

当前 API 实测专用 Runner 为零，仓库 Actions secrets 为空，`RUNNER_READ_TOKEN` 未配置。本机 required 原生回归只作开发证据，不能替代专用 Runner 与单一原生安装包的消费者验收；正式安装包 workflow、权限和完整门禁保持。源码预发布沿用根 AGENTS 的明确例外及此前 `v0.6.0-rc.1` 的交付范围。

上一轮用户要求修改六 PR 时尚未授权 Release。开始时 `codex/harness-goal-reliability` 工作树干净，#26 经当前检查后转 ready 并普通合并；此前 Goal 优化记录移入 [交接归档](archive/HANDOFF-2026-11-01-goal-reliability.md)。集成分支 `codex/pr-integration-2026-11-01` 基于 main `0b3b26fe55d49dc4181f7de62c4950a69a082642`，验证证据目录 `.cache/pr-integration-2026-11-01/`。以下记录保留该次实现和验证事实。

## 六 PR 范围与集成方式

| PR | 目标 |
| --- | --- |
| #21 | 原生 sandbox 依赖 @openai/codex 升至 0.165.0，复核 MXC/managed config 与真实原生边界 |
| #22 | undici 升至 8.12.3，官方 engines 为 Node >=22.19.0，与本项目最低基线一致；验证公共传输、MCP 与模型代理／流清理 |
| #23 | keyring 升至 2.1.2，保留 AuthStorage 和系统凭据库边界 |
| #24 | marked 升至 18.1.2，复验既有 Markdown／TUI 回归 |
| #25 | oxlint 升至 1.90.0，保持 correctness 策略 |
| #26 | Goal 优化已合并，使用上轮同一源码及当前远端成功检查 |

五项依赖 PR 原始只改 manifest 与根锁，均遗漏 expanded／real-fixtures 冻结锁，#21 还遗漏 Linux CI 的明确后端身份。先形成一个可验证组合，不接受各自不完整的旧锁。用 pnpm 精确更新上述五项，审阅解析差异仅涉及对应包、平台绑定及 OpenAI 的 undici peer 绑定；qs 6.17.1 等已有补丁保持。根锁同步至两份 evaluator lock，不迁移旧候选的评测结果。

已核对 Codex 上游固定 tag 的 debug_sandbox 与 Windows sandbox 配置入口，保持显式 MXC、managed config 和原生启动失败关闭；同步 Linux CI 固定身份、native receipt 后端标识与当前专题／使用文档。workflow 校验新增 manifest 与已审阅 Linux 身份一致性检查，并补不一致时拒绝的回归，不移除人工明确固定身份。

集成候选通过本机定向回归、完整四门禁及当前 GitHub Required checks 后，以普通 merge 合入 main。五个依赖原始 head 通过保留当前内容的 merge 记录进入候选，逐项证明目标更新和原始 ancestry；由 GitHub 结算间接合并，不使用 squash/rebase 丢弃提交，也不绕过保护或单独接受旧失败候选。

## 验证状态

冻结安装与 strict peer 检查通过，五项实际依赖已更新，根锁和两份 evaluator lock 字节一致。官方审计 high/critical/moderate 为零，仅保留一项既有 low，192 个组件通过既有许可证策略。锁差异、安装、审计与许可证收据分别为 `lock-review.json`、`install.log`、`audit.json`、`licenses.json`。系统 AuthStorage 仅针对本任务新建的合成条目完成 set/get/delete/absent 实测并清理，不读取用户已有凭据，证据 `keyring-smoke.log`。

初次定向回归发现 Undici 8 dispatcher 与 Node 内置 fetch 不兼容，三个代理测试失败。修复为同包 fetch/dispatcher，显式保留 HTTP CONNECT，并新增真实代理 Responses 流及物理 socket 关闭验证；初次日志保留 `targeted-initial-failure.log`。明确隔离全局 fake fetch fixture 的宿主代理设置，真实代理测试及 live 分支不隔离。

首次 required 原生清单中团队完整验证失败，保留 `native-initial-failure.log` 与失败 receipt。单独复现确认 MXC 重定向 LOCALAPPDATA，使 pnpm 找不到宿主已缓存的项目版本，转而尝试在容器内安装并以 EPERM 失败。模型启动前固定未设置的宿主 PNPM_HOME，保留用户显式配置、包管理器声明、原生隔离和所有验证断言。真实双 worker、子任务检查与根故意失败闭环已通过，日志 `team-toolchain-fixed.log`。

与 CI 同版 Node 22.23.4 的网络／provider／Markdown／expanded／workflow 定向回归 71/71 通过，零跳过，日志 `targeted.log`；真实代理专项 5/5，通过流关闭和取消路径。完整 required 原生复验 84 项全部通过、零失败／跳过，23 条必需原生用例全部满足；证据 `native-final.log` 与 `native-final/receipt.json`，标明本机脏候选，不冒充专用 Runner 或安装包验收。

首次完整四门禁在 test 停止，1394 项中两项 checkout preflight 未观察到合成请求边界。preflight 仍继承宿主代理，使同包 fetch 绕过它的全局 fake fetch。仅在 fresh worker 的 preflight 模式设置代理旁路，run/live 模式保留代理；原有 TCP／远端及无关 pipe 拒绝保持。两项回归明确传入代理配置并保留请求数、成员和用量断言；失败收据 `test-initial-failure.log`、`gates-initial-failure.json`，定向复验 5/5 通过，见 `preflight-fixed-cli.log`。原生执行路径不因该 benchmark-only 修复变化。

最终重新发现 manifest，在 Node 22.19.0、pnpm 10.30.3 下串行执行 typecheck → lint → test → build，四项全通过。1394 项测试中 1391 pass、3 个既有平台 skip、零 fail/cancelled；四项分别约 1.879、1.281、352.194、2.020 秒，test 含 pretest，Node suite 约 344 秒。证据 `{typecheck,lint,test,build}.log`、`gates.json`。915 份核心输入验证前后摘要一致，SHA-256 `2bcd539e06a2934d0832b95ded2da7b6772fa1f6c9f084f073b343b4477e3023`，收据 `identity.json`；根锁与两份 evaluator lock 字节一致。

补充通过安装补丁身份、CLI/SDK/PTY 烟测 7/7（零跳过）、安全文件 read/create/update/delete/冲突烟测、根与 detached 后代清理烟测、workflow 身份、953 项双语文案与插值、168 份公开文档路径／链接。对应 `{install-verify,install-smoke,files-smoke,process-smoke,ci-verify,ui-verify,docs-verify}.log`。门禁后仅补文档收据与保留提交来源的历史，不再修改已验证实现、依赖或测试。

## 交付与边界

main 的 Required checks、strict up-to-date 和管理员保护保持。提交包含 `[skip publish]`，保留 CI；正式原生安装包的 Release workflow 只接受显式 workflow_dispatch。认证通过既有 Git credential helper，仅向 gh 子进程提供，不落盘凭据。上一轮临时保持运行 helper 已通过删除 `keep-awake.active` marker 退出，未改永久电源设置。

真实 Windows Terminal、专用 Windows Runner、消费者安装包和付费模型质量不属于这些本机或 hosted 检查的证据。新增机器人 PR 不自动进入本次已明确的六项范围。
