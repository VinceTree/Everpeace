# 开发、验证与交付

用途：准备开发环境、选择测试入口、解释 CI 边界和完成交付。先读根目录 [AGENTS.md](../AGENTS.md) 与 [HANDOFF.md](HANDOFF.md)，再按本次任务定位源码；不需要每次重新扫描整个项目。当前展示版本、提交、测试计数和最近执行证据只在 HANDOFF 维护。

## 工具链与安装

- Node.js 22+，使用仓库指定的 `pnpm@10.22.0`；版本要求和脚本以 [package.json](../package.json) 为准。
- TypeScript + ESM，采用 NodeNext 模块解析。源码内本地导入保留 `.js` 扩展；配置见 [tsconfig.json](../tsconfig.json) 和 [tsconfig.build.json](../tsconfig.build.json)。
- `tsx` 运行开发入口与 Node test runner；`tsc` 输出到 `dist/`，构建会先清理该生成目录。
- Git 用于工作区跟踪，ripgrep 用于模型 search/glob；Windows 使用系统 PowerShell，macOS/Linux 模型 shell 使用 Bash。
- 只运行离线测试、类型检查和构建不需要模型凭据。交互登录通过系统 keyring 保存 Key；不要把凭据加入文件、命令记录或测试快照。

在全新 checkout 中安装和启动：

```powershell
node --version
pnpm --version
rg --version
git --version
pnpm install --frozen-lockfile
pnpm dev
```

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
| `pnpm typecheck` | 检查项目 TypeScript 类型 |
| `pnpm test` | 执行全部测试，文件并发度固定为 4 |
| `pnpm build` | 清理并重新生成构建产物 |
| `pnpm start` | 运行已经构建的 CLI |
| `git diff --check` | 检查 tracked 差异的空白问题 |

本仓库没有独立 `lint` script，不要为完成检查臆造该命令。Agent 对目标项目运行的最终 suite 与本仓库门禁不同：它发现目标当前 manifest 的实际脚本，并按 `typecheck → lint → test → build` 顺序全部执行。

开发期间先运行与变化相关的测试，再执行交付门禁。定向测试直接使用相同的 tsx/Node runner：

```powershell
pnpm exec tsx --test tests/unit/workflow/task-runner.test.ts
pnpm exec tsx --test tests/unit/storage/session-store.test.ts tests/unit/tui/app.test.tsx
pnpm exec tsx --test --test-name-pattern="cancel" tests/unit/agent/react-agent.test.ts
```

| 修改范围 | 首选测试入口 |
| --- | --- |
| 采样、工具调度、取消、上下文 | [agent tests](../tests/unit/agent/) |
| 完成判据、修复、验证、变更跟踪 | [workflow tests](../tests/unit/workflow/) |
| Responses 能力与请求参数 | [provider tests](../tests/unit/providers/) |
| 文件保护、后台命令、搜索、LSP | [tool tests](../tests/unit/tools/) |
| Session schema 与恢复 | [session-store.test.ts](../tests/unit/storage/session-store.test.ts)、[app.test.tsx](../tests/unit/tui/app.test.tsx) |
| 终端布局、输入、slash 窗口 | [TUI tests](../tests/unit/tui/) |
| Memory、Skills、MCP | [memory](../tests/unit/memory/)、[skills](../tests/unit/skills/)、[mcp](../tests/unit/mcp/) |
| 评测预算、fixture、独立评分 | [benchmark tests](../tests/unit/benchmark/) |

## 独立测试 CI 与证据范围

[Test workflow](../.github/workflows/test.yml) 在 pull request 和 main push 上分别运行 Windows/Linux 的 Node 22 门禁：安装 pnpm 与 ripgrep、冻结安装依赖、类型检查、完整测试、构建、差异检查。它独立于 Release workflow，不能为避免发布而跳过测试 CI。

[sandbox-boundaries.test.ts](../tests/unit/tools/sandbox-boundaries.test.ts) 的真实 Windows native sandbox 测试在非 Windows 跳过；在 Windows 且 `GITHUB_ACTIONS=true` 时也明确跳过，因为 hosted runner 无法初始化所需嵌套 sandbox。策略、审批与启动失败关闭仍有单测；跳过结果不能当作真实隔离验收通过。

完整测试、定向测试、平台跳过、基础设施失败和手工验收分别报告。单测目录也包含部分真实进程集成测试，不能仅凭目录名把全部检查描述为纯模拟。

## 离线评测与真实请求

完整操作和结果语义见 [BENCHMARKING.md](BENCHMARKING.md)，配置从 [campaign 示例](benchmark/CAMPAIGN_CONFIG.example.json) 开始。内部开发入口为：

```powershell
pnpm benchmark:campaign -- --config .\campaign.json --prove-fixtures
```

`--prove-fixtures` 不请求付费模型，但会克隆固定源码、下载并安装锁定依赖，所以“离线 proof”不等于完全断网。必须证明 pristine pass → 指定 seed assertion fail → reference repair pass；超时、缺依赖和进程启动失败不能作为 seed 有效的证据。

`--live` 是另一条显式入口，需用户另行授权付费调用，并提供模型原始 ID、数值 task/campaign token 预算。日常开发任务和本文都不授权 live 调用；`/doctor --live` 同样会请求模型，默认 `/doctor` 只做本地诊断。

真实比较先做九次 smoke，再做九十次正式比较；三组保持相同任务、模型、推理档位和预算，使用随机交错顺序。固定 dsh checkout 必须预先安装并构建，配置校验不能替代实际 profile 启动证据。预算用尽或 usage unknown 后停止后续请求，保留 skipped/unknown 和超出预算的实际量。

手工外部验收需记录操作系统、终端、端点、模型设置和结果：Windows Terminal 中完成“修改 → test 通过但 build 失败 → 修复 → 全 suite 通过”，另测 Ctrl+C、后台进程树收束和 Session 恢复。涉及 TUI 时还检查 resize、scrollback、单 prompt、slash 窗口 Esc 重放与直接 `!` 输出。没有执行就记录未验收，不据单测声称性能领先。

## 交付检查与知识维护

1. 开始时执行 `git status --short --branch` 与 `git diff`，记录用户已有 tracked/untracked 差异。
2. 按任务文档定位最小源码、测试和接口范围；实现依赖的当前代码仍须阅读，文档不能替代真实写入前检查。
3. 行为、接口或持久化变化同步补相关回归；纯文档变化检查链接、示例和事实即可，不写镜像实现的测试。
4. 默认执行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`。无法完成的命令注明原因与未验证范围。
5. 全仓 diff 因用户原有差异失败时单独报告；再对本次文件做 scoped 检查，不修改用户文件来制造全绿。新建未跟踪文档须另行检查，普通 `git diff --check` 不覆盖它们。
6. 更新对应专题文档，并检查 [PLAN.md](PLAN.md)、[DECISIONS.md](architecture/DECISIONS.md)、[HANDOFF.md](HANDOFF.md)；命令、输出或安装行为变化时同步两份 README。
7. HANDOFF 保存最新状态、实测证据、已知限制和下一步；专题保存稳定契约；根 AGENTS 保存通用约束与阅读路径。旧记录不得覆盖当前事实。

文档只记录必要的脱敏知识，不复制凭据、私有模型请求正文、完整文件内容或测试输出。文档与代码冲突时以当前实现和实测为准，并修正文档；不要让后续 Agent 再次重复已经完成的调查。

## 提交、推送与发布边界

只有用户明确要求才提交、推送、更新展示版本、打 tag 或创建 Release。提交标题按实际变化命名，禁止产品名及 `release`、`version`、“发布”、“版本”等措辞。

用户要求提交推送但禁止 Release 时，使用 `[skip publish]` 提交标记，并核对 [Release workflow](../.github/workflows/release.yml) 的实际结果；不要使用会跳过测试的 `[skip ci]`。该标记只阻止分支 push 的发布 job，tag push 仍可触发发布，所以禁止 Release 的交付也不能推送 tag。

展示版本调整若被授权，应同步 package.json 与中英文 README。正常发布另需确认 tag 和 GitHub Release 实际成功；只看到 Git push 成功不足以证明发布完成。以上操作规则不构成本次开发任务的提交或付费授权。
