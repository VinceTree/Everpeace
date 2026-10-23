# 贡献指南

[English](CONTRIBUTING.md) · [常见问题](docs/FAQ.md) · [接口兼容](docs/COMPATIBILITY.md)

先提供可复现的小问题。安全漏洞请使用 [私密报告渠道](SECURITY.md)。公开 Issue 包含最小隔离样例、准确 commit 或包标识、系统、预期行为及脱敏诊断摘要即可，不要提交凭据或完整 Session。

源码开发需要 Node **22.19+**、Git 和 **pnpm 10.30.3**。消费者安装属于单独的交付门禁，见 [安装状态](docs/INSTALLATION.md)。

```sh
git clone https://github.com/VinceTree/Everpeace.git
cd Everpeace
pnpm install --frozen-lockfile
pnpm install:verify
node --import tsx --test tests/unit/cli/args.test.ts
```

目录导航：`src/cli`、`src/sdk`、`contracts` 是公开接口；`src/runtime`、`src/agent`、`src/workflow` 管理任务和验证；`src/projects` 管理只读项目识别；`src/tui`、`src/localization`、`src/status` 管理界面与状态投影；`src/storage`、`src/memory` 管理持久化；`src/tools`、`src/permissions`、`src/team` 管理受保护操作。测试位于 `tests/unit` 和 `tests/fixtures`，分发及安全检查位于 `scripts/release`、`scripts/security`。

小修复示例：在两份文案目录中修正显示标签，运行 `pnpm ui:verify` 和对应 TUI 测试。行为修改应先复现触发条件，增加有实际意义的回归，并保留无关文件和用户改动。涉及进程、文件或 Session 的测试必须使用自有临时目录；日常测试不会调用付费模型。

提交前依次执行，首败停止：

```sh
pnpm typecheck
pnpm lint
pnpm ui:verify
pnpm docs:verify
pnpm test
pnpm build
pnpm install:smoke
git diff --check
```

Windows 和 Linux hosted 检查都须通过；跳过代表未覆盖，不能替代专用 Windows 原生门禁。公开消费者样例已经冻结，不要与实现一起修改来掩盖兼容问题。新增宿主文案须集中写入两份目录，插值参数保持一致。输入法及屏幕阅读器的人工验收见 [终端验收矩阵](docs/TERMINAL_ACCEPTANCE.md)。

PR 说明写清触发条件、修改后的行为、验证及限制。机器专属路径和原始日志保存在忽略的 `.cache/private-evidence/`；公共文档使用相对路径、可复现命令、commit 和摘要值。清理当前文档不重写旧提交或移动标签。新人可以从本指南完成小修复，无需先读整套内部交接。
