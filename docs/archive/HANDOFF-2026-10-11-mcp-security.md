# MCP 安全补丁历史交接

## 前次 MCP 补丁交付记录

更新日期：2026-10-11。本轮入口为 [AGENTS](../AGENTS.md)，专题为 [集成能力](architecture/CODEX_CAPABILITIES.md#启动信任与-http-边界)、[公共网络](architecture/NETWORK.md) 与 [开发验收](DEVELOPMENT.md#mcp-启动信任专项终端验收)。前轮网络、安装、团队准备及补丁交付记录保存于 [历史交接](archive/HANDOFF-2026-10-10-network-readiness.md)，不能作为本轮验证或发布授权。

## 范围与工作区

用户明确授权实施 MCP 独立启动信任、工作区持久保存、HTTP 限制、TUI/headless 接入和回归，并随后授权按补丁更新版本、提交、推送及 GitHub Release。展示版本由 **0.5.1** 更新为 **0.5.2**，同步 package.json 与双语 README。保留所有既有 untracked `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`；开始时没有 tracked 改动。没有付费模型请求或 npm publish。

## 实现

- stdio 在冻结的 command/args/cwd/env 下启动；workspace/server/transport 的 HMAC 配置授权保存在平台用户配置目录，密钥由 AuthStorage/keyring 管理。文件带 schema/revision，跨进程锁与原子替换；坏存储/缺钥不能放行。审批提交及落盘前核对当前配置、preview、store revision 和 generation。
- `/mcp trust <server>` 默认 Cancel，批准只保存权限；`/mcp reconnect` 显式启动或重载，`/mcp revoke <server>` 先取消 callable/binding、计时器、初始化和在途调用，再关闭服务并撤销持久授权。其他进程在下次授权检查时观察撤销，已运行宿主程序并非跨进程即时终止。
- 非回环 HTTP 全拒绝。回环 HTTP 需要单独授权，localhost 固定回环连接；HTTPS 保留内网兼容和证书校验。SDK 所有请求（含不继承 requestInit 的 SSE GET）通过受控 fetch 拒绝全部重定向，dispatcher 归 transport 管理。认证与环境冻结，预览、状态、日志和 Session 不存原始凭据。
- CLI/SDK enabled 未信任服务在模型请求前返回 interaction_required/exit 5，区分 mcp_start/mcp_http；full-access 与工具审批均不能授予启动信任。Session schema 不变，授权不由历史恢复。
- Web 原有 DNS 绑定保持；补充独立 IANA 端点/邻接/格式回归，发现并拒绝此前会被允许的公网 scoped IPv6。

## 验证状态

当前候选最终串行 `pnpm typecheck → pnpm lint → pnpm test → pnpm build` 全部 exit 0；`git diff --check` 与新增文件空白检查通过。全量共 1,156 项：1,153 通过、0 失败、3 跳过。跳过分别为本机文件 symlink 权限、Windows 临时目录 alias（由 clean-checkout CI 覆盖）和 Unix 子进程超时场景；不算平台实测通过。本机门禁在 Windows 执行，补丁候选另通过下面的 Ubuntu CI。

MCP 安全回归 15 项全部通过、无跳过，覆盖真实 stdio 零启动/批准/重启/工作区隔离、审批提交期间配置变化与取消、跨进程锁/撤销、活动调用与迟到初始化、坏存储/keyring、HTTP 拒绝/本机例外、凭据脱敏、所有请求方法与重定向、真实 SDK SSE、受信 HTTPS 降级拒绝、localhost 固定回环和 TLS 失败。既有协议、stdio 恢复、Web DNS 绑定、独立 IANA 地址、headless Plan/full-access 和 TUI 回归包含在最终全量结果中。

首次全量有 3 项 Agent 快照回归失败：新增 preflight 重复读取首步目录。已改为首步复用该快照，3 项定向回归与最终完整门禁通过；失败原始日志保存在外置 `initial-test.log`，不覆盖为成功记录。

真实 Windows Terminal 已以 owned 离线 fixture 验证：未批准、默认 Cancel、Esc 和 Ctrl+C 均零启动；resize 保留预览；取消后返回同一 Session 且单 prompt。批准仅落盘，重连 ready/6 tools、marker 恰好 1 次；撤销后 grant 删除、工具归零、stdio 退出，再重连没有新增启动。测试使用软件按键与实际窗口截图，未冒称人工按键；owned 终端和 fixture 均已退出。之后仅补诊断脱敏，相关路径由最终自动回归验证。

本轮外置证据根：`C:\Users\39850\AppData\Local\Temp\everpeace-mcp-security-fd060153a5e34e7ab5315d8ef5666f3b`，包含 `gates.json`、`final-*.log`、`terminal-receipt.json`、`terminal-evidence/actions.jsonl` 和窗口截图。真实终端使用 owned fixture、合成 HMAC 与 marker；没有修改用户 MCP 配置或 keyring。

## 补丁交付

用户随后明确授权将上述修复作为补丁提交、推送、更新展示版本和 GitHub Release。补丁起点为 `5665724b64e86431af2fc481e572dc5ba3454162`；源码提交 `4b3f4d1a06f1eab48075e647770b6dc351c33001` 已推送 main，tag `v0.5.2` 与 manifest 一致且解析到该提交。标题 `fix: require MCP startup trust and secure transports [skip publish]` 暂缓分支自动发布、保留 Test workflow；对应 [Windows/Ubuntu CI](https://github.com/VinceTree/Everpeace/actions/runs/38109776300) 两项 job 均成功后才推送 tag。

对应 [Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/38110024777) 已成功，[v0.5.2 Release](https://github.com/VinceTree/Everpeace/releases/tag/v0.5.2) 已发布并设为 Latest，非 draft/prerelease。实际正文与审阅的双语安全补丁说明逐字核对，保留既有配置需独立启动批准、MCP 仍有宿主用户权限和不提供进程沙箱/依赖完整性验证的升级边界。随后仅追加这份交付记录，不移动已经通过验证的 tag。

补丁交付根为 `C:\Users\39850\AppData\Local\Temp\everpeace-patch-20261011-501d21521426410e85fb0d5f07a6e78d`。更新展示版本后重新执行串行门禁，准确结果保存为 `local-gates.json`、`final-*.log`；`delivery-receipt.json` 绑定源码 commit/tree、构建文件摘要、远端 CI、tag 和 Release，`ci.log`、`ci.json`、`release-run.json` 保留实际远端结果。此前实现证据继续保留，不冒充新候选身份。

补丁候选四项门禁全部 exit 0，完整测试仍为 1,156 项、1,153 通过、3 项平台跳过、0 失败。`pnpm install:verify` 核对固定原生依赖及实际补丁通过；`pnpm install:smoke` 的构建 CLI、SDK 导入与 6 项真实 PTY 生命周期检查通过、无跳过。差异空白检查通过。源码、构建及提交身份由交付收据绑定。

## 保留边界

MCP 启动批准仍意味着宿主用户权限，未新增原生进程沙箱或程序/依赖完整性验证。受信任程序仍可能产生自主副作用；工具审批不约束其宿主权限。生产不支持 OAuth/header helper。独立 npm 消费者补丁分发、真实付费团队评测等前轮事项仅作为未完成历史保留，未获本轮新授权。
