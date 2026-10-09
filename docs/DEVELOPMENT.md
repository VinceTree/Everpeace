# 开发、验证与交付

用途：准备开发环境、选择测试入口、解释 CI 边界和完成交付。先读根目录 [AGENTS.md](../AGENTS.md) 与 [HANDOFF.md](HANDOFF.md)，再按本次任务定位源码；不需要每次重新扫描整个项目。当前展示版本、提交、测试计数和最近执行证据只在 HANDOFF 维护。

## 工具链与安装

- Node.js 22+，使用仓库指定的 `pnpm@10.22.0`；版本要求和脚本以 [package.json](../package.json) 为准。
- TypeScript + ESM，采用 NodeNext 模块解析。源码内本地导入保留 `.js` 扩展；配置见 [tsconfig.json](../tsconfig.json) 和 [tsconfig.build.json](../tsconfig.build.json)。
- `tsx` 运行开发入口与 Node test runner；`tsc` 输出到 `dist/`，构建会先清理该生成目录。
- Git 用于工作区跟踪；模型 search/glob、Composer `@` 候选和 doctor 使用固定的 `@vscode/ripgrep@1.18.0` 平台 optional dependency，并通过绝对路径运行。Windows 使用系统 PowerShell，macOS/Linux 模型 shell 使用 Bash。
- 只运行离线测试、类型检查和构建不需要模型凭据。交互登录通过系统 keyring 保存 Key；不要把凭据加入文件、命令记录或测试快照。

在全新 checkout 中安装和启动：

```powershell
node --version
pnpm --version
git --version
pnpm install --frozen-lockfile
pnpm dev
```

不要以 `--no-optional` 安装：随包 ripgrep 当前覆盖 Windows x64/arm64/ia32、macOS x64/arm64，以及 Linux x64/arm64/arm/ia32/ppc64/riscv64/s390x。其他系统/架构或缺少匹配 optional package 时，搜索、`@` 候选和 doctor 会明确报告 unavailable；程序不会回退到系统 `PATH` 中的 `rg`。所有应用内调用继续传 `--no-config`，用户 `RIPGREP_CONFIG_PATH` 不会改变行为。

已有工作区先检查差异，不要为了安装成功删除用户目录、重置 lockfile 或重新生成无关依赖。确需修改依赖时，同步审查 manifest、lockfile 和相关补丁。

### Windows、WSL 与原生依赖

同一 checkout 的 `node_modules` 必须与运行它的 Node 平台一致。Windows 安装的 esbuild、TypeScript 平台二进制、keyring 和 node-pty 不能直接交给 WSL Linux Node；反向亦然。需要双平台开发时使用各自 checkout 和安装目录。

从 WSL 操作已经使用 Windows Node 安装依赖的仓库，可以显式调用 Windows 工具链：

```bash
cmd.exe /d /s /c "pnpm typecheck"
cmd.exe /d /s /c "pnpm test"
cmd.exe /d /s /c "pnpm build"
```

Windows TUI 手工验收仍需真实 Windows Terminal。通过 WSL 调用 Node 或执行单测不能证明终端按键、滚动和重放正确。

[pnpm-workspace.yaml](../pnpm-workspace.yaml) 指定 [node-pty 补丁](../patches/node-pty@1.1.0.patch)，修复 Windows 控制台取消竞态及 socket/worker 清理；pnpm 安装构建准入只允许 `node-pty`。不要删除补丁或放开全部依赖安装脚本来规避安装问题。使用仓库与 pnpm 安装才能应用这些补丁；作为其他项目的 npm 依赖安装不会自动继承它们。

## 开发与检查命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 用 tsx 启动开发 CLI/TUI |
| `pnpm dev -- exec <prompt> ...` | 用 tsx 运行公开非交互 CLI 路径 |
| `pnpm typecheck` | 严格检查全部源码与测试 `.ts` / `.tsx` |
| `pnpm test` | 执行全部测试，文件并发度固定为 4 |
| `pnpm build` | 清理并重新生成构建产物 |
| `pnpm start` | 运行已经构建的 CLI |
| `git diff --check` | 检查 tracked 差异的空白问题 |

本仓库没有独立 `lint` script，不要为完成检查臆造该命令。Agent 对目标项目运行的最终 suite 与本仓库门禁不同：它发现目标当前 manifest 的实际脚本，并按 `typecheck → lint → test → build` 顺序全部执行。

[类型配置](../tsconfig.json) 显式包含 `src` 和 `tests` 下所有 `.ts`、`.tsx`，保留严格选项和 ES2022 target；[构建配置](../tsconfig.build.json) 显式包含源码 TSX，继续排除测试。测试替身按真实接口返回结果、处理可选参数和收窄联合类型；不得通过扩大生产接口、`any`、忽略错误或移除断言规避检查。辅助写法必须与当前编译库兼容。

[依赖边界回归](../tests/unit/architecture/dependency-boundaries.test.ts) 使用已有 TypeScript 的异步解析 API 扫描 runtime、Agent、workflow、exec、SDK 的源码，禁止普通／类型导入、重导出和字面量动态导入 React、Ink、`@inkjs/ui` 或 TUI。TUI、CLI 适配入口允许 UI 依赖。虚拟文件案例验证语法覆盖与允许边界；解析快照和本地编译器子进程在结束时清理，不增加依赖或独立 lint 工具。TypeScript 的 `unstable` API 是当前已安装编译器的接口，升级编译器时须复核这项回归。

开发期间先运行与变化相关的测试，再执行交付门禁。定向测试直接使用相同的 tsx/Node runner：

```powershell
pnpm exec tsx --test tests/unit/workflow/task-runner.test.ts
pnpm exec tsx --test tests/unit/storage/session-store.test.ts tests/unit/tui/app.test.tsx
pnpm exec tsx --test --test-name-pattern="cancel" tests/unit/agent/react-agent.test.ts
```

| 修改范围 | 首选测试入口 |
| --- | --- |
| 分层依赖、类型配置 | [dependency-boundaries.test.ts](../tests/unit/architecture/dependency-boundaries.test.ts)；用 `tsc --listFilesOnly` 对照 tracked `.ts` / `.tsx` 清单 |
| 模型任务准入、取消、会话身份与批准 | [application-coordinator.test.ts](../tests/unit/runtime/application-coordinator.test.ts)、[app.test.tsx](../tests/unit/tui/app.test.tsx)、[生产 Plan 闭环](../tests/unit/runtime/plan-execution.test.tsx) |
| 采样、工具调度、取消、上下文 | [agent tests](../tests/unit/agent/) |
| step 工具定义、准入、binding 与并发资格 | [step-tool-catalog.test.ts](../tests/unit/agent/step-tool-catalog.test.ts)、[loop-boundaries.test.ts](../tests/unit/agent/loop-boundaries.test.ts)、[react-agent.test.ts](../tests/unit/agent/react-agent.test.ts)；同时覆盖 Plan、重试和权限边界 |
| 完成判据、修复、验证、变更跟踪 | [workflow tests](../tests/unit/workflow/) |
| Responses 能力与请求参数 | [provider tests](../tests/unit/providers/) |
| 文件保护、后台命令、搜索、LSP | [tool tests](../tests/unit/tools/) |
| 后台任务准入、清理与终态 | [background-jobs.test.ts](../tests/unit/tools/background-jobs.test.ts)、[Agent](../tests/unit/agent/react-agent.test.ts)、[runner](../tests/unit/workflow/task-runner.test.ts)；受控 worker 验证同步失败、重入、预取消、重复清理与迟到输出，真实进程和终端证据单独记录 |
| Session schema、搜索快照与恢复 | [session-store.test.ts](../tests/unit/storage/session-store.test.ts)、[session-picker.test.tsx](../tests/unit/tui/session-picker.test.tsx)、[app.test.tsx](../tests/unit/tui/app.test.tsx)；返回引用隔离、fork 债务与 usage unknown，以及 warm hit 的实际日志读取成本 |
| 历史、附件、分支与裁剪 | [session-history.test.ts](../tests/unit/storage/session-history.test.ts)、[session-outputs.test.ts](../tests/unit/storage/session-outputs.test.ts)、[react-agent.test.ts](../tests/unit/agent/react-agent.test.ts) |
| `everpeace exec` 参数、JSONL 与生产运行 | [CLI tests](../tests/unit/cli/)、[exec tests](../tests/unit/exec/)、[runtime factory tests](../tests/unit/runtime/) |
| 公开 SDK 非交互契约 | [SDK tests](../tests/unit/exec/sdk.test.ts) |
| 终端布局、输入、slash 窗口 | [TUI tests](../tests/unit/tui/) |
| Composer 提交与草稿归属 | [prompt-submission.test.tsx](../tests/unit/tui/prompt-submission.test.tsx)、[prompt-history.test.tsx](../tests/unit/tui/prompt-history.test.tsx)、[App](../tests/unit/tui/app.test.tsx)；连续 Enter、粘贴、回调重入、旧挂载／草稿回调、失败重交，以及真实附件提交后的 guidance／resize／Esc 重放 |
| Memory、Skills、MCP | [memory](../tests/unit/memory/)、[skills](../tests/unit/skills/)、[mcp](../tests/unit/mcp/) |
| 评测预算、fixture、独立评分 | [benchmark tests](../tests/unit/benchmark/) |

## 独立测试 CI 与证据范围

[Test workflow](../.github/workflows/test.yml) 在 pull request 和 main push 上分别运行 Windows/Linux 的 Node 22 门禁：安装 pnpm、通过冻结 lockfile 安装平台 ripgrep optional package、类型检查、完整测试、构建、差异检查。job 最多 20 分钟，测试 step 最多 10 分钟，进程或管道清理回归不能无限挂起 runner。CI 不再显式安装系统 `rg`，应用始终通过包内绝对路径运行平台二进制；缺少匹配 optional package 的行为由 resolver fixture 单独覆盖。它独立于 Release workflow，不能为避免发布而跳过测试 CI。

[sandbox-boundaries.test.ts](../tests/unit/tools/sandbox-boundaries.test.ts) 的真实 Windows native sandbox 测试在非 Windows 跳过；在 Windows 且 `GITHUB_ACTIONS=true` 时也明确跳过，因为 hosted runner 无法初始化所需嵌套 sandbox。策略、审批与启动失败关闭仍有单测；跳过结果不能当作真实隔离验收通过。

完整测试入口同时覆盖 [MCP 协议 fixture](../tests/unit/mcp/protocol.test.ts)、[stdio 恢复 fixture](../tests/unit/mcp/stdio-recovery.test.ts) 与 [exec 子进程 fixture](../tests/unit/cli/exec-process.test.ts)：MCP 测试实际启动 SDK stdio server 和本地 Streamable HTTP endpoint，并检查中断调用不重放、初始化失败的旧进程退出后才重连；exec 测试使用 fake provider 与真实 stdout/stderr 管道检验慢读、关闭、停滞和清理。这些测试在 Windows/Linux 都运行，不需要 keyring、模型网络调用或额外服务。Linux 使用真实 OS 信号；Windows fixture 通过 IPC 触发已注册的 SIGINT/SIGTERM handler，不能代替真实 Windows Terminal 的 Ctrl+C 验收。现有测试 glob 已纳入这些文件，无需再并行重复整套门禁。

完整测试、定向测试、平台跳过、基础设施失败和手工验收分别报告。单测目录也包含部分真实进程集成测试，不能仅凭目录名把全部检查描述为纯模拟。

真实 stdio 恢复 fixture 的启动期限涵盖 Node／tsx／SDK 冷启动，测试使用 10 秒连接期限、20 秒恢复观察期限及 45 秒整体上限。首代在 timeout 场景明确不回应初始化；仍要求恰好两代、旧进程先退出、旧 binding 被拒绝和调用不重放。不要把冷启动误超时引入的第三代当作预期结果；生产 timeout 与重连策略未因此改变。

## 离线 Windows Terminal 手工验收

[开发专用 TUI fixture](../tests/fixtures/tui-offline.ts) 使用 fake provider，复用生产 Agent、TaskRunner、Session 恢复和分支。不读取用户 keyring/config；默认关闭扩展，加 `--integrations` 时只加载 root 内 Memory、显式根 Skill catalog、固定 stdio MCP 与 native sandbox 中的协议 fixture LSP。先在真实 Windows Terminal 的 PowerShell 中，从仓库运行：

```powershell
pnpm exec tsx tests/fixtures/tui-offline.ts --root "$env:TEMP\everpeace-tui-offline-new" --integrations
```

`--root` 必须是绝对路径，并指向空目录或本 fixture 已标记的目录；workspace、sessions 和 input-history 都写入该目录。`--help` 不初始化目录。首次启动播种 `Offline debt seed`，按以下顺序保留同一 root 检查：

1. `/resume` 选择 seed，使用 `/status` 检查待验证债务，再执行 `/fork offline-child`。
2. 退出后以相同 root 重启，`/resume` 选择子会话。使用 `/plan` 检查 Plan 并取消审批，确认分支待继续状态没有被消耗。
3. coding 输入 `wait`，按 Ctrl+C 取消，再次 coding，检查原有验证债务仍保留。`wait` 会等待最多 60 秒并响应取消，普通输入立即返回离线响应。
4. 输入 `large` 产生 300 行中文、emoji 和缩进内容，检查 resize、scrollback 和单 prompt；另检查直接 `!` 输出。
5. 输入 `cycle`：读取和修改 fixture.txt，test 通过但 build 的指定断言失败；修复后重新发现并执行 typecheck、test、build。当前没有 lint。再次启动使用新 root，避免复用旧 fixture manifest。
6. 输入 `integrations`：读取隔离 Skill、审批 MCP ping、执行 native hover；`/memory` 应显示 root 内种子条目。四者没有加载、返回 error 或只看到了目录不能记为调用通过。协议 fixture 不替代真实 TypeScript server 验收。

Windows 检查发现使用 pnpm/npm/yarn 的 `.cmd` shim，避免 PowerShell 在原生 sandbox 中选择 `.ps1` 并被脚本授权拒绝；bun 保留原生可执行文件。检查顺序、失败停止、审批与 sandbox 不变。

[窗口控制辅助](../tests/fixtures/windows-terminal-control.ps1) 仅允许 ownership marker、WindowsTerminal PID、固定离线窗口标题与实际前台焦点全部匹配后发送输入，并只截取该窗口。若执行环境无法取得焦点，保持真实按键 pending；ConPTY 注入不能冒充 Windows Terminal 的滚轮、缩放或视觉验收。实际终端版本、操作、失败与截图路径在外置收据中记录，不写个人凭据。

Plan 专项验收另检查：在审阅选择 `Revise plan` 输入意见，resize 后意见仍保留；Esc 返回菜单，菜单 Esc／两处 Ctrl+C 恢复聊天且仅一个 prompt。重新规划并批准后应保持空闲，`/plan show` 可查看正文，`/plan execute` 才启动 coding；取消执行后不能再次消费旧批准。重启、fork 或继续讨论后必须重新批准。自动化生产闭环见 [Plan execution](../tests/unit/runtime/plan-execution.test.tsx)，SDK 通过隔离临时用户目录和本地 fake HTTP provider 验证只读计划输出／问题停止；均不调用真实模型，不代替本节手工验收。

审阅组件回归复用生产 CommandScreen 布局，并等待实际菜单、输入和回调状态后发送下一按键；固定延时不能代替 Ink 的 Esc 缓冲和 React 更新完成。resize 必须确认实际边框宽度已改变，再检查修订正文与提交结果。

命令 loading/info 组件切换时，画面可能先于被替换组件的输入 effect；raw-mode 清理会重置待处理 escape 序列。新增压缩停止回归在一次性输入前用 React act/rerender 完成 committed effects，并观察实际草稿已接收后才 Enter；临时 act 环境标记必须在 finally 恢复。分别检查 usage/budget 文案、单次压缩调用和 Esc 返回原 Session，不以加长固定延时或删掉返回断言规避竞态。

Composer 另检查带有效文件引用的提交：连续按 Enter 只启动一次，进入运行中 guidance 后新草稿能正常编辑，resize 和任务结束不清空它；无效引用保留草稿，纠正后显式重交。再打开命令窗口并按 Esc，确认同一 Session 历史及单 prompt。受控 Promise 与 Ink 输入回归只证明本地生命周期，真实 Windows Terminal 的按键、滚轮与缩放仍须按本节单独记录。

独立 Prompt 回归在等待提交完成／失败后，以测试 stdin 的 readable 订阅恢复确认 Ink 输入 effect 已重新启用，再发送一次性输入；仅看到新画面或经过固定延时不能证明订阅已就绪。待处理阶段先观察订阅停用再结算受控 Promise，重复 Enter／粘贴仍同步连续发送，保留渲染前竞态覆盖。

Memory 的 [空闲生命周期回归](../tests/unit/runtime/memory-idle-lifecycle.test.ts) 只对五分钟及更长的 idle/租约等待使用受控 timer，锁心跳及 Windows 原子 rename 的短 backoff 使用真实 timer。推进 Date 检查最后一毫秒不能冻结持久化重试，否则 Windows sharing violation 会让关闭等待停滞；回归显式注入一次 EBUSY，检查重试成功且空闲时间没有推进。

[Memory 队列重启回归](../tests/unit/memory/learned-memory.test.ts) 在保存两轮内容时显式 beginTask 暂停后台消费，不假定原子写能在短 idle 窗口内完成；重启后同时等待条目与 capture jobs 结算，并在断言失败时释放 runtime。[验证命令超时回归](../tests/unit/benchmark/runner.test.ts) 直接调用验证器，避免独立的任务 deadline 在 Windows taskkill 清理期间到期而改变取消分类；任务取消与任务超时另有独立断言。

App 回归在每项测试结束后统一清理渲染器和捕获的输出帧，即使断言失败也释放。ink-testing-library 会保留渲染器引用，仅 unmount 不会释放捕获帧；所有历史、resize 和隐私断言仍在清理前执行。不通过增大 CI 堆或跳过断言绕过资源问题。

Memory 的 production startup/close 回归在真实 beginTask 持久暂停完成后，受控地扣住该方法返回，再 dispose、释放和检查 rejection/零 progress 写入；不能任意暂停下一次 store.updateJobs，因为 Linux 上它可能是无关的 startup 写入。模拟 Windows 的 sandbox path 回归与宿主平台 launcher 路径检查分开，不能把 win32 canonical 路径交给 Linux path 重叠判断。

exec 流清理的 deadline 回归在真实 iterator 已归任务所有时触发实际 exec deadline callback，避免 Windows Session 冷启动先消耗短 deadline；真实墙钟的启动超时仍有独立回归。Memory 到期测试在最后一毫秒之前继续断言零请求，到期后保持 Date 不动，等待实际存储/请求状态可见，不假定磁盘写入在固定 settle 轮数内完成。

fixture 中验证命令仍通过生产原生 sandbox；失败保持 unverified，不回退宿主执行。直接 `!` 是工作目录固定在 fixture workspace 的正常用户 PTY。自动测试不替代这里的终端体验验收；执行后记录终端版本、步骤和结果，未执行时明确标记 pending。

## 离线评测与真实请求

完整操作和结果语义见 [BENCHMARKING.md](BENCHMARKING.md)，配置从 [campaign 示例](benchmark/CAMPAIGN_CONFIG.example.json) 开始。内部开发入口为：

```powershell
pnpm benchmark:campaign -- --config .\campaign.json --preflight
pnpm benchmark:campaign -- --config .\campaign.json --prove-fixtures
```

`--preflight` 不读取 keyring 或发出真实 provider 请求。它启动命名 checkout 的 fresh worker，并通过合成 provider 响应启动固定 dsh CLI/profile；dsh 在 Windows 上使用 60 秒 cold-start deadline，其他平台为 30 秒，dummy credential、socket guard、请求边界与 checkout digest 结果写入 `preflight-result.json`。这项结果与 scored benchmark 分开；它不替代 fixture proof，也不构成操作系统级断网证明。

`--prove-fixtures` 不请求付费模型，但会克隆固定源码、下载并安装锁定依赖，所以“离线 proof”不等于完全断网。必须证明 pristine pass → 指定 seed assertion fail → reference repair pass；超时、缺依赖和进程启动失败不能作为 seed 有效的证据。

`--live` 是另一条显式入口，需用户另行授权付费调用，并提供模型原始 ID、数值 task/campaign token 预算。日常开发任务和本文都不授权 live 调用；`/doctor --live` 同样会请求模型，默认 `/doctor` 只做本地诊断。

真实比较先做九次 smoke，再做九十次正式比较；三组保持相同任务、模型、推理档位和预算，使用随机交错顺序。固定 dsh checkout 必须预先安装并构建，配置校验不能替代实际 profile 启动证据。预算用尽或 usage unknown 后停止后续请求，保留 skipped/unknown 和超出预算的实际量。

手工外部验收需记录操作系统、终端、端点、模型设置和结果：Windows Terminal 中完成“修改 → test 通过但 build 失败 → 修复 → 全 suite 通过”，另测 Ctrl+C、后台进程树收束和 Session 恢复。涉及 TUI 时还检查 resize、scrollback、单 prompt、slash 窗口 Esc 重放与直接 `!` 输出。没有执行就记录未验收，不据单测声称性能领先。

## 交付检查与知识维护

1. 开始时执行 `git status --short --branch` 与 `git diff`，记录用户已有 tracked/untracked 差异。
2. 按任务文档定位最小源码、测试和接口范围；实现依赖的当前代码仍须阅读，文档不能替代真实写入前检查。
3. 行为、接口或持久化变化同步补相关回归；纯文档变化检查链接、示例和事实即可，不写镜像实现的测试。
4. 按实际存在的 `typecheck → lint → test → build` 串行执行，首败停止；当前执行 `pnpm typecheck`、记录缺少 lint、`pnpm test`、`pnpm build`，然后运行 `git diff --check`。无法完成的命令注明原因与未验证范围。
5. 全仓 diff 因用户原有差异失败时单独报告；再对本次文件做 scoped 检查，不修改用户文件来制造全绿。新建未跟踪文档须另行检查，普通 `git diff --check` 不覆盖它们。
6. 更新对应专题文档，并检查 [PLAN.md](PLAN.md)、[DECISIONS.md](architecture/DECISIONS.md)、[HANDOFF.md](HANDOFF.md)；命令、输出或安装行为变化时同步两份 README。
7. HANDOFF 保存最新状态、实测证据、已知限制和下一步；专题保存稳定契约；根 AGENTS 保存通用约束与阅读路径。旧记录不得覆盖当前事实。

文档只记录必要的脱敏知识，不复制凭据、私有模型请求正文、完整文件内容或测试输出。文档与代码冲突时以当前实现和实测为准，并修正文档；不要让后续 Agent 再次重复已经完成的调查。

## 提交、推送与发布边界

只有用户明确要求才提交、推送、更新展示版本、打 tag 或创建 Release。提交标题按实际变化命名，禁止产品名及 `release`、`version`、“发布”、“版本”等措辞。

用户要求提交推送但禁止 Release 时，使用 `[skip publish]` 提交标记，并核对 [Release workflow](../.github/workflows/release.yml) 的实际结果；不要使用会跳过测试的 `[skip ci]`。该标记只阻止分支 push 的发布 job，tag push 仍可触发发布，所以禁止 Release 的交付也不能推送 tag。

展示版本调整若被授权，应同步 package.json 与中英文 README。正常发布另需确认 tag 和 GitHub Release 实际成功；只看到 Git push 成功不足以证明发布完成。以上操作规则不构成本次开发任务的提交或付费授权。
