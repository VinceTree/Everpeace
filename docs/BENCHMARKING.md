# Coding Task Benchmarking

修复分配与 single/team 是两个独立实验。`pnpm exec tsx tests/fixtures/prepare-controlled-experiments.ts <新绝对证据目录>` 在 build 后准备冻结的 19 任务、每臂三次、配对交错计划和无网络生产 preflight；端点/model/budget 草案不是付费授权。`ordering: paired` 保留每个 task/repetition 的两臂，交替先后顺序，不用重跑替换失败。[计量、比较规则与限制](architecture/VALIDATION_PRIVACY_PERFORMANCE.md)。

Everpeace 的 benchmark 层比较 harness、模型策略和恢复策略在真实 coding task 上的表现。主指标是固定请求预算内，由独立断言确认的任务通过率。该层不改变 Agent 的权限、验证和 Session JSONL 语义，也不会自动 reset 或清理日常工作区。

当前 [十项 Node 清单](benchmark/DEEPSEEK_NODE_TASKS.json) 已包含固定 revision、setup、pristine assertion、reviewed seed/reference patch 与 evaluator-owned acceptance；正式 parser 缺少任一项都会在模型请求前拒绝。十项 Chalk、Commander 和 Day.js fixture 已逐项离线证明 pristine pass → seeded assertion failure → reference pass。Commander 与 Day.js 使用上游 lockfile；Chalk 固定 revision 原本用 `.npmrc` 禁用 lockfile，因此评测材料保存 evaluator-owned `chalk-package-lock.json`，准备器在 setup 前排他复制。三组统一用显式 npmjs registry 执行 `npm ci --ignore-scripts`，避免本机 registry 配置改变依赖来源。

## DeepSeek loop A/B acceptance

开发 fixture [deepseek-loop-acceptance](../tests/fixtures/deepseek-loop-acceptance.ts) 显式提供 `prepare|offline|live`，不从常规测试发请求。准备根必须位于仓库外且不存在；Session、结果与凭据目录不共享。prepare/offline 不读取个人凭据、不访问模型服务。以下命令中的 `$root` 应是新的本地报告子目录：

```powershell
pnpm exec tsx tests/fixtures/deepseek-loop-acceptance.ts prepare $root
pnpm exec tsx tests/fixtures/deepseek-loop-acceptance.ts offline $root
pnpm benchmark:campaign -- --config "$root/comparison.json" --prove-fixtures
pnpm benchmark:campaign -- --config "$root/smoke.json" --preflight
```

prepare 冻结兼容提示、harness 摘要、候选 revision/source/build digest，以及任务目录和全部 fixture 文件的 evaluationDigest；任务提示、依赖锁、seed/reference 或独立断言变化均阻止运行。代码、构建或提交变化后使用新根重新准备，保留旧证据。原始源码基准单独保存；A 为协议修正后的 baseline，B 仅显式开启 candidate 调度提示和反馈，两组使用同一生产 runner。配置随机交错，同一任务不提示工具名称或操作顺序。

| 待单独授权的阶段 | 固定范围 | task / campaign token 草案 |
| --- | --- | --- |
| 兼容 | 文本终态及 usage；携带完整 reasoning 的两轮文件读取 | 10,000 / 20,000 |
| smoke | 目录前三任务，A/B 各一次，共六次 | 100,000 / 600,000 |
| 正式 | 十项 Chalk/Commander/Day.js，A/B 各三次，共六十次 | 100,000 / 6,000,000 |

固定中转 `https://cc2.caaa.tech/v1`、原始 ID `deepseek-flash`、显式 deepseek profile 和 high；兼容输出最多 1,024，编码对比最多 32,768。每任务十五分钟，最多三轮实际启动的修复。预算不是预计要用满或严格账单上限，准备配置不构成授权。分别取得明确数值授权后，才可运行 fixture 的 `live $root --token-budget 20000` 或相应 campaign 的 `--live`。unknown usage、隔离或资源清理失败停止阶段，started 标记和旧账本不能清除重跑；失败和跳过留在计划分母。只证明该中转路径，不外推官方直连。

campaign 在本地生成 `strategy-comparison.json`：总体及逐任务通过数不能低于基线，人工介入不能增加，成功必须同时通过宿主验证和独立验收，安全结算无回退。质量通过且完整计量后，比较成功任务总消耗、包括失败消耗的每成功任务成本、共同成功任务 token 中位数、请求次数、耗时、工具批次/等待/重复失败、reasoning/cache 及请求字节比例。reasoning 已包含在 output，不重复相加；缺失缓存为 null，JSON 字节比例不冒充 token。共同成功任务 token 中位数下降至少 10% 才报告该端点和样本中观察到节省；候选默认关闭，无有效 live 证据不改默认行为。

## Task and fixture contract

每个任务包含唯一 `id`、自然语言 `prompt`、隔离工作区、固定源码和有界命令。`verification` 可向 harness 提供开发反馈，最终评分优先使用模型无法通过改写项目脚本替代的 `acceptance`。

```ts
import type { BenchmarkTask } from "../src/benchmark/index.js";

export const task: BenchmarkTask = {
  id: "fix-parser-regression",
  prompt: "Fix the parser regression and keep existing behavior passing.",
  workspacePath: "unused-before-preparation",
  source: {
    repositoryUrl: "https://github.com/example/project",
    commit: "0123456789abcdef0123456789abcdef01234567",
    issue: "42",
    license: "MIT",
  },
  fixture: {
    setup: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
    pristineVerification: { command: process.execPath, args: ["reviewed-acceptance.mjs"] },
    seedPatch: "fix-parser-regression/seed.patch",
    referencePatch: "fix-parser-regression/reference.patch",
  },
  verification: { command: "pnpm", args: ["test"], timeoutMs: 120_000 },
  acceptance: { command: process.execPath, args: ["reviewed-acceptance.mjs"], timeoutMs: 120_000 },
  timeoutMs: 15 * 60_000,
  maxRepairAttempts: 3,
};
```

`prepareBenchmarkFixture()` 只克隆到已确认不存在的目标，校验 pinned HEAD，执行有界 setup 和 pristine assertion，再应用 seed。`proveBenchmarkFixture()` 必须证明：

1. pinned source 的独立断言通过；
2. seed 应用后，同一 assertion 因预期缺陷失败；
3. reference repair 应用后，同一 assertion 再次通过。

超时、缺少依赖、命令启动失败和 `exitCode: null` 都是基础设施失败，不算有效 seed。验证结果把 `timedOut` 与 `cancelled` 分开记录；任务或 campaign 取消不能伪装成验证超时。重复运行使用 `createIsolatedBenchmarkPreparer()` 创建 `campaign/harness/task/repetition` 目录，避免 harness 和 repetition 相互覆盖。

准备、验证、外部 harness、checkout worker、dsh 与工作区快照的取消会等待进程 close 和进程树终止请求。清理失败保留 `cleanupFailed`，suite/campaign 停止后续任务并以 `cleanup_failed` 记录 skipped，统计完整性为 false；准备器保留清理失败的工作目录。预取消验证不启动进程，`attempted` 为 false。并发快照命令全部结算后才返回。

## Production and external adapters

TUI、公开 `everpeace exec` 与 benchmark 通过 `src/runtime/production.ts` 共用生产 Agent/命令 factory 和 `CodingTaskRunner`。`createProductionBenchmarkAdapter()` 在无 Ink 环境中显式覆盖评测参数与批准策略，并构造 Session、权限、原生 sandbox、workflow 和 runner；同一个 Agent/Session 内完成工具循环、最多三轮诊断、完整最终验证、Goal 及 Memory 结算。adapter 标记 `managesRepairs`，因此 evaluator 只运行独立 acceptance，不会叠加另一套自动修复循环。公开 exec 使用正常模型注册/keyring 和交互停止语义，不直接暴露此 benchmark adapter 或 evaluator contract。

```ts
import {
  createProductionBenchmarkAdapter,
  runBenchmarkSuite,
} from "../src/benchmark/index.js";

const adapter = createProductionBenchmarkAdapter({ model, sessionsRoot });

const summary = await runBenchmarkSuite(tasks, adapter, {
  prepareRun,
  repetitions: 3,
});
```

`createCheckoutBenchmarkAdapter()` 为 baseline 与 candidate 提供同一条 fresh-process worker 路径。每次运行都从指定 checkout 动态导入 production adapter，并重新核对完整 Git revision、runtime source digest 和已构建 entry digest；source digest 覆盖 `src` 中 tracked、deleted 与未忽略 untracked 内容，以及 manifest、lockfile 和 TypeScript 配置，因此候选新增文件会改变身份，而仓库外或无关根目录文件不会。worker 强制使用配置中的原始模型 ID、`high` reasoning 和 32,768 output tokens，不继承个人保存的 request settings。基线和候选可以共享 revision，例如基线为干净 `b226bfc` checkout、候选为该 revision 上的明确工作树内容；digest 才区分两者。preflight 失败会在错误中给出实际 digest，供 reviewed 配置更新。

`createProcessHarnessAdapter()` 参数化启动固定外部程序，不使用 shell 拼接；通用外部 wrapper 必须在自己的 LLM 边界输出一行 `EVERPEACE_BENCHMARK_RESULT <JSON>`，launcher 不从最终回答猜测 usage。固定 dsh 使用 `createInstrumentedDshAdapter()`：它要求源码 checkout 的完整 HEAD 为 `639ed015397290b3745d163aafe02ffee4aa3f84`，直接通过 Node 启动该 checkout 内的 built `apps/cli/lib/bin.js`，并创建内容锁定的专用 headless profile。profile 在 dsh 的 `llm/stream` waterfall 记录每次 coding、重试、摘要和标题请求，校验模型原始 ID、主编码请求的 `high` reasoning 与 32K 输出上限，在每个 provider 请求前检查剩余预算，并把 cache/unknown usage 交回 campaign。缺失或非法 token 字段会永久把该任务 usage 标为 incomplete 并阻止后续请求；cache 字段缺失时 denominator 保持未观察。取消或失败时仍在清理临时目录前保存脱敏 ledger。Windows 不经过 `.cmd` 或 shell。

dsh 配置需要 `sourceRoot`、位于该目录内的 `entryPath`、独立 `dshHome` 与专用 `profile`。首次运行只在 profile 不存在时写入 reviewed manifest/patch；已有 profile 内容不一致会失败关闭。运行前需在固定 checkout 中完成官方依赖安装和 build，这一步不会由 campaign 静默执行。profile 禁用 Web tool、使用隔离的 Agents home 和关闭遥测；API key 只在 live 子进程环境中传递，不写入配置、ledger 或 artifact。

## Campaign command

内部入口要求配置文件，并且必须在无凭据启动预检、离线 fixture proof 与 live campaign 中三选一：

```powershell
pnpm benchmark:campaign -- --config .\campaign.json --preflight
pnpm benchmark:campaign -- --config .\campaign.json --prove-fixtures
pnpm benchmark:campaign -- --config .\campaign.json --live
```

配置包含 `campaignId`、catalog/fixture/run/artifact/session 目录、已注册的 `modelId`、随机 `seed`、`repetitions`、`taskTokenBudget`、`campaignTokenBudget`、可选有序 `taskIds` 和名称唯一的 harness 列表。可从 [示例配置](benchmark/CAMPAIGN_CONFIG.example.json) 开始。`everpeace-checkout` 分别命名 baseline/candidate 并指定 source/build identity；`dsh` 使用固定源码与内置 instrumentation；既有单个 `everpeace` 和 `instrumented-process` 配置继续兼容。通用外部参数模板支持 `${PROMPT}`、`${WORKSPACE}` 和 `${TOKEN_BUDGET}`，以 argv 传递而非 shell 拼接。

`--preflight` 不读取系统 credential storage，也不发送模型请求。它实际启动每个 checkout fresh worker、导入 production entry 并在真实 provider request boundary 注入合成 response；dsh 同样启动固定 CLI/profile，在 `llm/stream` boundary 注入合成响应。两者传入 dummy credential，在 Node socket guard 下要求完成；Windows 上 dsh 启动 deadline 为 60 秒，其他平台为 30 秒，以覆盖冷启动 profile composition。结果把 entry/profile loading、request-boundary interception、effective settings、checkout identity、usage ledger 与失败写入 `preflight-result.json`。这是 startup/admission 证据，不是 scored result，也不证明操作系统级断网。无 digest 的旧 `everpeace` 与未定义无凭据预检契约的通用 `instrumented-process` 在该模式失败关闭，live 兼容性不变。

Windows 上 benchmark verification 保持 `shell: false`；manifest 中的 `npm` 命令通过当前 Node 安装的 `npm-cli.js` 直接启动，不经过不可直接 spawn 的 `npm.cmd` batch shim。fixture 准备失败时删除临时 checkout 使用有界重试，避免 Windows 文件句柄短暂占用覆盖原始失败原因。

Day.js 的 evaluator 会加载固定源码中的 Babel toolchain；四项 pristine 与 acceptance 统一使用 120 秒 deadline，覆盖 Windows 冷启动。该时限对所有 harness 相同，不修改断言、任务总时限、seed/reference patch 或评分规则，超时仍是基础设施失败。

live 入口在任何请求前写入 `campaign-plan.json`，随后随机交错 harness 顺序；结果写入 `campaign-result.json`，包含完整 planned、executed、skipped、unknown usage 和 stop reason。每个 skipped 项保留 adapter、task 和 repetition。准备失败作为执行结果保存，不算有效 seed，也不会消费模型预算。

## Usage and budget

真实请求必须显式设置 `liveApi: true` 和正整数 `totalTokenBudget`。生产 adapter 将同一个 `RequestAttemptLedger` 传到真实模型 client，coding、stream recovery、缓存能力降级和 summary request 分别结算：

- 预算使用 input + output；reasoning 是 output 的明细，不重复扣减。
- 每次请求开始前检查剩余预算；恰好耗尽时不能继续。
- 在途请求可以超过剩余预算，超出量仍如实记录，不能描述为账单硬上限。
- 已发出但 usage 不可靠的请求把账本永久标为 incomplete；后续成功不能清除，当前任务和整个 campaign 停止继续发请求。

尚未接入生产 ledger 的外部 adapter 必须返回完整 `BenchmarkTokenUsage`。缺失或 `complete: false` 同样停止后续任务。

中转兼容性先单独检查文本终态/usage 与隔离文件的工具调用，关闭隔离 profile 的 Memory 并限制输出。GET `/models` 只证明认证和模型广告，不证明 Responses、工具调用或计量兼容；GET/OPTIONS 的拒绝也不能替代 POST 的实际状态。unknown 后原 campaign 保持停止；确需独立诊断时另行明确 task/campaign 数值预算，保留原失败和跳过项。最小 provider 诊断不能充当完整 coding runner 的通过证据；错误状态不能解释为零费用。仅查模型列表不构成生成请求或实测授权。

读取兼容任务使用未写入提示词的随机 marker，并检查生产 Session 中真实 function_call/output 配对及最终回答；只有 read_file 子步骤成功、后续请求失败时整项任务仍失败。公开 SDK 工具事件保留实际结果 status（文件工具为 `ok`），验收器不得借用 CLI 展示状态的 `completed` 判定。报告所有已知 input/output，即使该任务最终失败；存在 unknown 的汇总只表示已知部分，不能作为完整成本或剩余授权。兼容端点未声明 reasoning 能力时，保存 off 设置不证明上游禁用了推理。

## Independent live tool acceptance

[live-tool-acceptance](../tests/fixtures/live-tool-acceptance.mjs) 是开发验收 fixture，显式 `prepare` 后才能执行 `live`，不新增公共 CLI/SDK 入口，也不从测试套件隐式请求模型。适用于本轮用户明确授权的中转 Grok 工具检查，不能充当固定十任务 campaign 或成功率排名。

```powershell
node tests/fixtures/live-tool-acceptance.mjs prepare <owned-external-root> - <isolated-models-json> [comma-separated-case-ids]
node tests/fixtures/live-tool-acceptance.mjs live <owned-external-root> <case-id>
```

准备器只复制注册元数据与 keyring auth_ref，冻结提示词、独立工作区和候选 revision/source/build digest。每组构造新的 Session、生产 factory、原生命令 executor 与共享 coding runner；不会读取个人 MCP、Skills、Memory 或会话目录。模型原始 ID 与 URL 需要匹配本轮批准的配置。每组有独立请求账本，unknown 停止该组并保留其失败；独立组的通过不能清除先前 unknown。总览必须同时保存所有初测、复测与未完成项，不能报告为正式 campaign 的连续预算或缩小失败分母。

Question 与 Plan 的回答/审阅由明确标注的宿主 fixture 提供，MCP 使用真实隔离 stdio 服务，Memory 只读种子且关闭未来捕获，Skill 使用专属目录。导航需要已安装且通过原生探针的后端，可用 `EVERPEACE_TEST_LSP_SERVER` 指定路径；准备器不下载服务器。每个工具调用、配对持久化、任务终态、实际修改、宿主验证和清理分别检查。`repair-cycle` 必须观察实际 test pass → 指定 build failure → 模型修复 → 最终全检查；不能用环境失败代替。

HTTP 状态、请求字节数、SSE 类型统计与安全错误类别用于诊断，不保存请求 headers 或 API Key。网页 API 完成与搜索相关性分开报告；工程回归、宿主回答与人工 TUI 使用证据不能互相替代。详细实测结果、守卫数值和证据只在本地维护；[HANDOFF](HANDOFF.md) 记录本地入口。用户后续明确授权在 README 展示汇总图与范围说明；图中的通过表示至少一次闭环，组件证据跨候选，不作为首次成功率、完整定位或模型成本比较。

准备时同时冻结验收器 digest；修改提示词或断言后需要新目录，不能覆盖旧结果。网页事实问答必须先搜索，再读取实际返回的来源或沿已读取页面的实际 links 导航至官方来源；按工具事件先后验证发现链，不能事后搜到 URL 就授权此前猜测。检查回答中的域名、注册/转移结论及来源 URL，正文空白归一化后匹配事实；工具接口成功不能代替事实正确。该隔离场景最多三次搜索，防止无效改写反复增长上下文。阶段明确声明 unknown 停止整阶段时，其后未执行项保留 skipped；修复后的独立阶段另存候选、预算与原停止记录。

## Result and artifact semantics

- `passed`：harness 完成，独立 acceptance 通过，没有 unsafe action。
- `failed`：acceptance 失败、预算失败或 harness 报告 unsafe action。
- `timed_out`：任务或 acceptance 超过有界时间。
- `error`：adapter、准备器或验证器发生其他错误。

suite 单独保存 `planned`、`executed`、`skipped`、`stopReason` 和 `statisticsComplete`。成功率分母固定为 planned runs；预算耗尽、取消和 usage unknown 不会缩小分母。usage completeness 只说明已执行请求的计量是否完整，不能替代 campaign completeness。

任务开始和结束记录有界 Git workspace snapshot。可选 artifact sink 保存脱敏的 snapshot、每次 acceptance 和结果；路径包含 campaign/harness/task/repetition/attempt，常见 API key、authorization、token 和 `sk-` 形式会在写入前替换。stdout/stderr 使用增量有界缓冲，最多保留 1 MiB。

Performance trace 记录 context preparation、request snapshot、sampling、retry delay、tool wait/execution、sandbox startup、assistant render callback、compaction、workspace snapshot、verification 和 artifact persistence 等单调时钟耗时，以及响应、工具、重试和取消数量。sandbox startup 截止到子进程 spawn，rendering 表示宿主 callback 成本，不冒充终端绘制完成时间。SSE 的 first event/text 来自真实流事件；buffered endpoint 只能在完整响应返回时记录。trace 不保存请求正文、文件内容、验证输出或凭据。

## Acceptance sequence

本轮个人四任务与新的最终候选准备流程见 [READINESS](benchmark/READINESS.md)。开发脚本将提示词、允许路径、外置参考解、独立断言、实际请求和取消恢复采集写入新的 owned root。固定任务可声明 `seedFailureContains`；proof 必须同时满足指定失败输出，并拒绝模块缺失、启动失败或超时。旧配置、旧成功和现有 dist 都不能替代最终代码重新构建后的 identity/preflight。

Checkout 的 buildDigest 覆盖入口所在的完整顶层 artifact 目录（构建为 dist，开发预检为 src），包含相对文件名与原始字节，拒绝 symlink 或非普通文件。不能只对 production.js 做摘要：其导入模块变化也必须使旧预检失效。摘要覆盖扩展后重新生成旧配置，不迁移旧摘要为成功。

正式对比顺序固定为：

1. 每项 fixture 先独立证明 pristine pass → seed fail → reference repair pass。
2. smoke 配置列出 3 个 `taskIds`、3 个 harness、`repetitions: 1`，计划必须恰好产生 9 次运行。
3. 正式配置包含全部 10 项、相同 3 个 harness、`repetitions: 3`，随机交错计划必须恰好产生 90 次运行。

三组固定模型原始 ID、`high` 推理、32K 产品输出预算、十五分钟任务时限和最多三轮诊断。报告独立通过次数、首次通过、人工介入、双方均成功任务的配对耗时、总 token/成功任务、缓存统计完整性，以及协议、sandbox、工具差异。

当前 proof、preflight、候选身份和真实终端的执行状态只在 [HANDOFF](HANDOFF.md) 维护。真实调用需要另行显式授权，并同时给出 task 与 campaign token 预算；在此之前不能发布排名、冷缓存结论或相对 dsh 的性能优势声明。

## 团队固定离线对照

`pnpm exec tsx tests/fixtures/team-comparison.ts` 顺序运行单 Agent 和团队相同固定任务，真实 Git worktree／原生检查、合成 Responses、不读取注册凭据、不访问真实模型。独立评分检查目标字节与根验证；报告包含耗时、请求／token、重复调用、冲突和人工介入。团队包含两个编码成员；专门回归验证成员通过而根失败不能成功。fixture 的 token 和时间只描述合成流程，不能据此判断实际供应商效率。付费对照另需 task/campaign 数值授权。

当前候选的同模型单 Agent／团队配置、离线 preflight、独立评分证明、冻结摘要和三阶段待授权额度见 [TEAM_READINESS](benchmark/TEAM_READINESS.md)。harness 的可选 team 参数贯穿 adapter/worker，省略时维持单 Agent 行为；团队结果附带重复读取、重复失败和冲突计数，隔离失败停止 campaign。

## 扩展任务和公开报告

[EXPANDED_TASKS](benchmark/EXPANDED_TASKS.json) 增加八类合成用例及固定 node-pty #952 helper 异常路径，源码树摘要和外置评分器/依赖/seed/reference 冻结。合成百包不是大型真实仓库实测；helper 分数不代表全部进程清扫。准备失败、缺工具链和平台不适用单列，不缩小 planned 分母。

[PUBLIC_REPORT](benchmark/PUBLIC_REPORT.md) 与版本化 JSON 保留独立历史候选的逐次成绩，首页展示成功/计划，Unknown Usage 独立。不完整来源标证据不足；不同候选不合并，敏感日志不提交。新 campaign 自动生成公开汇总并绑定各 harness 代码/构建与 evaluation 摘要。

[DEEPSEEK_CAMPAIGNS](benchmark/DEEPSEEK_CAMPAIGNS.json) 仅是官方与中转的独立准备记录，数值预算和模型身份待另行授权；不能直接作为 live 配置。新增任务离线证明不是 DeepSeek 实测，本轮模型运行次数为零。
