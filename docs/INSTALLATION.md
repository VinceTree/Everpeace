# Consumer installation / 消费者安装

The intended first supported packages are Windows x64 and Linux x64 with Node **22.19+** already installed. macOS and ARM64 remain experimental or uncovered. The npm registry channel is not yet open; the package name remains `everpeace`, with no alternate name chosen.

首批目标是预装 Node **22.19+** 的 Windows x64、Linux x64。macOS、ARM64 保持实验或未覆盖。npm registry 渠道尚未开放，包名仍为 `everpeace`。

Current registry probes returned `ENEEDAUTH` for identity and `E404` for the name. E404 does not prove ownership or reserve the name. The manifest remains private; channel readiness must be established before freezing a public publishing candidate, which then passes the same artifact gates.

本轮 registry 查询身份返回 `ENEEDAUTH`，包名返回 `E404`。E404 不能证明所有权或预留名称。manifest 仍保持 private；准备好渠道后再冻结可发布候选，并对该候选执行同包门禁。

After native delivery gates pass, the beginner flow is:

```sh
npm install --global ./everpeace-<package-id>.tgz
everpeace login
everpeace --lang auto
```

Then ask for a small change in a disposable Node project and review `/diff` and `/status`. Node must be installed by the user; startup diagnostics explain missing dependencies and never silently install system software or change terminal settings. The consumer does not clone Git or compile TypeScript. Until the validated artifact is available, use the [source contribution setup](../CONTRIBUTING.md).

PowerShell can use `npm.cmd install --global ./everpeace-<package-id>.tgz`, `everpeace.cmd login` and `everpeace.cmd --lang auto` when local policy refuses downloaded `.ps1` shims. This does not weaken execution policy.

门禁通过后使用上面的安装、登录、运行流程。在隔离 Node 项目提出一个小任务，检查 `/diff` 和 `/status`。Node 由用户预装，启动诊断说明缺少的依赖；不静默安装系统组件或修改终端。已验收包提供编译产物，消费者无需 Git 或本地编译。包交付前可使用 [源码开发流程](../CONTRIBUTING.zh-CN.md)。

Maintainer requirements remain strict: freeze the candidate commit; build the portable tarball on the existing Linux build path; verify integrity, native dependency receipts and licensing; run Windows/Linux consumers against that same tarball, including npm/pnpm global installation, upgrade, uninstall and reinstall; require dedicated Windows native success. Missing machines, skipped native tests or an unknown npm publishing identity block delivery.

维护者须冻结 commit，沿现有 Linux 流程构建可移植包，核对摘要、原生收据及许可，并以同一 tarball 完成两平台 npm/pnpm 全局安装、升级、卸载、重装和专用 Windows 原生门禁。机器缺失、原生测试跳过或 npm 身份未知都会阻止交付。

Future npm publishing must use the already accepted tarball with `npm publish <exact-tarball>`; it must not rebuild, rename the package, or substitute a different artifact. No registry publication is performed by this implementation stage.

后续 npm 发布复用已验收 tarball，不重建、不改名、不替换产物。本实施阶段没有进行 registry 发布。
