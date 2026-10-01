# 当前交接

更新日期：2026-10-01。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选专题；本文件只保存当前状态。旧记录完整保留在 [历史交接](archive/HANDOFF_HISTORY.md)。

## 当前基线

- 产品：DeepSeek 优先、Windows 优先的单 Agent 个人开发 CLI；Node/TypeScript 单包、Responses、inline TUI。
- 本轮起点：`main` 与 `origin/main` 一致，HEAD `ba8caaf5140f7d64c92b9828d0f15ce95e953cfe`，package 展示版本 `0.3.2`。
- 用户随后授权将展示版本提升至 `0.3.3` 并提交、推送；提交使用 `[skip publish]`，不创建 tag 或 GitHub Release。本轮未升级依赖，也未进行付费模型请求。

## 本次完成：日常使用优化

### Composer 文件引用

- 输入 `@` 使用可取消的有界 `rg --files` 候选，最多显示八项；选择后插入 `@"path"`，可追加 `#L10-L40`。
- 只展开 Markdown code 之外的显式引用；提交时通过既有工作区包含、真实路径、UTF-8 和二进制保护重新读取。
- 默认 200 行，显式范围最多 1,000 行；每条消息最多八个摘录，单个 32 KiB、合计 64 KiB。失败保留草稿并显示错误。
- 用户原文和附件作为同一 durable context item 先持久化。附件只附加一次，普通问题与 guidance 保持顺序，retry/repair/Goal continuation 不重复。
- 引用路径参与 nested project-rule 发现；附件不产生文件观察或写权限，恢复后也不能凭附件覆盖文件。

### 可读工作区变更审阅

- `/diff` 使用新的只读 human-review 服务，从结构化 Git status 分别列出 staged、unstaged、untracked；同一路径可同时出现 staged 与 unstaged 条目。
- tracked 文本惰性显示 unified diff；untracked UTF-8 文件显示有界预览；binary、symlink、submodule 和非普通文件显示明确摘要。
- 支持八行列表、详情分页、`R` 刷新及 Esc 详情 → 列表 → 聊天；异步加载可取消并忽略迟到结果。
- 仓库子目录 workspace 只显示其范围内路径，禁用 external diff/textconv；详情上限 2 MiB 或 10,000 行并显式标记截断。
- 界面显示 “Last task result”，不把当前变化声称为 Agent 所有。模型的既有 workspace tool contract 未改变。

### 可搜索 Session 恢复

- `/resume [query]` 默认搜索当前工作区，可切换 All workspaces；标题及 user/assistant 对话采用不区分大小写的字面量匹配。
- tool output、模型 context 和 learned Memory 不参与搜索。每个 Session 一条结果，按最新活动排序，八行显示、每页 50 项，并在恢复前显示本地对话预览。
- JSONL 流式校验并生成 16 MiB 有界进程内 LRU 投影；追加/删除使缓存失效，损坏文件单独隔离，不增加持久索引或 schema migration。
- query 使用 200ms debounce，旧搜索可取消且迟到结果被忽略。选择后仍走原恢复路径，保留模型、工作目录、Goal 与验证债务；原删除确认流程保留。

### 最近 coding 请求检查

- `/context` 显示 “Last submitted coding request”，只在 coding provider call 已准入并即将发送时捕获不可变内存快照。
- 展示 model/provider、时间、context revision、序列化请求估算、output reserve、规则来源、Skills/Memory/MCP、广告工具、附件范围、conversation item counts 和 opaque item 大小。
- 可见来源只提供有界脱敏预览；凭据、transport headers、reasoning/encrypted body 不进入预览。估算与 measured usage 分开，组件估算不要求相加等于请求估算。
- 打开和刷新不发送模型请求、不刷新文件、不压缩 context。首次提交前、重启、恢复或 Agent 替换后显示明确空状态；辅助请求不覆盖 coding 快照。

## 主要实现与回归入口

| 领域 | 实现 | 回归 |
| --- | --- | --- |
| 文件附件 | [file-attachments.ts](../src/agent/file-attachments.ts)、[react-agent.ts](../src/agent/react-agent.ts)、[prompt.tsx](../src/tui/composer/prompt.tsx)、[task-runner.ts](../src/workflow/task-runner.ts) | [file-attachments.test.ts](../tests/unit/agent/file-attachments.test.ts)、[react-agent.test.ts](../tests/unit/agent/react-agent.test.ts)、[prompt-history.test.tsx](../tests/unit/tui/prompt-history.test.tsx) |
| `/diff` | [workspace-review.ts](../src/tools/workspace-review.ts)、[workspace-diff-surface.tsx](../src/tui/components/screens/workspace-diff-surface.tsx) | [workspace-review.test.ts](../tests/unit/tools/workspace-review.test.ts)、[daily-use-surfaces.test.tsx](../tests/unit/tui/daily-use-surfaces.test.tsx) |
| `/resume` 搜索 | [session-store.ts](../src/storage/session-store.ts)、[session-picker.tsx](../src/tui/components/navigation/session-picker.tsx) | [session-store.test.ts](../tests/unit/storage/session-store.test.ts)、[session-picker.test.tsx](../tests/unit/tui/session-picker.test.tsx)、[app.test.tsx](../tests/unit/tui/app.test.tsx) |
| `/context` | [context-inspection.ts](../src/agent/context-inspection.ts)、[context-surface.tsx](../src/tui/components/screens/context-surface.tsx) | [context-inspection.test.ts](../tests/unit/agent/context-inspection.test.ts)、[daily-use-surfaces.test.tsx](../tests/unit/tui/daily-use-surfaces.test.tsx) |

中英文 README、PLAN、PROJECT_MAP、RUNTIME、TOOLS、STATE_AND_UI 和 DECISIONS 已同步。

## 验证证据

本轮使用 Windows Node 工具链按要求串行执行：

- `pnpm typecheck`：通过。
- `pnpm test`：437 项，435 通过、2 跳过、0 失败/取消；数量包含工作区已有未跟踪测试，不能充当全新 checkout 的固定计数。
- `pnpm build`：通过。
- Linux Node 定向执行 `tests/unit/storage/session-store.test.ts`：18 项全部通过；覆盖 Windows workspace path 在非 Windows 主机上的大小写与分隔符归一化。
- 从 `origin/main` 创建的全新 Windows clone 完成 `typecheck → test → build` 与 `git diff --check`；clean suite 为 434 项、432 通过、2 跳过，并额外连续重复两次完整测试，均为 0 失败。
- 使用 GitHub runner 同版 Windows Node `22.22.1` 及 `D:\a\Everpeace\Everpeace` 路径再次执行完整 suite 仍通过；新增 TUI 回归已改用有界条件等待，移除依赖 60ms 余量的固定 sleep。
- 仓库没有 lint script，因此未运行 lint。
- 全工作区 `git diff --check` 仍只报告本轮开始前已有的 `.gitignore`、`LICENSE` CRLF 差异；排除这两个文件后的 tracked 差异通过。所有本轮新增源码/测试另行扫描，无行尾空白。
- README、PLAN、HANDOFF 与 architecture Markdown 共 15 份已扫描，本地链接均可解析。

定向回归覆盖附件的引用/Unicode/范围/长行/缺失/二进制/包含边界/大小上限/持久化，Git staged+unstaged overlap/untracked/nested workspace/特殊文件，Session 匹配/排除/scope/分页/cache invalidation/corrupt/deletion，以及 context 准入/脱敏/不可变/空状态和三个新 UI surface 的键盘流程。

本轮未执行真实 Windows Terminal 手工验收，也未运行 live API 或付费 benchmark。clean-checkout 的 Linux 依赖安装在本地 WSL 因缺少 `make` 未完成；GitHub Ubuntu CI 首次运行据此发现并已修复 Session workspace path 的跨主机归一化问题。两次 post-fix GitHub Windows job 均在较慢 runner 的 `pnpm test` 返回退出码 1，而四次 clean Windows 本地运行及 runner 同路径/同 Node 运行均未复现；本轮已将新增 TUI 回归的固定延迟改为有界条件等待。自动化测试不替代 resize、原生 scrollback、真实 Esc 重放和终端取消的人工证据。

## 已知限制与下一步

1. **真实 Windows Terminal 待验收**：重点检查 `@` 候选、三个命令窗口、窄屏/resize、Esc 层级、native scrollback、Ctrl+C 和 Session 恢复。
2. **LSP 隔离尚未接通**：协议能力只读，但显式配置的 executable 仍由宿主直接 spawn；只可配置可信程序。
3. **固定 dsh 与真实模型比较待授权**：先验收 checkout/profile 启动；九次 smoke 和九十次正式比较都需要单独的 task/campaign 数值预算。
4. 持久 undo、LSP isolation、自动历史检索和模型速度/token 调优仍是独立后续工作。

## 用户已有差异

本轮开始前 `.gitignore`、`LICENSE` 有未暂存 CRLF 差异；未跟踪 `.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`tests/unit/codex/`、`{}`。这些内容不属于本轮实现，均未清理、覆盖或纳入修改。

交接只是快照；下一轮仍须查看实时 Git 状态。
