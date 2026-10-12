# Everpeace

**候选版本 0.6.0-rc.1。** Windows 源码检查已验证；Linux 与跨平台原生安装包待验证。修复及团队模型对照证据不足，不调整默认策略。[候选证据与使用说明](docs/implementation/REPORT.md)。

**在终端中规划、修改并验证你的 Node.js / TypeScript 项目。**

[English](README.md) · [使用指南](docs/USAGE.zh-CN.md) · [实测展示](#真实调用验证改动) · [开发文档](docs/README.md)

[![Test](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml/badge.svg)](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Everpeace 是 DeepSeek 优先、Windows 优先的个人 Node.js / TypeScript 开发 CLI。默认由单个 Agent 读取项目规则、搜索代码、提出计划、修改文件，再运行项目声明的检查。你可以在 inline 终端中交互，通过 `everpeace exec` 自动执行任务，或从 TypeScript 调用同一 runner。

先审阅计划和改动，再由宿主检查结果：重新发现 `typecheck → lint → test → build`，按顺序执行存在的检查，首败停止，最多进行三轮修复。缺少检查、证据过期、取消和用量不完整都会明确保留。

## 开始使用

准备 **Node.js 22+**、Git 和 **pnpm 10.22.0**。从仓库安装以应用 Windows `node-pty` 补丁；保留 optional dependencies，以使用随包代码搜索。

```powershell
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm dev
```

启动后输入 `/login`，选择 DeepSeek，输入遮罩显示的 API Key，再选择服务返回的原始模型 ID。也支持 OpenAI 和自定义 HTTPS Responses 端点，能力按实际端点识别。密钥保存在系统凭据库，不写入项目或 Session。

模型连接支持 `HTTP_PROXY`、`HTTPS_PROXY` 与 `NO_PROXY`，同名小写变量优先。端点需要代理时，在启动 CLI 前设置；仅设置 `ALL_PROXY` 不生效。这些设置作用于模型请求，模型 shell 仍遵守 sandbox 网络策略。

中转明确支持 DeepSeek Responses 契约时，可设置 `/model profile deepseek`，再设置 `/reasoning high`。`/status` 显示协议配置、能力来源和实际发送的推理值。这属于用户配置，不能证明中转兼容；未知端点默认采用保守设置，`/model profile auto` 恢复按地址识别。完整推理项在工具轮次之间保留。实验性的提示与工具反馈优化默认关闭，须先通过任务质量与实际 token 用量对比。

网页读取保留有界的来源链接列表，搜索结果宽泛时，Agent 可以沿官方网站的实际导航继续读取并核验引用。

```text
/login
/plan
解释请求预算的执行路径，并提出一个聚焦的回归修复计划。
```

审阅或修订计划，批准后显式开始执行。`/diff` 审阅改动，`/status` 查看请求设置和用量，`/resume` 恢复 Session。`/doctor` 进行本地诊断；`/doctor --live` 先预览有界探测，显式开始后可能产生费用。宿主 TUI 界面使用英文。

使用构建后的 CLI：

```powershell
pnpm build
pnpm link --global
everpeace
```

当前源码版本：**0.5.3**。

## 真实调用，验证改动

| 独立历史计划 | 成功／计划 | 失败 | 超时／错误／取消／跳过 | Unknown Usage |
| --- | --- | --- | --- | --- |
| 初始工具验收 | 7 / 13 | 6 | 0 / 0 / 0 / 0 | 5 |
| 后续工具验收 | 5 / 7 | 2 | 0 / 0 / 0 / 0 | 2 |
| 独立重试计划 | 1 / 2 | 1 | 0 / 0 / 0 / 0 | 1 |

这些是既有 `grok-4.6` 中转运行。不同源码／构建候选分别展示；缺评测摘要或人工介入记录均标为**证据不足**。另三份计划缺少汇总，结果未知。这不是当前候选或 DeepSeek 的成绩。[逐次证据与缺失记录](docs/benchmark/PUBLIC_REPORT.md)。新增九类任务已有离线评分器证明，本轮真实模型运行次数为零。

根到目标目录的规则、`@` 文件附件和按需项目地图帮助 Agent 理解代码。编辑基于当前文件观察，提供绑定权限的预览和拒绝并发覆盖的 undo。Session、fork 和上下文检查点在恢复时保留工作与验证债务。

配置 MCP 的工具、资源和 prompts，以及本地 Skills，可以扩展 Agent。Learned Memory 保存偏好与经过验证的经验；公共网页访问检查重定向与网络边界。搜索的首选服务不可用时，会依次尝试中国区 Bing 和 DuckDuckGo。配置和完整限制见 [使用指南](docs/USAGE.zh-CN.md)。

MCP stdio 程序需要独立的启动信任：使用 `/mcp trust <server>` 审阅并保存当前工作区及准确配置的授权，`/mcp reconnect` 启动或重载，`/mcp revoke <server>` 撤销并取消访问。批准意味着允许程序以宿主用户权限运行；工具调用审批不提供进程沙箱。远程 MCP 必须使用 HTTPS，本机回环 HTTP 需要单独批准，所有重定向均拒绝。缺少启动批准时，非交互 CLI/SDK 在模型请求前返回 `interaction_required`（退出码 5）。

默认搜索使用 DOM 选择器；`/web` 可明确选择 Brave LLM Context，密钥只保存在系统凭据库，保存不发请求。`/doctor --live` 先预览有界流式、工具、用量与取消诊断，默认 Cancel。`/cost` 显示用户定价的估算、未知／不完整计量和任务预警；请求 Token 预算不是费用上限。[安全与诊断契约](docs/architecture/SECURITY_AND_DIAGNOSTICS.md)。

`/privacy` 展示持久化和保留策略（默认永久），预览清理、扫描凭据并导出诊断摘要；脱敏对话导出需单独审查。`everpeace privacy --help` 提供无模型请求的 CLI。`/perf` 区分墙钟、累计阶段和已知 Token，缺测仍为未知。工作流报告区分项目检查与独立功能验证；项目 Memory 在 90 天后暂停召回，可通过 `/memory` 逐条审查。团队成员支持授权 Git 子目录及已有 linked worktree。[验证、隐私与性能契约](docs/architecture/VALIDATION_PRIVACY_PERFORMANCE.md)。

漏洞请通过 [GitHub 私密报告](https://github.com/VinceTree/Everpeace/security/advisories/new) 提交，支持范围与协调披露见 [SECURITY.md](SECURITY.md)。依赖审计、脱敏秘密扫描、许可证策略及绑定候选的 SBOM 证据是合并和发布必需检查。

## 自动执行同一工作流

```powershell
everpeace exec "修复失败测试并运行项目检查" -C C:\projects\my-app --model deepseek-flash --token-budget 100000 --json
```

`exec` 与终端共用权限、工具、Session 存储、验证和清理，遇到需要用户交互的步骤会停止。`--plan` 只分析，不实施；`--resume <session-id>` 在新 fork 中继续。JSONL 消费者需要同时检查最终事件和进程退出码，包括取消及输出管道故障。

```typescript
import { runTask } from 'everpeace/sdk';

const result = await runTask({
  prompt: '修复失败测试并运行项目检查',
  workspacePath: 'C:/projects/my-app',
  model: 'deepseek-flash',
  tokenBudget: 100_000,
});
console.log(result.classification);
```

SDK 使用已注册凭据，不在任务参数中接收 API Key。[完整选项、事件与退出码](docs/USAGE.zh-CN.md#非交互执行)。

## 可选多 Agent 协作

用 `/team on` 启用协作，再打开 `/team` 配置角色模型、限制或查看成员。主 Agent 可委派调查、编码和审查；默认共三个 Agent，即主 Agent 加两个成员。配置仅空闲时修改。`Ctrl+C` 取消团队并等待清理。

```powershell
everpeace exec "完成两个独立修改并验证项目" --team --max-agents 3 --worker-model <已注册模型ID> --json
```

SDK 在 `runTask` 加入 `team: { maxAgents: 3, models: { worker: '<已注册模型ID>' } }`。角色未配置时继承主模型。编码成员使用以当前工作区字节为起点的隔离 Git worktree，支持未提交修改；整合保护用户并发编辑，最终成功只由根项目完整检查决定。Plan 仅允许只读成员。默认共享限制为 96 次 provider attempts、30 分钟，根任务更严格限制优先。

协作 JSONL 使用 schema v2，普通执行保留 v1。中断、失败或冲突的产物留待 `/team` 显式继续或清理。[完整配置、恢复与限制](docs/USAGE.zh-CN.md#多-agent-协作)。当前工程 fixture 不代表真实模型更快、更省或成功率更高。

## 控制与边界

- 模型 shell 在固定原生 sandbox 中执行，Windows 通过 MXC 运行 PowerShell。sandbox 或 LSP 网络探针失败会阻止启动。可选语言服务器需事先安装并显式配置。
- 文件更新需要当前观察版本；审批和 undo 不覆盖用户后续修改。恢复 Session 保留工作，新的动作仍受当前权限约束。
- `Ctrl+C` 取消活动任务并等待清理；空闲时先清草稿，再退出。用户直接输入的 `!` 命令在独立宿主 PTY 中运行，独占终端输入，不进入模型上下文。
- 请求预算包含重试、压缩与修复。未知用量会阻止有界任务继续请求，推理 token 是输出 token 的组成部分。token 预算不是严格账单上限。
  请求失败且用量未知时保留安全 HTTP 状态和错误类别，不记录供应商错误正文或请求头。

审批按键、终端操作和集成配置见 [使用指南](docs/USAGE.zh-CN.md)。更广泛的编码质量、稳定性和成本仍须通过实测衡量。[开发状态](docs/HANDOFF.md) · [DeepSeek 实测准备](docs/benchmark/READINESS.md)。

## 开发与贡献

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

按上述顺序执行门禁，首败停止，另跑 `git diff --check`。开发从 [AGENTS.md](AGENTS.md) 和 [文档地图](docs/README.md) 开始。可复现问题请提交到 [GitHub Issues](https://github.com/VinceTree/Everpeace/issues)。

采用 [Apache 2.0](LICENSE) 许可证，由 [VinceTree](https://github.com/VinceTree) 维护。

## 网络与源码安装保障

公共网页和远程 Skill 请求将校验过的 DNS 地址绑定到实际连接，包括 HTTP/HTTPS 代理 CONNECT。代理只读取宿主 HTTP_PROXY、HTTPS_PROXY、NO_PROXY，兼容小写变量。代理基础设施属于受信任边界；暂不支持 SOCKS/PAC，失败不回退直连，HTTPS 证书校验始终开启。[网络边界](docs/architecture/NETWORK.md)。

源码安装使用 pnpm 和固定 node-pty 补丁。运行 `pnpm install:verify`，构建后运行 `pnpm install:smoke`；维护者可用 `pnpm install:clean` 核验干净源码安装。生成独立 tarball 使用 `pnpm build`，然后 `pnpm pack:release --output <空目录>`，产物携带修补后的原生依赖及许可证；普通 npm/pnpm pack 会被拒绝。`pnpm install:consumer <安装包目录> --local` 在无模型凭据的隔离目录核验 npm、pnpm 和全局安装。正式可移植候选在 Ubuntu 24.04 x64 构建：打包器在已校验 staging 编译 Linux PTY，同时保留上游 Windows prebuild，不要求 pnpm 执行 bundled 子包脚本。构建机需要 Python、make 和 C++；Windows 本地打包仅用于开发。其他 Linux 系统/架构尚未验收。npm registry 发布仍待完成。

Windows/Linux 有 Node 22 CI。**macOS 为实验性支持**，尚无完整 CI 或原生沙箱验收。Release 必须指定 main 上的准确提交，平台/安装包检查与专用 Windows 原生验收全部通过；缺少 Runner 或必需测试跳过均阻止发布。维护者部署和失败演练见 [Windows Runner 指南](docs/WINDOWS_RUNNER.md)。开发门禁依次为 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`，首败停止，另跑 `git diff --check`。[当前团队实测准备](docs/benchmark/TEAM_READINESS.md)仅使用离线证据，付费测试另需数值授权。
