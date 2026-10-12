# 当前交接

更新日期：2026-10-10。先读 [AGENTS](../AGENTS.md)，按 [索引](README.md) 定位；本轮详细契约见 [TEAMS](architecture/TEAMS.md)。前轮交接已移至 [profile 交付归档](archive/HANDOFF-2026-10-09-profiles.md)，旧授权与证据不适用于本轮。

## 当前范围与授权

用户授权实施并继续完成 P0–P4 多 Agent、编码可靠性与开发体验计划，并在实现验收后明确授权更新版本、提交、推送与 GitHub Release。默认单 Agent，协作显式开启；主方向仍是 Windows、DeepSeek 和 Node/TypeScript 单包。当前源码版本更新为 **0.5.0**，同步 package.json 与双语 README；工作起点为 `7ce6ca3e659b4b5b55a4727dc49a77bbc5b6f210`。授权不包含付费模型调用或 npm publish，实际均为零。

保留工作起点的未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`，不纳入提交；不能把用户原有目录当成待清理产物。测试用 Git fixture 的提交只发生在宿主所有的临时目录，不创建用户提交或改用户 index。

发布交付根为 `C:\Users\39850\AppData\Local\Temp\everpeace-publish-20261010`，保留实现验收原收据、发布前源码核对、最终 source/build digest、准确 commit、Windows/Linux CI、tag 和 Release 的远端核验。发布的最终状态及不可自引用的准确 commit 以该根 `delivery-receipt.json` 为准；它只在两平台 CI、tag 与 Release 全部核对后生成，不把计划步骤写成已完成结果。

发布顺序：提交含 `[skip publish]`，先推 main 执行 Windows/Linux Test；两平台通过后显式创建并推送匹配 manifest 的 tag，触发 Release workflow，再核对 tag、Release、正文和最新标记。此标记仅延后分支的自动发布，不跳过 CI，也不阻止已授权的 tag 发布。现有工作流不执行 npm publish。

首个发布候选 `c7531e3` 已推 main，但 [Test](https://github.com/VinceTree/Everpeace/actions/runs/38047389689) 未通过：Windows 的受管理 Skill 与 project insight 把大小写不同的 canonical 路径当成重定向；Linux 的 worker 原生隔离启动未取得证据。继续修复，不创建 tag。Windows 改用平台原生 relative 比较并在回归中保留大小写不同的路径；Linux 增加内核 namespace 诊断和仅固定类别/探测键的失败说明，不输出原始 backend 日志，不弱化隔离或跳过测试。后续 CI 与准确发布结果保留外置收据。

诊断候选 `d01d427` 的 Linux [日志](https://github.com/VinceTree/Everpeace/actions/runs/38047827500) 确认 `apparmor_restrict_unprivileged_userns=1`，普通 `unshare` 被拒绝，原生探测为 `os_policy_refusal`。CI 为锁定 native binary 增加专用 `userns` profile，保持系统限制开启；不改变用户系统设置。最新源码的本地门禁已通过：1117 项、1114 通过、3 跳过、0 失败，107601.5327 ms；最新代码 Linux 双成员原生探测通过。后续 CI 验证该环境准备和完整检查，通过前仍不创建 tag。

Hosted Windows 第二轮仍失败；除大小写外，临时根还可能使用短路径/重定向 alias。团队 fixture 创建 owned 临时目录后先 realpath 为原生根，再测试大小写 alias；不放开生产对其他目录重定向的拒绝。该修复保留原有资源所有权和真实文件断言。[环境修复候选](https://github.com/VinceTree/Everpeace/actions/runs/38048097197) 的 Linux job 已通过，包括真实 namespace 隔离和双 worker 整合；Hosted Windows 的原生集成 skip 不替代本机 Windows 证据。

CI 环境与 fixture 修复后最终本地串行门禁通过：typecheck → lint 缺项 → test → build，**1117 项、1114 通过、3 跳过、0 失败，106248.1091 ms**；diff 检查、最新构建的 CLI help/SDK 导入与 pnpm pack 通过。最新 `final-*.log`、Linux 原生证据与 pack 均在发布交付根，历史候选日志保留。最终远端 CI 绑定最终 commit，发布收据重新计算源码/构建/包摘要，不把文档更新前的 source digest 当成最终摘要。

## 已实现的阶段

| 阶段 | 当前交付 |
| --- | --- |
| P0 | 团队唯一总账、不可 reset 的 scope、集中请求预留、计量落盘、sticky unknown、稳定请求 ID、计量连续恢复、诊断分类；关闭协作的 v1 与单 Agent 回归通过 |
| P1 | 默认根加两成员，角色独立模型/profile/context，只读 explorer/reviewer、依赖调度、成员取消、权限收紧与迟到结果屏障、独立 Session |
| P2 | 当前字节快照、detached worktree、原生隔离准入探测、范围/版本/产物 hash 核验、串行幂等整合与保留冲突、根完整验证和成功回收 |
| P3 | 英文 `/team` 窗口、角色/额度配置、成员详情、显式继续/清理、旧团队 ID 入口、CLI/SDK 共享运行时、协作 JSONL v2、根唯一终态；真实 Windows Terminal 验收 |
| P4 | 有来源的项目入口/import/测试候选与内容指纹缓存、跨成员重复调用观察、Skill 来源/更新预览/受管理卸载、MCP 显式重连、固定离线单 Agent/团队对照 |

根拥有 spawn/list/wait/message/cancel/integrate 工具；Plan 只允许只读成员，成员不能递归委派、提升权限、完成根 Goal、写成功 Memory 或直接操作 MCP。角色模型未设置时继承根模型，错误注册/凭据/profile 明确拒绝。模型与请求设置在任务内冻结；不复制父会话或 opaque reasoning。

Git 快照包含 tracked 当前内容/删除及普通非 ignored untracked，拒绝链接、子模块、非根工作区和不完整快照。HEAD 解析为不可变 commit，并在快照复核后检查变化；worktree 和成员 index 都使用捕获的 commit。Git 命令临时启用 core.longpaths，不改用户配置。源文件不硬链接，node_modules 不共享可写目录。只有通过真实原生隔离探测的 worker 才启动 provider；没有宿主执行降级。

整合复用既有原始字节版本、审批 revision、checkpoint 与回滚；超范围、并发修改、二进制/编码不兼容或冻结产物被改变时保留并拒绝自动应用。稳定 integration ID 在写入前落盘，重启检查 baseline/已应用目标/冲突，不能盲目重放。子项目通过不能替代根验证。根验证成功才收回已整合工作区；冲突/失败/中断保留，清理只作用于所有权核验的团队目录。

默认团队共享 96 provider attempts/30 分钟，与根更严格限制取最小值；可选 token 预算按输入估算加固定输出上限集中准入，不宣称账单硬上限。unknown 关闭新请求、传播停止并永久保留，显式继续不能清空它。审批不恢复；模型、权限、Session、工作区和文件重新检查。非交互入口需要批准或回答时先收束，再报告 interaction_required。

## 最终验证

最后代码改动后串行执行 `pnpm typecheck → lint（脚本不存在）→ pnpm test → pnpm build`，实际存在的检查全部通过：**1117 项测试，1114 通过、3 跳过、0 失败，88882.5833 ms**。lint 是缺项，不记为通过；`git diff --check` 另行通过。构建后的 CLI help 和公共 SDK runTask 导入通过，不发模型请求。

更新 manifest 与双语展示后，发布前再次串行执行 typecheck → lint 缺项 → test → build，**1117 项、1114 通过、3 跳过、0 失败，109494.8563 ms**；diff 检查、当前构建的 CLI help/SDK 导入和 pnpm pack 通过。日志与 `everpeace-0.5.0.tgz` 保存在发布交付根，源码与打包产物重新绑定摘要，不沿用实现阶段的 source digest。

最终日志位于 `C:\Users\39850\AppData\Local\Temp\`：

- `everpeace-team-final-typecheck-passed.log`、`everpeace-team-final-test-passed.log`、`everpeace-team-final-build-passed.log`：最终串行门禁；typecheck/build 正常退出但没有日志正文，退出结果和产物摘要见验收收据。
- `everpeace-team-layout-fix.log`：团队与 App 并行定向回归，102 项通过。
- `everpeace-team-pinned-head.log`：真实 Git HEAD 移动后仍使用捕获 commit 的定向回归通过。
- `everpeace-team-comparison.log`：离线固定单 Agent/团队对照，独立源码断言与真实根检查通过；还覆盖成员验证通过而根检查失败。
- `everpeace-team-final-linux-native.log`：最终代码的 Linux 原生隔离探测通过。

三项跳过分别是当前 Windows 文件系统不允许的文件 symlink、Windows 临时目录 alias 的既有 CI 专项、Unix 子进程用例。它们不能替代原生隔离证据；本轮 Windows/Linux 实机隔离有另外的真实执行。

完整回归覆盖共享额度/unknown/持久化失败/重启计量、模型/profile/context 隔离、单成员与根取消、依赖/范围串行、staged/unstaged/untracked、长中文路径/CRLF/BOM、并发修改与幂等整合、根失败/修复耗尽、Session/TUI/exec 背压和资源清理。新团队专项有 24 项测试，窗口专项 2 项，App 增加旧团队 ID 与清理路由回归；既有 runner/Session/权限/sandbox/Goal/Memory 测试同时通过。

收尾发现并修复 Ink 的 Static 生命周期问题：聊天切换到命令窗口时释放祖先会留下已释放的 Yoga 引用，后续读出异常尺寸，默认并行测试出现 OOM。现共享稳定最外层 Box、直接卸载 Static。诊断时的 heap/尺寸 guard 都位于外部临时目录，未加入产品；最终门禁使用原来的 test-concurrency=4，没有增大 heap、串行绕过或跳过失败测试。之前失败日志保留，不算通过证据。

## 原生与终端实机证据

**Windows：**最终完整回归实际执行 pinned Codex 原生后端，验证两 worker 独立编码/整合及根成功和根失败。探测证明成员 cwd、本目录写入以及主目录写入/其他成员读写/ownership 记录/Git 公共 metadata 的边界；没有用 mock 替代。

**Linux：**WSL Ubuntu、Node v22.22.1 的真实 kernel sandbox 执行最终源码快照，两成员均证明 owned cwd 与 source/sibling/metadata denial。临时根为 `C:\Users\39850\AppData\Local\Temp\everpeace-team-linux-20261010`；原生二进制来自已锁定 codex 依赖并核对完整性，未改仓库依赖。WSL 的 NAT/代理环境提示保留，不影响探测；此证据是 Linux 原生隔离专项，不声称完整 Linux TUI/SDK 验收。

**Windows Terminal：**使用真实 WindowsTerminal 1.24、宿主所有的 offline fixture、合成 Responses；不读取用户注册表/keyring，不发真实模型请求。证据根为 `C:\Users\39850\AppData\Local\Temp\everpeace-team-terminal-d7ca9eae-bdae-4522-85d3-a21bd6e4aa1c`，截图和带 HWND/PID/终端版本的 action 记录在 `terminal-evidence/`。

该根 `delivery-receipt.json` 绑定最终 source/build digest、检查结果、原生探测和明确采用的终端截图；临时资料没有加入仓库。

最终代码复核 `final-team-panel.png`、`final-team-esc.png`、`final-chat-resize.png`、`final-team-cancel-settled.png`，并在恢复的同一聊天上实际执行 wheel/zoom，截图为 `final-chat-native-scrollback.png`、`final-chat-native-zoom.png`；前一轮成员消费/独立 Session 详情截图另行保留。根 Session `29fcd1d6-3506-477a-b68d-ed15981c4e2e` 的团队 `4d47893e-09e0-4d13-af9a-a9929f7fbd9d` 两只读成员完成，共 65 synthetic tokens/5 attempts/openRequests=0。随后团队 `54f4bff0-31b9-47a1-abc5-6134b1b62e6b` 两成员在途时 Ctrl+C：最终成员 interrupted、openRequests=0/inFlight=[]，unknown 保留为 usage.complete=false，没有迟到成功正文。

重启 fixture、恢复上述根 Session、打开旧 ID 的截图为 `final-historical-owned-team.png`，显示旧团队 4d47893e 与完整用量，未被新团队状态覆盖；Esc 返回同一 Session。已退出 fixture，所属 Node 和团队后台进程没有继续运行。焦点变化拒绝输入/截图、初次 GPU 黑图及旧 fixture 忽略历史 ID 的失败尝试都保留，不算通过；fixture 已对齐生产历史路由，成功截图单独标识。

## 使用与限制

入口和双语示例见 [英文使用指南](USAGE.md#agent-teams)、[中文使用指南](USAGE.zh-CN.md#多-agent-协作)。TUI `/team on` 后 Esc 返回聊天；CLI `everpeace exec "任务" --team`；SDK 可传 `team: {}`。角色注册 ID 与最多 1–3 Agent 可在任务前配置；`/team <team-id>` 要先恢复所属根 Session。

首版并行编码仅支持 Git 根和文件编辑工具支持的文本变更。Windows/Linux 每次启动 worker 都先证明隔离；实际环境不能满足时明确拒绝，仍可用单 Agent/只读成员。权限、恢复和清理失败必须保留产物并阻止后续任务绕过。团队总账保留未知缺口时不能继续 provider，需开始新任务并独立处理保留产物。

离线对照的评分、耗时、tokens、重复调用、冲突和人工介入只说明固定合成请求的工程行为。没有付费模型实测，不宣称团队更快、更省或成功率更高；后续实测必须重新取得 task/campaign 数值预算授权。递归团队、成员互调、远程执行、Web/Desktop、OAuth、私有 Skill 和完整插件市场仍不在本轮范围。提交、推送与 GitHub Release 本轮已授权，须核对实际结果；付费模型实测没有授权。
