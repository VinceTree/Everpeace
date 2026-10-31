# 当前交接

2026-10-23：第一批构建与检查脚本修复已通过完整门禁并提交、推送；第二批完成 MCP 启动前异常收尾修复并通过独立完整门禁。分支 `codex/public-contract-core-experience`，起点 `a1f8357`，开始时工作树干净。当前源码候选仍为 `0.6.0-rc.4`；本轮不改版本、不调用真实模型、不创建 tag 或 Release。

此前的可靠性与 Benchmark 记录已移至 [历史交接](../archive/HANDOFF-2026-10-13-reliability-benchmark.md)，其中的授权、工作树状态和检查结果只代表当时，不作为本轮证据。原有 ignored 用户资料保持原样。

## 第一批实施

- 隔离真实 TypeScript 复现了模块改名后旧 JS、声明和 source map 残留；构建入口改为清理当前工作区固定的 `dist` 后调用本地 TypeScript，拒绝已有 symlink/junction 或非目录，启用 `noEmitOnError`。
- 文档检查在删除已跟踪文档后抛 ENOENT，已由隔离 Git 用例复现。lint 的 Oxlint 本身忽略缺失路径，没有复现同样的退出错误；两入口现共用实际存在的 Git 清单，空源码集仍拒绝，非普通文件和其他访问错误不静默跳过。
- 新增与重命名后的文件继续检查；ignored 和无关用户目录不扫描。删除目标的残留链接与新增文档隐私路径仍使文档检查失败。
- 更新开发指南、双语 README、项目地图及当前计划；旧 pnpm 和 target 描述与当前配置校准。
- 首轮全量测试中两个真实 sandbox MCP 用例失败。直接复查仓库策略得到 `Sensitive-path scan incomplete; sandbox launch blocked`：测试工作区错误依赖开发仓库的私有缓存。两个用例改用独立临时工作区，保留生产 sandbox 和扫描限制，隔离后的定向回归 2 项通过。

## 本轮验证

- 定向 `node node_modules/tsx/dist/cli.mjs --test tests/unit/development/*.test.ts`：7 项通过、0 失败、0 跳过，覆盖真实编译器、Oxlint 和临时 Git 工作区。
- 首轮门禁 typecheck、lint 通过，test 中上述 MCP 用例失败；日志 `.cache/optimization-batch1-r1/` 保留，不能作为成功证据，build 未运行。
- 修正 fixture 后重新串行执行 typecheck → lint → test → build，全部通过。test 共 1346 项，1343 通过、3 跳过、0 失败，约 320 秒；日志 `.cache/optimization-batch1-r2/{typecheck,lint,test,build}.log`。跳过为本机文件 symlink 能力、Windows 临时目录别名专用场景和 Unix 超时子进程场景。
- 清理重建后的 `node scripts/source-install-smoke.mjs` 通过：CLI help、SDK import 与真实 PTY 生命周期 7 项，0 失败／跳过；日志 `.cache/optimization-batch1-r2/install-smoke.log`。
- 文档／UI／workflow 检查通过：161 份文档、953 组语言键及插值、固定 workflow 身份与门禁结构。第一批源码验证后只补充本交接收据，提交前重查文档和差异。

## 第二批与剩余边界

第一批已提交并普通 fast-forward 推送到 `origin/codex/public-contract-core-experience`，提交 `ec6acdeae88eaf315815ee368f25481e1bcc63f8`：`fix clean builds and resilient check inputs [skip publish]`。推送后通过 `git ls-remote` 核验相同 SHA，进入第二批时工作树干净。

第二批聚焦 MCP 启动前的异常收尾。沙箱策略／控制目录准备失败时，尚未创建进程的 transport 关闭没有发出事件；SDK supervisor 错等五秒后误记 ownership unresolved。新增三个回归在旧源码均失败，修复后通过：空 transport 恰好一次关闭通知、重复／重入关闭共用 Promise、关闭后拒绝 start/send，实际 SDK 与 runtime 保留原始启动原因且可正常关闭／刷新。

MCP 专项 58 项通过、0 失败／跳过，包含真实 stdio 恢复、原生 host 后代清理和网络／敏感读取隔离。补充 transport 与任务取消／Goal／Memory／宿主验证结算回归 15 项通过。已有进程仍等待真实退出，清理故障仍阻止复用和成功结算；没有修改请求计量或 Session schema。

第二批重新串行执行 typecheck → lint → test → build，全部通过：1349 项测试，1346 通过、3 项相同平台跳过、0 失败，约 293 秒；日志 `.cache/optimization-batch2-r1/{typecheck,lint,test,build}.log`。文档／UI／workflow 检查也通过，文档 161 份、语言键及插值 953 组。源码验证后只补充本交接收据，提交前重新检查文档和暂存差异。

本批按相同授权独立提交、推送，使用 `fix MCP transport closure before process startup [skip publish]`。后续核心链路审查继续按具体证据扩展，不将本次 MCP 修复表述为全链路缺陷清零。

本机为 Windows x64、Node 22.19.0、pnpm 10.30.3。本轮尚未执行真实 Windows Terminal 人工交互、Linux/macOS 原生、跨平台消费者安装或真实模型评测。详细平台限制仍见 [可靠性加固](../architecture/RELIABILITY_HARDENING.md)。

第一批推送回执提示默认分支有 8 项依赖告警（4 high、4 moderate）；这是远端默认分支提示，尚未核对当前功能分支的锁文件，不代表本轮供应链扫描结果。没有因此改依赖或版本。

Release workflow 已核对：仅 main 显式 workflow_dispatch，普通功能分支 push 不会创建 Release。提交使用 `[skip publish]`，不使用 `[skip ci]`；功能分支 push 不自动触发 PR/main Test，不将本地结果表述为远端 CI 通过。
