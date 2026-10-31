# FAQ / 常见问题

**Can I install with npm today? / 现在可以直接 npm 安装吗？**

The registry channel is not open. The intended consumer flow uses preinstalled Node 22.19+ and one validated tarball, with no Git, pnpm or TypeScript compilation. Source prereleases are not proof of native package delivery. [Current installation gates](INSTALLATION.md).

npm registry 渠道尚未开放。目标消费者流程是预装 Node 22.19+ 后安装同一份已验收包，不需要 Git、pnpm 或编译 TypeScript。源码预发布不能证明原生安装包已交付。

On Windows PowerShell, an unsigned downloaded npm shim may be refused by local policy. Use `npm.cmd` and, if needed, `everpeace.cmd`; no execution-policy change is required. / Windows PowerShell 可能按本机策略拒绝未签名的 npm 脚本。使用 `npm.cmd`，必要时使用 `everpeace.cmd`，无需改变执行策略。

**How do I select Chinese? / 怎样切换中文？**

Use `everpeace --lang zh-CN`; `/language auto|en|zh-CN` saves a display preference. Priority: CLI, `EVERPEACE_LANG`, saved preference, system locale. `auto` selects simplified Chinese for Chinese locales and English otherwise. Commands, shortcuts, JSONL fields, error codes and original model/tool text retain their identities.

使用 `everpeace --lang zh-CN`，或用 `/language auto|en|zh-CN` 保存偏好。优先级为命令行、环境变量、用户设置、系统语言。中文系统选择简体中文，其他系统选择英文；命令、快捷键、协议字段及原始模型/工具内容保持原样。

**What if the terminal cannot run Ink? / 终端能力不足怎么办？**

`--accessible` uses append-only text and numbered decisions, with the same protected runtime. `TERM=dumb` selects it automatically. It requires a TTY. Redirected automation should use `exec --json`; approvals stop with exit 5 rather than prompting. `NO_COLOR` does not remove meaning. Actual IME and NVDA results remain separate from simulated input tests.

`--accessible` 使用追加文本和编号审批，复用受保护运行时，`TERM=dumb` 自动选择此模式。它仍需要 TTY；重定向自动化使用 `exec --json`，需要审批时退出码为 5。`NO_COLOR` 不减少信息。真实输入法和 NVDA 验收与模拟输入测试分别记录。

**Does exit 0 prove the change works? / 退出码 0 就表示功能正确吗？**

Read `workflowResult`: a run may have no changes or only an approved plan. Project checks and independent host acceptance are different evidence. Missing final JSONL events, incomplete trailing lines, unknown usage or unresolved cleanup must not be inferred as success. [Public contract](COMPATIBILITY.md).

还须读取 `workflowResult`；可能无改动或只完成了计划。项目检查与独立宿主验收属于不同证据。缺少最终事件、末行不完整、用量未知或清理未确认时不能推断成功。

**Why does cancellation keep the task busy? / 取消后为什么仍显示忙碌？**

The runtime waits for owned resources to close. Cleanup failure keeps admission blocked and reports the retained problem; a Windows `taskkill` failure is not automatically success. Inspect the resource and environment before restarting. Session readability is not a safe-resume guarantee.

运行时须等待自有资源关闭。清理失败会继续阻止任务并展示保留问题，不能把 Windows `taskkill` 失败直接当成功。重启前应核查资源和环境；Session 可读取不代表可以安全恢复。

**Are Python, Rust and Go fully supported? / Python、Rust、Go 是完整支持吗？**

No. Conventional basic checks remain available through read-only adapters; complete support remains Node single-package projects. Missing tools are environmental failures, unknown diagnostics stay unknown, and no extra toolchain is silently installed.

当前仍完整支持 Node 单包项目。其他语言保留基础检查发现能力，通过只读适配器实现；工具缺失属于环境问题，无法识别的诊断保持未知，不静默安装工具链。

**Where do data and evidence go? / 数据和证据存在哪里？**

`/privacy` lists persistence, retention and deletion; the default Session retention is forever. Default exports contain redacted diagnostic metadata. Memory and credentials have separate lifecycles. Public cleanup affects current files and archives only: older commits, tags and source archives may still contain old machine paths.

`/privacy` 列出存储、保留期和删除方式；Session 默认永久保留。默认导出脱敏诊断元数据，Memory 和凭据有独立生命周期。公共文档清理只影响当前文件及归档；旧提交、标签和历史源码归档仍可能包含旧路径。
