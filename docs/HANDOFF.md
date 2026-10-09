# 当前交接

更新日期：2026-10-09。先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 定位。本轮实现 [PLAN](PLAN.md) 的 Windows/DeepSeek 工程缺口和实测准备，并使用用户指定的 [readme-generator Skill](https://github.com/geekjourneyx/readme-generator/blob/main/SKILL.md) 重排双语 README。此前 Memory 交付全文已移入 [归档](archive/HANDOFF_MEMORY_SERIALIZED_READ_DELIVERY.md)。

**完整定位仍 active，尚不能宣布开始付费实测。** 原生导航、受控进程生命周期、离线协议和评测装配已有通过证据；真实 Windows Terminal 的必需操作证据仍 pending。工程回归不证明真实模型的成功率、稳定性或成本。

## 范围、候选与授权

- 开始时 main 与 origin/main 同步，冻结基线为 `197c3c48d5f789a7215a1ac6af5ce40cb10ba1ef`。展示版本从 0.3.22 更新为 **0.3.23**，package.json 和双语 README 一致。
- 用户授权本轮更新版本、提交和推送，禁止更新 Release。提交使用 `[skip publish]`，保留独立 Test CI，不创建或推送 tag，不 publish npm 包。完整定位因终端证据缺失保持 active。
- 无付费模型授权，本轮无真实 provider 请求。个人 400,000、smoke 900,000、正式 9,000,000 token 都是草案，三个阶段分别授权，也不是严格账单上限。
- 原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，不纳入交付。

## 实现及证据范围

Windows 后端固定为 `@openai/codex@0.162.0`，共享 launcher 在 payload 分隔符前最后插入 `windows.sandbox=mxc`。旧后端 direct-socket denial 失败已复现。新 backend 的实际原生测试证明工作区写入、应用状态读取、网络连接被拒绝，host listener 零连接。LSP 探针失败继续阻止启动，没有宿主回退。

Node promises.realpath 在 MXC 内返回 EPERM，而 Node 的 JS symlink-resolving realpath 在同一权限下可用。仅 sandbox 内 LSP 子进程加载 EPERM fallback adapter；临时 launcher 根只读且与 workspace/受保护状态分离，退出及 terminate 等待清理，清理失败阻止准入。实际 TypeScript language-server 5.0.0 / TypeScript 5.9.3 的 definition、references、implementation、hover 全部通过；取消及权限 revision 改变后，受控实际 Node PID 全部退出。其他平台原生隔离不扩大承诺。

原生 TUI 首次 cycle 因 PowerShell 选择 pnpm.ps1 而失败；宿主发现检查改用 Windows 原生 pnpm/npm/yarn.cmd shim，不放宽执行策略或 sandbox。修正后的 ConPTY 流程实际取得 test pass → build fail → repair → 全检查通过证据。审批与 guidance 改为一个 composer 输入所有者：空草稿 y/n/Enter 仅审批，有草稿时 y/n 为正文、Enter 仅提交 guidance，修复 y 同时进入草稿的问题。

MCP SDK 升级到 1.31.0，同步锁文件，保持 stdio/Streamable HTTP 接口。实际 transport 未配置 OAuth authProvider，依赖告警不等于当前调用已泄漏凭据；协议、取消、断连关闭和不重放回归通过，远端告警状态以最终收据为准。[官方公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)。

新增 DeepSeek 契约使用真实 OpenAI SDK + fake fetch，经生产 factory、Session、attempt ledger 覆盖请求形状、工具配对、完成、截断、失败、缺失 usage、无 terminal 的 EOF、流中断；保留原始模型 ID，无服务端 Session 依赖，reasoning 不重复计 output。六项通过，无真实模型请求。

隔离 TUI `--integrations` 加载 owned-root 的 Skill、真实 stdio MCP、Memory 和原生协议 LSP，不读取个人凭据、Skill 根或 MCP 配置；正常生产 Skill 发现不变。Skill 读取、MCP 审批/ping、native hover、Memory 窗口/Esc 已有 ConPTY 记录，不代替真实 Windows Terminal 操作。

README 按 Skill 的 clean-doc / 零图片样式重排，保留 Apache 2.0；首屏聚焦定位、安装、显式 Plan 执行、三个场景、CLI/SDK 与边界。详细原说明迁入 [英文使用指南](USAGE.md) 与 [中文使用指南](USAGE.zh-CN.md)。没有修改 GitHub Description/Topics。

## 实测准备与外置收据

独立 owned-root 为 `C:\Users\39850\AppData\Local\Temp\everpeace-readiness-2eb92be531ab475d80b9ac4f141fa66a`，含 ownership marker，不使用用户原有 benchmark 目录写入。

- `personal.json`：四项个人任务的固定基线副本、提示词、允许路径、独立验收及失败条件。两个修改任务的外置参考断言通过，seed→reference 补丁实际 apply --check 并应用，再恢复 seed；`personal-evaluators/` 在模型工作区外。
- `personal-offline-preflight.json`：四任务的实际 runner 装配、请求计量、发现 typecheck/test/build；真实长进程取消、等待清理、债务落盘，重启 store 后 Plan-only fork 保留债务。不把 fake 输出当任务成功，不声称此收据执行了恢复后的全检查。
- `fixture-proof.json`：Chalk、Commander、Day.js 十项均 pristine pass → 指定 ERR_ASSERTION seed fail → reference pass。seedFailureContains 拒绝无关失败、缺模块或启动错误。
- `smoke.json` / `comparison.json`：基线、最终候选、固定 dsh 的 9/90 次配置，统一 deepseek-flash、high、32768、十五分钟、最多三轮修复。dsh 只读复用干净兄弟 checkout 的固定 revision `639ed015397290b3745d163aafe02ffee4aa3f84` 与构建；profile/home/运行状态隔离。
- `smoke/artifacts/preflight-result.json`：最后一次 configs 后三组无凭据预检，绑定 revision/sourceDigest/buildDigest；源码、锁文件、构建或 HEAD 变化必须重新生成预检，旧开发结果不代替最终结果。
- `native-typescript-navigation.json`、`native-navigation-lifecycle.json`：原生四查询和取消/权限改变后的实际 PID 退出。`terminal-automated-fixed/`、`terminal-integrations-fixed/` 保留 Session JSONL、失败及修正后的证据。

重复准备命令和独立评分边界见 [READINESS](benchmark/READINESS.md)、[BENCHMARKING](BENCHMARKING.md)。取消、跳过和 unknown 保留在计划分母中。

## 最终工程门禁与交付

审批输入修正后重新发现 manifest 并串行执行：**typecheck 通过 → lint script 缺项 → test 1065 项、1062 通过、0 失败、0 cancelled、3 平台跳过（63,599.5767 ms）→ build 通过**。构建前确认工作区和 dist 无重定向且目标在仓库内。日志为 owned-root 的 `final-typecheck.log`、`final-test.log`、`final-build.log`。定向 App/Prompt 87/87 通过，不借用旧 CI。

本地 pnpm pack 在新 consumer 目录安装验证，不全局 link、不 publish。实际 CLI --help / exec --help 可用，安装后的 `everpeace/sdk` import 与 runTask 无模型配置的 classification/exitCode 契约通过；实际运行、取消、背压等由共享 runner 回归覆盖。最终源码修正后重新打包与检查。

提交后重新生成 configs 并 preflight。准确最终 HEAD、远端 main、同 SHA 的 Windows/Linux Test CI、Release workflow skipped job、**27 个 Release** 全保护基线及依赖告警只读核对写入 owned-root `final-delivery.json`；实际完成才写通过，路径存在不代表远端通过。基线含 ID/tag/updated_at/draft/prerelease 和资产 ID/更新时间；认证内容不输出或落盘。

## 仍未验收

用户要求由 Agent 运行实际终端验收，本轮已尝试专属 Windows Terminal **1.24.12741.0** 窗口和限定标题 Win32 helper；当前桌面环境无法取得目标窗口焦点，helper 拒绝发送按键，未截取用户桌面。专属窗口已关闭，ConPTY 已收束。此为环境限制，不是自动审批拒绝。

真实 Windows Terminal 的 Plan 修订/批准/显式执行、重复 Enter、guidance、审批中权限变化、Ctrl+C、Esc、中文/emoji、resize、scrollback、滚轮/缩放、单 prompt、直接 ! 输入独占及退出、相同 root 重启恢复仍 **pending**。步骤见 [DEVELOPMENT](DEVELOPMENT.md#离线-windows-terminal-手工验收)。必需证据取得且通过后，才可作“可以开始有预算的 DeepSeek 实测”结论；任何失败继续修正复验。
