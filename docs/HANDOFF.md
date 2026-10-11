# 当前交接

更新日期：2026-10-11。入口为 [AGENTS](../AGENTS.md)，当前专题是 [开发验收](DEVELOPMENT.md)、[专用 Windows Runner](WINDOWS_RUNNER.md)。前次 MCP 安全补丁、完整测试及已发布产物的证据移至 [历史交接](archive/HANDOFF-2026-10-11-mcp-security.md)，不作为本轮验证结果。

## 范围与授权

实施问题 5–10 的发布、原生依赖分发和平台验收补丁。第 7 项独立 Oxlint 已存在，继续保留；macOS 按用户选择标注实验性支持。用户明确授权实施、补丁版本更新、提交、推送及 GitHub Release。用户另确认专用 Windows 机器尚未准备，先完成代码和部署说明；原生发布门禁不能因此跳过。展示版本由 0.5.2 调整为候选 0.5.3。

起点为 `796f75be499794eab66f6fcdd238badd6921785d`，main 与 origin/main 一致。保留既有 untracked `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`。没有付费模型请求或 npm registry 发布。

## 实现与边界

- Test/Release 共用 Windows/Linux Node 22 四项门禁；PR/main 增加稳定 Required checks。Release 只接受 main 上完整候选 SHA，冻结后只构建一个 tarball，同一 artifact ID 与摘要用于两平台 npm/pnpm/global 消费者验收。汇总必需 job 成功后才创建 tag/Release；冲突 tag/资产不覆盖。故障演练执行真实失败 Windows 测试且始终禁用 publish。
- 所有远程 Actions 固定完整 SHA，核对上游版本及 Node 24 runtime，应用仍使用 Node 22；Dependabot 提供升级 PR。只有 publish 有 contents 写权限。调用原生 reusable job 授予的 Actions 取消权限仅用于 hosted 排队 watchdog，专用 native job 明确收紧为 contents read。
- 维护者 staging 从完整性锁定的 node-pty/node-addon-api 原包生成 patched bundle，包含源码、许可证和平台 prebuild；不复制开发机编译结果，不让消费者继承仓库 pnpm 补丁，不增加消费者补丁 hook。普通 prepack 拒绝未准备产物，使用 pack:release。Linux 安装需要 Python/make/C++；pnpm 原生脚本明确准入。
- 实际 Windows 回归发现 PTY 先 Ctrl+C 会失去 detached 后代清理机会，改为先严格终止进程树再关闭控制台，结果等待清理，清理错误保留失败。消费者测试检查真实 PID 退出、原生 resize、输入、重启及取消，不能用补丁文本代替行为。
- Windows native required 模式覆盖五项真实 sandbox/team 用例；GITHUB_ACTIONS 不再直接跳过。缺少/重复/skip/TODO/失败拒绝，收据绑定 commit、源码和日志摘要。专用机器需注册指定标签并配置 Administration read 的 RUNNER_READ_TOKEN；不可用时失败关闭，排队超时由 hosted watchdog 取消。部署要求见专用说明。

## 当前验证状态

本机 Windows 候选串行 typecheck → lint → test → build 全部 exit 0。全量 1,164 项：1,161 通过、3 项平台跳过、0 失败；本机不能创建的 symlink、临时目录 alias 及 Unix 子进程超时不算通过。发布安全回归 7 项通过；install:verify 与 install:smoke 通过，真实 PTY 7 项零跳过。Workflow 固定身份扫描、actionlint（显式声明专用标签）及变更文档链接检查通过。

独立 patched tarball `everpeace-0.5.3.tgz` 的 SHA-256 为 `0964b548d0dba5a2e03eb942feeb14dd9c944f8e4350df6549f329b62e9afafa`。Windows 干净 npm/pnpm/global 三种安装全部成功，各自三项 CLI/SDK/PTY 实际行为检查零跳过，全局 cmd shim 也实际启动成功。required native 五项必需用例全部真实执行且通过，事件日志与包收据绑定同一开发源码摘要；这些收据标记 dirty，只能算开发证据。正式远端验证需重新构建并绑定干净提交。

此前消费者开发日志保留了配置路径、resize 判据和全局 cmd quoting 的失败，均已按实际原因修订。WSL 原生构建工具安装因发行版 DNS 解析失败，未获得 Linux 消费者成功证据，将由准确提交的 GitHub Ubuntu 任务验证。

外置证据根：`C:\Users\39850\AppData\Local\Temp\everpeace-distribution-30b46b1685c1497ba90539e9cd829a02`。初版包与开发收据为 dirty 工作区，不是可发布候选；最终远端验证必须重新绑定干净提交。

## 交付与未完成事项

当前尚未提交本轮代码。仓库 Runner API 核查为零，main 分支保护尚未设置。工作流部署后须激活 Required checks 并 API 回读，执行 failure_drill 并确认没有新 tag/Release，再对准确候选运行正式流程。专用 Windows 基础设施未接入，不能将本机开发验收或 hosted skip 当作候选原生 CI 成功；正式 Release 必须保持阻塞，直到该必需任务成功。
