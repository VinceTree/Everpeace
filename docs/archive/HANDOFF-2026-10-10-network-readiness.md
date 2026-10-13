# 当前交接

更新日期：2026-10-10。先完整读取 [AGENTS](../../AGENTS.md)，再按 [索引](../README.md) 定位。本轮专题为 [公共网络边界](../architecture/NETWORK.md)、[开发与安装](../DEVELOPMENT.md)、[当前候选团队验收准备](../benchmark/TEAM_READINESS.md)。前轮团队实现与发布记录原样保存在 [历史交接](HANDOFF-2026-10-10-teams.md)，其中旧授权与测试不能转记为本轮结果。

## 当前范围与工作区

本轮授权实施网络连接边界修复、lint/源码安装保障、benchmark 团队配置和离线验收准备。用户随后明确授权按**补丁更新**提交、推送、更新版本和 GitHub Release；源码展示更新为 **0.5.1**，起点为 `7c4a6b7cf57c4d0974ff4d143ac85d8c83dfd51a`。付费模型调用仍为零，没有读取实测凭据。当前提交、CI、tag 与 Release 的准确状态以补丁交付根的外置收据为准，不提前把未执行步骤记为成功。

实现开始时 tracked 工作区干净；原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，未当成临时产物清理，也不纳入本次提交。只提交本轮实现、测试、脚本与相关文档。此前测试提交只发生在宿主所有的临时 Git fixture；当前真实提交依据新的用户授权。

## 已完成

| 阶段 | 交付与边界 |
| --- | --- |
| P0 网络 | 内部公共地址解析、Undici 受控连接和响应租约；所有搜索源、网页读取、Skill HTTP 下载与 Git 克隆共用批准地址快照。直连重试不重新解析 origin，每次重定向重新校验；保留 HTTP Host、TLS SNI 与证书身份。HTTP/HTTPS 宿主代理 CONNECT 到获准 IP，认证仅到代理；Git 专属临时认证转发器及继承 config/env 隔离 |
| P1 门禁/安装 | 固定 Oxlint correctness、警告失败与实际 `pnpm lint`；局部必要例外说明原因，修复真实未使用 signal 等问题。Windows/Linux CI 按 typecheck → lint → test → build 首败停止。固定 node-pty 并核验实际补丁，增加干净源码安装、CLI/SDK 和原生 PTY 检查 |
| P2 验收准备 | optional team 贯穿 campaign/checkout/worker/production；团队 settled attempts 按来源幂等汇总，sticky unknown 与 reasoning 不重复扣除。固定隔离失败码停止阶段并保留 skipped 分母。当前代码/构建、任务评分器、准备 harness 和配置冻结；无凭据 preflight、同根模型离线对照和全目录评分器 proof |

`src/network/` 不改变模型 API/MCP 的信任边界。公共资源拒绝混合 DNS、特殊用途地址、格式/family 异常及无法验证目标；IPv6 采用保守全球单播范围。系统 DNS 不能强制取消，但任务期限结束后迟到答案不能连接。dispatcher 销毁与 socket 关闭按顺序执行，清理异常仍收回所有直属 socket，并返回固定诊断。

Git 子进程禁用 URL 重写/额外代理/credential helper/配置注入/交互认证/重定向，强制 TLS 校验，保留原 shallow/sparse/预览确认。取消先拒绝新 CONNECT，保持已有隧道直到观察到进程树终止，再关闭转发器；真实 Windows Git 回归证明该顺序避免 taskkill 与提前退出的竞态。代理 token 不进入 argv、Session 或日志。

## 当前验证证据

更新补丁版本后重新串行执行 **pnpm typecheck → pnpm lint → pnpm test → pnpm build**，全部通过。完整测试 **1135 项，1132 通过、3 跳过、0 失败，92562.1118 ms**。发布前日志位于 `<LOCAL_EVIDENCE>`，实际串行退出结果记录在该根 `local-gates.json`。`git diff --check` 另行通过。实现阶段原日志、摘要与 fixture 收据保留在 security final readiness 根，不覆盖原始证据。

三项跳过是文件 symlink 的平台限制、Windows 临时目录 alias 的既有 clean-checkout CI 专项，以及 Unix 子进程专项。没有跳过网络、代理、真实 Git 或原生团队隔离用例。

网络专项使用真实本地 HTTP/TLS、IPv6、HTTP/HTTPS CONNECT 代理和 Git http-backend，记录实际 socket；覆盖批准后 DNS 变化、地址重试、混合/异常答案、私网重定向、Host/SNI/证书身份、认证隔离、代理拒绝/超时、慢 DNS/响应、正文截断/错误/取消、Git 注入及取消资源收束。测试映射与公开 fixture CA 仅在 Node test mock 中生效，生产没有本地地址映射或关闭证书检查的选项。新增网络专项 14 项；既有网页/Skill/权限/sandbox 与团队回归同时执行。

`pnpm install:clean` 对更新补丁版本后的候选创建独占干净源码快照，未复制已有 node_modules 或用户目录；冻结 lockfile 安装、实际补丁检查、构建、CLI help/SDK 导入以及 6 项原生 PTY 生命周期检查全部通过。发布前日志为补丁交付根 `clean-source-install.log`，安装 fixture 完成后已按所有权清理；实现阶段原日志继续保留。

**Windows 原生：**当前完整回归和同模型离线对照实际执行固定原生后端，覆盖两个 worker 独立编码/整合、并发修改保护及成员通过而根验证失败；不是 mock 或 CI skip。

**Linux 原生：**补丁候选源码重新编译到宿主所有的 `everpeace-team-linux-20261010/dist`，WSL Ubuntu / Node v22.22.1 的两成员实际隔离探测通过：owned cwd、主目录/其他成员读写/Git metadata denial。发布前日志为补丁交付根 `linux-native.log`。保留 WSL mirrored 网络初始化失败并回退 None 的提示，探测不需要外网；此结果不代表完整 Linux CI、网络 suite 或 TUI 验收。既有 Windows Terminal 手工证据在历史交接，本轮没有新增终端交互功能，也没有冒充重新验收。

## 冻结候选与离线评测

最终准备根：`<LOCAL_EVIDENCE>`。

- `candidate.json`：当前 revision/source/build、准备 harness、任务/评分器与待授权配置摘要；修改输入后必须创建新候选，不能盲目继续旧配置。
- `preflight.json`：单 Agent 1 次请求、团队 5 次请求（含两个成员），输入/输出全部计入团队总账；相同根模型、high reasoning/32768 输出上限。全部合成 Responses，阻断 socket，networkCalls=0，不读取 Key。
- `fixture-proof.json` 与 `fixture-proof-provenance.json`：十个固定任务全部 seeded 错误被拒绝、reference 修复被接受。证明执行在先前 owned readiness 根，核对 evaluationDigest 完全相同后复用独立评分器证据；原根源码/构建已经过期，不把旧 preflight 或旧候选身份搬到新根。
- `offline-comparison.jsonl`：当前同根模型固定任务，单 Agent 与根加两 worker 都经真实根检查和独立断言评分；只证明合成请求的工程行为。`delivery-receipt.json`：核对最终摘要、检查日志、安装/原生/离线结果及无付费调用边界。
- `compatibility-plan.json`：两项短协议探测，待授权 10000/task、20000/stage；明确 high/1024 输出，与正式比较设置分开，不能作为 campaign 配置或授权执行。
- `smoke.json`：目录前三任务 single/team 各一次，共六次，草案 100000/task、600000/stage。
- `comparison.json`：全部十任务 single/team 各三次，共六十次，草案 100000/task、6000000/stage。

评分器 proof 原始日志和资料在 `everpeace-security-readiness-20261010`、`everpeace-security-fixture-proof.log`；保留历史结果，不覆盖失败尝试。当前 preflight、同模型对照原日志分别为 `everpeace-security-preflight-final.log`、`everpeace-security-comparison-final.log`。总 tokens、耗时、重复调用、冲突和人工介入由 fixture 输出保留，不据此宣称团队更快、更省或实际模型质量更好。

## 未完成范围与后续条件

本轮仅支持仓库内 pnpm 源码安装。`pnpm pack` 成功不证明消费者获得仓库补丁；脱离仓库的补丁交付和干净消费者安装包验收仍阻塞独立安装包/npm 分发，没有加入消费者 postinstall 修改依赖。

HTTP/HTTPS 代理来自宿主环境并作为受信任基础设施，必须忠实连接已批准 IP；不支持 SOCKS/PAC，失败不回退直连。缺少 lint、安装限制、历史沙箱修复与缺少当前付费验收分别记账，不能统称当前漏洞。

付费实测仍未授权。配置使用 REQUIRES_MODEL_AUTHORIZATION / provider.invalid 占位符；用户明确实际模型注册、端点/profile 与 task/campaign 数值预算后，另行创建绑定最终候选的配置并依次兼容 → smoke → 正式对照。unknown usage、清理失败或原生隔离失败停止阶段，失败/skipped 保留在计划分母。草案预算不是供应商账单硬上限。

## 补丁发布交付

新的用户授权明确将本次变更按补丁修复交付，保持现有功能定位。补丁交付根为 `<LOCAL_EVIDENCE>`；发布前检查日志、准确源码/构建摘要、远端两平台 CI、tag 与 Release 核对结果都保留在该根，最终以 `delivery-receipt.json` 为准。

先提交含 `[skip publish]` 的修复标题并推 main，保留 Test workflow；两平台 CI 通过后显式推送与 manifest 匹配的 tag，触发现有 Release workflow，再核对正文、tag commit 与 latest 标记。补丁说明描述网络、资源清理、计量和工程门禁修复，不把离线准备包装成新产品功能或真实模型质量提升。workflow 不执行 npm publish。

版本更新和最终 commit 会改变候选身份。之前 final readiness 根只代表实现阶段，不能作为补丁发布候选；发布交付根重新绑定当前 source/build/revision 和 preflight。独立评分器 proof 仅在 evaluationDigest 一致时复用并保留来源；旧 live 或合成候选结果不迁移为当前付费验收。
