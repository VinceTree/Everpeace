# Everpeace

**面向个人项目的编码 Agent，从计划走到经过检查的代码改动。**

[English](README.md) · [使用指南](docs/USAGE.zh-CN.md) · [开发文档](docs/README.md)

[![Test](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml/badge.svg)](https://github.com/VinceTree/Everpeace/actions/workflows/test.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Everpeace 是 DeepSeek 优先、Windows 优先的个人 Node.js / TypeScript 开发 CLI。单个 Agent 读取项目规则、搜索代码、提出计划、修改文件，再运行项目声明的检查。你可以在 inline 终端中交互，通过 `everpeace exec` 自动执行任务，或从 TypeScript 调用同一 runner。

编码任务由宿主判定是否完成：重新发现 `typecheck → lint → test → build`，按顺序执行存在的检查，首败停止，最多进行三轮修复。缺少检查、证据过期、取消和用量不完整都会明确保留。

## 开始使用

准备 **Node.js 22+**、Git 和 **pnpm 10.22.0**。从仓库安装以应用 Windows `node-pty` 补丁；保留 optional dependencies，以使用随包代码搜索。

```powershell
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm dev
```

启动后输入 `/login`，选择 DeepSeek，输入遮罩显示的 API Key，再选择服务返回的原始模型 ID。也支持 OpenAI 和自定义 HTTPS Responses 端点，能力按实际端点识别。密钥保存在系统凭据库，不写入项目或 Session。

```text
/login
/plan
解释请求预算的执行路径，并提出一个聚焦的回归修复计划。
```

审阅或修订计划，批准后显式开始执行。`/diff` 审阅改动，`/status` 查看请求设置和用量，`/resume` 恢复 Session。`/doctor` 进行本地诊断；`/doctor --live` 会发起模型请求，可能产生费用。宿主 TUI 界面使用英文。

使用构建后的 CLI：

```powershell
pnpm build
pnpm link --global
everpeace
```

当前源码版本：**0.3.23**。本次源码更新不创建 GitHub Release。

## 它怎样协助开发

| 工作 | 支持方式 |
| --- | --- |
| 理解项目 | 根到目标目录的规则、随包搜索、`@` 文件附件与按需项目地图；可选只读 TypeScript 导航支持定义、引用、实现和 hover。 |
| 完成可审阅的改动 | Plan 修订与批准、基于当前文件观察的编辑、绑定权限的预览、改动审阅，以及拒绝并发覆盖的 undo。 |
| 继续长任务 | 持久 Session、独立 fork、上下文检查点、任务所属后台命令，以及恢复时保留的验证债务。 |

配置 MCP 的工具、资源和 prompts，以及本地 Skills，可以扩展 Agent。Learned Memory 保存偏好与经过验证的经验；公共网页访问检查重定向与网络边界。配置和完整限制见 [使用指南](docs/USAGE.zh-CN.md)。

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

## 控制与边界

- 模型 shell 在固定原生 sandbox 中执行，Windows 通过 MXC 运行 PowerShell。sandbox 或 LSP 网络探针失败会阻止启动。可选语言服务器需事先安装并显式配置。
- 文件更新需要当前观察版本；审批和 undo 不覆盖用户后续修改。恢复 Session 保留工作，新的动作仍受当前权限约束。
- 等待审批时，空草稿输入 `y` 批准，`n` 或 Enter 拒绝；已有草稿时 Enter 只提交 guidance，不同时批准工具。
- `Ctrl+C` 取消活动任务并等待清理；空闲时先清草稿，再退出。用户直接输入的 `!` 命令在独立宿主 PTY 中运行，独占终端输入，不进入模型上下文。
- 请求预算包含重试、压缩与修复。未知用量会阻止有界任务继续请求，推理 token 是输出 token 的组成部分。token 预算不是严格账单上限。

离线回归与原生探针提供工程行为证据；真实模型编码质量、稳定性和成本仍须通过实测衡量。Windows Terminal 的人工验收单独记录。[当前证据与待办门禁](docs/HANDOFF.md) · [DeepSeek 实测准备](docs/benchmark/READINESS.md)。

## 开发与贡献

```powershell
pnpm typecheck
pnpm test
pnpm build
```

当前没有 lint script。开发从 [AGENTS.md](AGENTS.md) 和 [文档地图](docs/README.md) 开始。可复现问题请提交到 [GitHub Issues](https://github.com/VinceTree/Everpeace/issues)。

采用 [Apache 2.0](LICENSE) 许可证，由 [VinceTree](https://github.com/VinceTree) 维护。
