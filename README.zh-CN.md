# Everpeace

[公开接口契约](docs/COMPATIBILITY.md) · [贡献指南](CONTRIBUTING.zh-CN.md) · [常见问题](docs/FAQ.md) · [安装状态](docs/INSTALLATION.md) · [候选变更](docs/RELEASE_NOTES.md)

宿主显示使用 `--lang auto|en|zh-CN`、`EVERPEACE_LANG` 和 `/language`；`--accessible` 提供追加式 TTY 交互，重定向自动化使用 `exec --json`。[核心体验历史验收快照](docs/core-experience/STATUS.md)。


**候选版本 0.6.0-rc.4。** 加固后的工作区文件后端要求 Windows 与本地 NTFS，其他平台明确报告文件访问不可用。[本轮验收与限制](docs/HANDOFF.md)；真实模型安全评测继续暂停。

**在终端中规划、修改并验证你的 Node.js / TypeScript 项目。**

[English](README.md) · [使用指南](docs/USAGE.zh-CN.md) · [实测展示](#真实调用验证改动) · [开发文档](docs/README.md)

[![Test](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml/badge.svg)](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Everpeace 是 DeepSeek 优先、Windows 优先，面向个人 Node.js / TypeScript 开发的 coding harness，通过终端 CLI、`everpeace exec` 和 TypeScript SDK 使用。它把模型、项目规则、代码工具、隔离命令、持久 Session 和宿主验证接成编码闭环。默认由单个 Agent 搜索代码、提出计划、修改文件，再运行项目声明的检查。

先审阅计划和改动，再由宿主检查结果：重新发现 `typecheck → lint → test → build`，按顺序执行存在的检查，首败停止，最多进行三轮修复。缺少检查、证据过期、取消和用量不完整都会明确保留。

持久 Goal 的完整目标持续进入当前模型上下文，压缩后也会重新提供。完成须经过目标审计，并由宿主对同一个仍活动的目标与编码回合接受验证，运行中追加需求会使旧意图失效；阻塞须以同一原因跨三个连续宿主回合报告，重复工具调用不能充当额外回合。

## 开始使用

准备 **Node.js 22+**、Git、**pnpm 10.30.3** 和 Windows 本地 NTFS 工作区。源码编译还需要 MinGW-w64 g++ 或 Visual Studio C++ Build Tools。保留 optional dependencies，以使用随包代码搜索。

```powershell
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm files:build
pnpm dev
```

启动后输入 `/login`，选择 DeepSeek，输入遮罩显示的 API Key，再选择服务返回的原始模型 ID。也支持 OpenAI 和自定义 HTTPS Responses 端点，能力按实际端点识别。密钥保存在系统凭据库，不写入项目或 Session。

模型连接支持 `HTTP_PROXY`、`HTTPS_PROXY` 与 `NO_PROXY`，同名小写变量优先。端点需要代理时，在启动 CLI 前设置；仅设置 `ALL_PROXY` 不生效。这些设置作用于模型请求，模型 shell 仍遵守 sandbox 网络策略。

Windows 沙箱命令沿用宿主 pnpm 工具链：保留显式 `PNPM_HOME`，未设置时在启动前固定宿主默认位置。

中转明确支持 DeepSeek Responses 契约时，可设置 `/model profile deepseek`，再设置 `/reasoning high`。`/status` 显示协议配置、能力来源和实际发送的推理值。这属于用户配置，不能证明中转兼容；未知端点默认采用保守设置，`/model profile auto` 恢复按地址识别。完整推理项在工具轮次之间保留。实验性的提示与工具反馈优化默认关闭，须先通过任务质量与实际 token 用量对比。

网页读取保留有界的来源链接列表，搜索结果宽泛时，Agent 可以沿官方网站的实际导航继续读取并核验引用。

```text
/login
/plan
解释请求预算的执行路径，并提出一个聚焦的回归修复计划。
```

审阅或修订计划，批准后显式开始执行。`/diff` 审阅改动，`/status` 查看请求设置和用量，`/resume` 恢复 Session。`/doctor` 进行本地诊断；`/doctor --live` 先预览有界探测，显式开始后可能产生费用。宿主 TUI 支持英文与简体中文自动选择和切换。

使用构建后的 CLI：

```powershell
pnpm build
pnpm link --global
everpeace
```

`pnpm build` 先清理生成的 `dist` 再编译；`dist` 被重定向时拒绝构建，类型错误不生成新产物。修复错误并重新构建后再运行 CLI。

当前源码版本：**0.6.0-rc.4**（源码预发布）。

## 真实调用，验证改动

| 独立历史计划 | 成功／计划 | 失败 | 超时／错误／取消／跳过 | Unknown Usage |
| --- | --- | --- | --- | --- |
| 初始工具验收 | 7 / 13 | 6 | 0 / 0 / 0 / 0 | 5 |
| 后续工具验收 | 5 / 7 | 2 | 0 / 0 / 0 / 0 | 2 |
| 独立重试计划 | 1 / 2 | 1 | 0 / 0 / 0 / 0 | 1 |

这些是既有 `grok-4.6` 中转运行。不同源码／构建候选分别展示；缺评测摘要或人工介入记录均标为**证据不足**。另三份计划缺少汇总，结果未知。这不是当前候选或 DeepSeek 的成绩。[逐次证据与缺失记录](docs/benchmark/PUBLIC_REPORT.md)。新增九类任务已有离线评分器证明，本轮真实模型运行次数为零。

根到目标目录的规则、`@` 文件附件和按需项目地图帮助 Agent 理解代码。编辑基于当前文件观察，提供绑定权限的预览和拒绝并发覆盖的 undo。Session、fork 和上下文检查点在恢复时保留工作与验证债务。

配置 MCP 的工具、资源和 prompts，以及本地 Skills，可以扩展 Agent。Learned Memory 保存偏好与经过验证的经验；公共网页访问检查重定向与网络边界。搜索的首选服务不可用时，会依次尝试中国区 Bing 和 DuckDuckGo。配置和完整限制见 [使用指南](docs/USAGE.zh-CN.md)。

MCP stdio 程序需要独立启动信任，默认在原生工作区沙箱运行并禁止联网。`/mcp trust <server>` 审阅启动身份，`/mcp reconnect` 启动或重载，`/mcp revoke <server>` 撤销访问。`/mcp mode <server> host` 明确选择宿主用户权限并撤销旧信任，启动前必须重新审阅授权。程序或入口脚本字节变化需要重新授权，动态启动器每次启动均确认。Windows host stdio 需要已核验的可执行程序和 argv；`.cmd`/`.bat` 入口请显式配置解释器。远程 MCP 必须使用 HTTPS，本机回环 HTTP 需要独立例外，重定向均拒绝。缺少启动批准时，非交互 CLI/SDK 返回 `interaction_required`（退出码 5）。

MCP 进程启动前的沙箱准备失败会保留启动原因，连接可以正常关闭；已启动进程仍须确认清理完成。

默认搜索使用 DOM 选择器；`/web` 可明确选择 Brave LLM Context，密钥只保存在系统凭据库，保存不发请求。`/doctor --live` 先预览有界流式、工具、用量与取消诊断，默认 Cancel。`/cost` 显示用户定价的估算、未知／不完整计量和任务预警；请求 Token 预算不是费用上限。[安全与诊断契约](docs/architecture/SECURITY_AND_DIAGNOSTICS.md)。

`/privacy` 展示持久化、保留策略和清理预览。首次设置推荐 30 天，复核预览后才生效；已有设置保持原样。`/history no-save` 不保存下一次输入历史，Session 仍保存对话。疑似秘密输入提供遮罩、授权原文或取消；原文也不写输入历史。删除 Session 同步清理关联历史，旧未关联记录使用 `/history clear` 单独清理。`everpeace privacy --help` 提供本地 CLI；`/perf` 展示实际时间和 Token，项目 Memory 在 90 天后暂停召回等待 `/memory` 审查。[隐私契约](docs/architecture/SECURITY_HARDENING.md)。

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
- 多文件修改采用持久条件恢复。`everpeace recover-batch <工作区>` 查看保留批次，指定 ID 并交互审阅后恢复。16 MiB 文件支持小范围补丁，补丁载荷仍限 512 KiB；`/verify --package <相对路径>` 显式检查子包。Windows 使用已核验的 Job 进程所有者，清理不明会阻止后续任务。详见[可靠性边界](docs/architecture/RELIABILITY_HARDENING.md)。
- 文件工具拒绝重解析点和多重硬链接目标。更新保全原文件，在禁止并发写入/删除的句柄内核对原始字节，以不覆盖方式安装；路径可能短暂不存在。`everpeace recover-file <工作区> <相对备份路径>` 恢复保留的原版本，用户后续保存会阻止恢复。
- 敏感读取在进入模型上下文和 Session 前提供遮罩、本次原文授权或拒绝；授权原文后，Web/MCP 外传逐次确认。模型 shell 默认禁网，启用后每个进程单独授权。Plan 分别显示工作区写入、公网访问和敏感外传状态。[安全边界与剩余风险](docs/architecture/SECURITY_HARDENING.md)。
- 验证脚本变化或恢复缺少可信基线需要审阅；拒绝后任务保持未验证。
- 恢复的验证债务即使没有已知变更路径也会保留，须通过当前授权的完整检查；工作区追踪不可用时仍为未验证。
- `Ctrl+C` 取消活动任务并等待清理；空闲时先清草稿，再退出。用户直接输入的 `!` 命令在独立宿主 PTY 中运行，独占终端输入，不进入模型上下文。
- 调整终端大小时保留输入草稿并重排历史；输入框忽略鼠标、焦点和光标位置回报。
- 请求预算包含重试、压缩与修复。未知用量会阻止有界任务继续请求，推理 token 是输出 token 的组成部分。token 预算不是严格账单上限。
  请求失败且用量未知时保留安全 HTTP 状态和错误类别，不记录供应商错误正文或请求头。

审批按键、终端操作和集成配置见 [使用指南](docs/USAGE.zh-CN.md)。更广泛的编码质量、稳定性和成本仍须通过实测衡量。[开发状态](docs/HANDOFF.md) · [DeepSeek 实测准备](docs/benchmark/READINESS.md)。

[官方 DeepSeek 实验协议](docs/benchmark/CODING_COMPETITIVENESS.md) 准备十二项上游任务、串行等预算配对、固定 dsh 对照及 Memory、网页、性能 pilot。准备和离线证明不调用模型；官方编码成功率、策略收益及成本尚未实测。

## 开发与贡献

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

按上述顺序执行门禁，首败停止，另跑 `git diff --check`。开发从 [AGENTS.md](AGENTS.md) 和 [文档地图](docs/README.md) 开始。可复现问题请提交到 [GitHub Issues](https://github.com/VinceTree/Everpeace/issues)。

[离线性能对照](docs/benchmark/LOCAL_PERFORMANCE.md) 使用固定 fixture 和保留样本，比较 CLI 新进程启动、Session 恢复、历史搜索与项目扫描。CLI 帮助耗时不代表终端首 prompt，本机结果不外推模型或跨平台收益。

采用 [Apache 2.0](LICENSE) 许可证，由 [VinceTree](https://github.com/VinceTree) 维护。

## 网络与源码安装保障

公共网页和远程 Skill 请求将校验过的 DNS 地址绑定到实际连接，包括 HTTP/HTTPS 代理 CONNECT。代理只读取宿主 HTTP_PROXY、HTTPS_PROXY、NO_PROXY，兼容小写变量。代理基础设施属于受信任边界；暂不支持 SOCKS/PAC，失败不回退直连，HTTPS 证书校验始终开启。[网络边界](docs/architecture/NETWORK.md)。

源码安装使用 pnpm 和固定 node-pty 补丁。依次运行 `pnpm files:build`、`pnpm install:verify`、`pnpm build`、`pnpm files:smoke`、`pnpm process:smoke` 和 `pnpm install:smoke`。`pnpm install:clean` 在干净源码副本重新编译原生文件与进程组件；`pnpm files:verify` 验证原生竞争故障注入。打包器要求经过摘要核验的 Windows 文件与进程组件，记录其摘要并拒绝分发故障注入程序；普通 npm/pnpm pack 仍被拒绝。正式可移植打包和消费者安装须另行验收，npm registry 发布仍待完成。

Node 22 CI 在 Windows 执行完整测试，在 Linux 执行可移植的隐私/网络/供应商测试。本候选的 Linux/macOS 工作区文件访问不可用，可移植测试不代表原生文件支持。正式 Release 仍须专用 Windows 和安装包验收，源码推送不会创建 Release。[Windows Runner 指南](docs/WINDOWS_RUNNER.md)。开发门禁按 `typecheck → lint → test → build` 首败停止，再核验文案、文档和安装；付费测试另需数值授权。

Hosted Windows 不执行嵌套原生沙箱用例；专用原生验收强制执行，包括 MCP 发现、过滤和启动隔离。host MCP 的协议及清理用例仍在 hosted Windows 执行。
