# 当前交接

2026-10-13：完成问题 13–23 的取消、进程清理与编辑可靠性修复，源码候选 `0.6.0-rc.3`。分支 `codex/public-contract-core-experience`，起点 `97f59fbe20f28d55e971d85979e8efa764243549`，开始时工作树干净。用户授权实现、更新候选号、提交和推送；不创建 tag/Release，不调用真实模型或付费评测。原有忽略的 `question`、`test-me`、`NUL` 与私有资料保持原样。

现行契约和回归入口见 [可靠性加固](architecture/RELIABILITY_HARDENING.md)。01–12 的历史证据在 [上轮交接](archive/HANDOFF-2026-10-13-security-privacy.md)，不可作为本轮验证。

## 实施结果

- 13：流取消直达等待，consumer/body/dispatcher 使用共享期限；故障关闭请求准入，usage 保留，辅助 dispose 有界。
- 14、15：Windows 私有 Job 在目标创建时建立归属，状态查询与独立终态收据，默认五秒故障期限；shell/PTY/Git/MCP/LSP/search/file worker 等接入，包含显式 host MCP，裸 Windows PID 拒绝终止。程序名只查询显式 PATH，IPC 启动失败清理 broker；诊断只保留进程内有界元数据。Unix 发送信号后查询组是否消失，查询失败保留故障。旧 taskkill 128 缺少后代证据，历史精确根因未定位，不能倒推历史清理成功。
- 16：搜索总输出限制 2 MiB，超限即停止进程及后续文件，区分 output_limit/timeout。
- 17、20：严格 hunk 数量/范围/连续性/换行校验，16 MiB 文件小修改，512 KiB 载荷及 64 MiB 批次预算，有界预览。
- 19：原始字节、manifest、安装身份和回滚意图持久保存，patch/undo/team 共用协调器；明确 committed/rolled_back/conflict/unknown。recover-batch 显式审阅，已提交只清理，后续保存或同字节换对象拒绝覆盖。
- 18：ask 中简单用户 allow 生效；项目限制独立求值，复杂语法询问；v1 allow 升级待显式激活。
- 21：子包发现和覆盖债务，根没有 Node manifest 也发现嵌套包；显式 /verify --package，证据绑定 workspace revision，不随恢复重放。Git 跟踪、依据捕获与子包扫描接入任务取消。
- 22、23：特殊快照稳定拒绝原因与 LFS 指针检测；网页静态提取/JS 未执行/可能不完整标记。

13、15–18、20、21 的行为修复通过本轮离线和本机回归；14 的新清理路径已缓解旧退出码依赖，历史故障仍未定位。19、22、23 保留明确设计限制：多文件非原子、特殊团队快照安全拒绝、网页只作静态提取。

## 本轮验收

| 检查 | 结果与证据 |
| --- | --- |
| typecheck → lint → test → build | 串行全部通过，首败停止；最终 test 共 1330 项，1327 通过、3 跳过、0 失败；约 353 秒。日志 `.cache/reliability-finalized-{typecheck,lint,test,build}.log` |
| required Windows native | 61 项通过、0 跳过、0 失败；69 条报告记录包含 8 条汇总。覆盖真实 Job 后代/owner 崩溃/IPC 拒绝、文件句柄竞争、批次强杀/原生阶段/磁盘失败注入、MCP 与团队隔离。日志 `.cache/reliability-native-final.log`，收据 `.cache/reliability-native-evidence/receipt.json` |
| UI / docs / CI 配置 | 953 组语言键及插值、135 份文档链接、工作流固定 revision 与门禁通过；`.cache/reliability-{ui,docs,ci}-final.log` |
| 安全与供应链 | 完整 Git 历史与维护源码秘密扫描、锁文件依赖审计、许可证与 SBOM 通过，未审阅秘密 0；`.cache/reliability-security-delivery/scan.json` |
| 安装 | install:verify、files:smoke、process:smoke 全通过；install:clean 从新源码副本 frozen-lockfile 安装并重编译两组件、构建与 CLI/SDK/真实 PTY 7 项烟测通过。`.cache/reliability-install-clean.log` |

全量测试跳过项是本机不允许文件 symlink、Windows 临时目录别名专门用例和 Unix 超时子进程实测。正常搜索超限及 host MCP 停止仍检查两秒快速界限；五秒只用于故障清理，不放宽正常取消。

原生收据核验的冻结源码摘要为 `b04e93476e36f5ecad3d2846e42b819e26e177293ba45e3feb386e6ef1498e49`，`dirty: true`，基于上述起点并包含全部修复；收据生成后只增补交接及双语说明，没有实施代码变化。日志保留在 ignored `.cache`，不提交用户私有资料，不把本地 dirty 收据当正式 Release 候选认证。前期失败及取消的门禁轮次保留为诊断日志，不能作为通过证据。

## 未验证与后续边界

Windows x64、本地 NTFS、Node 22.19.0、pnpm 10.30.3、MinGW-w64、Windows build 26200。真实模型零调用；真实断电、MSVC、Linux/macOS 原生和本轮人工 Windows Terminal 操作未执行。Unix 状态检查只有离线模拟回归，不将 Windows Job 保证推广到其他平台。Job 不证明服务/WMI 等外部执行代理归属；其他平台文件访问仍不可用。正式跨平台包组件传递与消费者验收沿用待办，不把源码安装当正式包证明。Windows host MCP 入口须为明确的 PE 程序，不能直接执行 cmd/bat，不回退 SDK shell。

## 提交与远端

修复提交 `ca4b9bcf1046b3de93a157666eb636705f2d6700`：`fix bounded cleanup and durable edit recovery [skip publish]`，包含候选号、实现、回归和文档。已普通 fast-forward 推送到 `origin/codex/public-contract-core-experience`，随后 `git ls-remote` 核验该分支指向相同 SHA；此后只追加本交接收据，未改实施源码。

交付使用 `[skip publish]`，不使用 `[skip ci]`；Release 工作流只有 main 上显式 workflow_dispatch。Test 工作流仅 PR/main push 触发，当前功能分支 push 不自动触发它，不能声称远端 CI 通过。本轮没有 tag、Release 或 npm 发布。

## 2026-10-13 Benchmark 交接（问题 24–41）

本轮完成 Benchmark 工程、真实上游 fixture、Usage 计量和离线评测准备。没有读取 API key/keyring，没有发起真实模型请求、DeepSeek 付费调用或外部 dsh 真实编码请求；没有改版本、提交、推送、tag 或 Release。当前工作树保留本轮未提交源码、测试和文档改动。

### 已完成的离线证据

- `docs/benchmark/real-fixtures/catalog.json` 冻结 Chalk、Commander、Day.js 共 12 项实际上游任务，三类各 4 项：`real_issue`、`dependency_compatibility`、`cross_module_refactor`。`.cache/benchmark-c-real-proof-v2/proof.json` 记录 12/12 的 pristine baseline pass、预期缺陷 assertion fail、reference repair pass 和独立 regression pass；`modelRequests: 0`。
- `.cache/benchmark-c-web-v3/report.json` 记录 24 页、8 个公共技术站点计划，22 页下载成功，Fastify 2 页连接失败并保留在失败分母。包含 DOM reference、代码/link retention、JS shell 和深层正文截断控制；`annotationReview: required before any accuracy claim`，不能称为通用网页准确率。
- `.cache/benchmark-memory-pilot-v2/proof.json` 记录 3 个 coding sequence、每个 4 个连续任务、on/off Memory、3 次 repetition，共 72 个计划任务；只在 coding verification 与 external acceptance 都通过后捕获 Memory，提取成本进入 ledger，前序失败保留后续 skipped。离线 proof 通过，`modelRequests: 0`。
- `.cache/benchmark-official-draft-v6/protocol.json` 记录官方 DeepSeek 端点草案 `https://api.deepseek.com`、占位 raw model/registration ID、12 个任务、每臂 5 次、正式每实验 120 runs、默认串行配对和保留失败分母。占位符继续阻止 live。
- Everpeace official/team/performance smoke preflight 通过，并实际观察 provider boundary、high reasoning、32,768 output 和团队成员请求；这是合成 provider boundary 的启动证据，不是供应商兼容或成功率证据。
- dsh smoke preflight 明确失败：固定 HEAD `639ed015397290b3745d163aafe02ffee4aa3f84` 正确，但现有 `C:\Users\39850\Desktop\coding-agent\deepseek-harness` 有 tracked modifications，未能证明干净部署。失败保存在 `.cache/benchmark-official-draft-v6/external/smoke/artifacts/preflight-result.json`，没有修改该 dirty worktree，也没有把失败当作通过。

### 代码与回归

- RequestAttemptLedger/RequestExecutor 保持 Unknown Usage sticky；请求数、rejected、unknown、purpose/reason 分开统计；缺少 cache usage 保持未观察，不补零；在途请求可超出 token admission，文档不将预算称为账单硬上限。
- campaign 支持同预算 paired arms，有限预算默认串行，双臂预算不足时保留完整 pair 分母；结果、计划、storage/cleanup/isolation/identity failure 都会阻止完整统计。paired interval 按 task cluster bootstrap。
- checkout identity 现在覆盖普通 checkout 的未忽略 untracked source，以及 dsh 的 apps/packages/vendor/native 生成模块（跳过 node_modules）；fresh worker 在异常退出且已有 Usage telemetry 时保留已知 usage 并标记 incomplete。
- 安全路径扫描继续保留 10,000 项上限；仓库 `.cache` 不作为敏感路径递归扫描对象之外的安全放宽，MCP 回归最终在无缓存干扰的证据副本中通过。
- `pnpm exec tsx --test --test-concurrency=4 tests/unit/benchmark/*.test.ts`：80 项通过、0 失败、0 跳过。
- 最终门禁在仓库外 fresh source snapshot `C:\Users\39850\Desktop\coding-agent\c-final-gates-20261013-v1` 串行通过：frozen install、build、typecheck、lint、全量 test（1340 项，1337 通过、3 跳过、0 失败）和 final build。收据为 `C:\Users\39850\Desktop\coding-agent\c-final-gates-20261013-v1\receipt.json`，日志为同目录各 `.log` 文件。隔离副本用于避免本地 Benchmark `.cache` 资料影响 MCP 安全路径扫描；不是新的提交或发布候选。

### 后续边界

仍需用户另行明确授权并提供真实供应商原始 model ID、登记 ID、数值预算和价格快照，才能执行官方兼容、smoke 或正式 120-run campaign。真实模型成功率、修复策略收益、单 Agent 对团队收益、外部 dsh 优势、成本/账单、Memory 长期净收益、复杂网站泛化和性能收益均未被本轮证明。生产默认仍是单 Agent、最多三轮修复。
