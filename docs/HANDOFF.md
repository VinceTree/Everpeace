# 当前交接

更新日期：2026-10-11。入口为 [AGENTS](../AGENTS.md)，当前专题是 [开发验收](DEVELOPMENT.md)、[专用 Windows Runner](WINDOWS_RUNNER.md)。前次 MCP/公共网络补丁及已发布产物证据见 [历史交接](archive/HANDOFF-2026-10-11-mcp-security.md)，不替代本轮验证。

## 范围与交付状态

用户授权实施问题 5–10、补丁版本更新、提交、推送和 GitHub Release，并确认专用 Windows 机器尚未准备，先完成代码与部署说明；macOS 采用实验性支持。本轮源码和双语 README 展示候选版本为 **0.5.3**。生产源码候选 `6daf34bf7ead487985e1fe2996bd432217cf9764` 已经保护分支 PR 检查合入并推送 main。**尚无 v0.5.3 tag/Release；最新已发布 Release 仍为 v0.5.2。** 不绕过新门禁发布。

| 问题 | 本轮状态 |
| --- | --- |
| 5：发布等待测试 | 已实现共享平台门禁、准确 SHA、同包消费者检查及必需结果汇总；两次真实 Windows 失败演练均阻止发布。 |
| 6：node-pty 分发补丁 | 已实现校验上游包后生成 patched bundle、Linux 生产构建；同一个包在 Windows/Linux 的 npm/pnpm/global 真实安装和生命周期验收均通过。 |
| 7：独立 lint | 当前已存在锁定 Oxlint，保留警告失败及 PR 必需门禁；不声称已提供类型感知 Promise 分析。 |
| 8：完整 Windows 原生 CI | required 模式、五项必测、排队 watchdog、收据和部署说明已实现；本机真实验收通过。专用 Runner 未部署，候选原生 CI 及发布仍未完成。 |
| 9：macOS | 按用户选择明确实验性支持；不声称完整 CI、Keychain 或 Seatbelt 验收。 |
| 10：Action 身份固定 | 全部远程 Actions 固定完整 SHA，已核对上游身份/runtime，并配置 Dependabot 升级 PR。 |

main 的 Required checks 分支保护已实际启用：strict、绑定 GitHub Actions app 15368、适用于管理员，API 回读核对。后续修改通过保护分支 PR 合入，不关闭测试或绕过保护。

## 实现与边界

- Release 仅从 main 显式 dispatch 完整候选 SHA，确认属于 main 历史。共享 Windows/Linux Node 22 四项检查通过后，只在 Ubuntu 24.04 x64 构建一个 tarball；两平台消费者下载同一 artifact ID 并检查同一摘要。缺失、失败、取消、skipped 均拒绝发布；只有最终 publish job 有 contents 写权限，冲突 tag/资产不覆盖。
- 打包器在独占 staging 校验固定 node-pty/node-addon-api 原包完整性，应用仓库补丁，以标准 npm bundle 包含源码、许可证、上游 Windows/macOS prebuild 和新构建的 Linux `pty.node`。Linux pnpm 不执行 bundled 子包安装脚本，因此构建发生在维护者 staging；Linux forkpty 不需要仅 macOS 构建的 spawn-helper。消费者没有补丁 hook，无须克隆仓库。Windows 本地打包仅作开发，其他 Linux 系统/架构尚未验收。
- 干净 npm/pnpm/global 消费者独立 HOME、配置、缓存和 prefix；只从已安装 dist/公开 SDK/原生依赖验证 CLI、输入、resize、重复启动、取消及 PID 清理。全局安装额外执行真实 cmd shim/Unix bin。修复 CLI 入口对 npm 符号链接的识别及 Runner node_modules/.bin 下 pnpm JS launcher 定位。
- Windows PTY 取消先严格终止进程树再关闭控制台，防止 Ctrl+C 使 detached 后代脱离清理；结果等待清理，清理异常保留失败。该证据针对受控 fixture，不推断任意后代均受约束。
- 专用 Windows required 模式不因 GITHUB_ACTIONS 跳过，要求五项真实 sandbox/team 用例恰好一次通过且无 skip/TODO。收据记录 commit、源码字节摘要、backend/平台和事件日志摘要。专用任务不持有发布 token，hosted watchdog 的取消权限只用于其自身 run。机器、账户隔离、注册标签及重置要求见部署说明。

## 本轮验证证据

本机 Windows 对 PR head `22fdf2e066f2bf838885df9bacfb9b92ef157e9c` 串行执行 typecheck → lint → test → build，均 exit 0；全量 **1,166 项，1,163 通过，3 项平台/环境跳过，零失败**。合入候选的 Git tree 与该已测 head 完全相同，绑定记录为 local-candidate-binding.json，未冒充重新执行。发布安全回归九项全部通过，包含真实失败 lint/Windows fixture、缺失/skip/SHA/包摘要/tag 冲突拒绝、零发布 API 写入及安装超时进程清理。安装验证、真实 PTY 回归、workflow 静态扫描和 actionlint 通过。

候选 `6daf34bf7ead487985e1fe2996bd432217cf9764` 的独立本机 required native 验收再次执行并通过五项必需用例，零跳过；收据 success=true、dirty=false。覆盖 MXC 文件/状态/Git 拒绝、直接网络拒绝、detached 后代取消及两生产 worker 整合。它是绑定提交的本机证据，**不代替专用 Runner CI**。

[最终候选流程](https://github.com/VinceTree/Everpeace/actions/runs/38116316955) 使用准确候选并通过 Windows/Linux 的 typecheck、lint、完整 test、build 与源码安装 smoke。Windows 全量 1,166 项、1,159 通过、7 跳过；Ubuntu 全量 1,166 项、1,158 通过、8 跳过，均零失败。hosted 的原生 Windows skip 不计为必需原生成功。

最终包 artifact **11693590864**（candidate-package）由 Linux package job **114402335365** 生成。`everpeace-0.5.3.tgz` SHA-256：`5e048b805ee24709fd13868df5b99651269b640bf643a03d6a21b193d09d159d`。已下载并独立检查收据 commit、dirty=false、run ID 和包字节摘要。Linux 消费者 job **114402413925** 和 Windows 消费者 job **114402413935** 均成功：每个平台的 npm/pnpm/global 各三项 CLI/SDK/PTY 回归全部通过，各九项零跳过；真实全局 Unix bin 和 Windows cmd shim 均启动成功。

[首次失败演练](https://github.com/VinceTree/Everpeace/actions/runs/38113460361) 和 [再次失败演练](https://github.com/VinceTree/Everpeace/actions/runs/38114684335) 均实际执行故意失败的 Windows 测试，validate/gate 失败、drill 成功、publish skipped，核对零候选 tag/Release。后续仅修订打包和入口源码，Release DAG 未改变；不将演练整体 failure 写成发布成功。

此前候选流程保留真实失败：[首次安装包验收](https://github.com/VinceTree/Everpeace/actions/runs/38113775671) 发现 pnpm bundled 子包无 Linux 构建及 Runner launcher 定位问题；[后续生产构建](https://github.com/VinceTree/Everpeace/actions/runs/38114719881) 暴露错误要求 Linux spawn-helper；[全局命令验收](https://github.com/VinceTree/Everpeace/actions/runs/38115570776) 暴露 Unix symlink 入口静默退出。上述失败按固定上游条件和真实安装行为修复，失败轮不计作成功证据。

外置证据根：`C:\Users\39850\AppData\Local\Temp\everpeace-distribution-30b46b1685c1497ba90539e9cd829a02`。最终包及收据位于 final-candidate-package；本机门禁 entry-final-*、绑定 local-candidate-binding.json、原生 native-final-candidate、远端 final-* 日志。较早 dirty 开发包和失败日志保留，只供诊断，不可替代最终产物。

## 发布阻塞与后续接入

Runner API 当前 total_count=0，RUNNER_READ_TOKEN 未配置。最终流程的 availability 因缺少此配置而失败，native skipped、gate failure、publish skipped；平台、打包及两平台消费者均 success，流程整体 failure 是基础设施门禁的正确拒绝，不是完整发布成功。再次核对 v0.5.3 tag/Release 均不存在。不得使用本机成功或 hosted skip 替代。专用 Windows 机器按 [部署说明](WINDOWS_RUNNER.md) 接入后，重新对准确候选运行全部发布必需检查，只有同包消费者和 required native 全成功才能创建 tag/Release。不能先手工建 draft/tag 再补验收，也不移动冲突 tag。

起点为 `796f75be499794eab66f6fcdd238badd6921785d`。初版 `152a791d5db905ea1e7623380d595b0035cd1f32` 与后续 `79bcc32f751af4e0e6031d977a24ddb614d7fe85`、`257a97c2ab5b8065eed0447331fc8b299e31a93a`、最终生产候选均已提交、推送。保留用户原有 untracked `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`。本轮没有付费模型请求、npm registry 发布或外部上游投稿。
