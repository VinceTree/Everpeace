# Session Handoff

状态快照：2026-09-16。分支 `main`，HEAD `a3358cc`，与 `origin/main` 同步；下述 v0.1.19 改动全部仍在工作树中，尚未提交。

## 1. 当前最终目标

完成 Everpeace v0.1.19 的 Windows PowerShell/Windows Terminal TUI 稳定性修复：

- `!<command>` 的 PTY 输出在现有界面内流式显示并保留，不暂停或整页刷新 TUI。
- 普通滚轮仍可查看会话；反复 Ctrl+滚轮缩放后，历史、顶部信息框和输入框正确恢复，只保留一个输入框。
- 顶部 model/directory 信息框和输入框不因字号变化发生终端自动折行或重影，行为尽量对齐 Codex。

用户已要求暂停继续实现新功能；除非用户明确恢复，不要扩展功能。

## 2. 已经完成什么

- 版本号和中英文 README 已更新到 `0.1.19`。
- 直接终端命令改为 `node-pty` + `@xterm/headless`：TUI 内关闭原始 PTY 直写，约每 32ms 提供一次终端渲染快照；执行完毕后把最终排版结果加入历史。
- 会话历史改为应用状态中的 `timeline`，通过 Ink `Static` 提交；缩放稳定后可从状态完整重放。
- 缩放恢复采用 Codex 同类策略：live composer 立即跟随 viewport，静态 transcript 使用 75ms trailing debounce 重放。
- 清屏和 transcript 重放由 `onReplayOutput(update)` 协调，并使用 CSI `?2026` synchronized output 包围，等待 Ink render flush 后结束，避免暴露中间空帧。
- 启动信息框不再使用 Ink 自动边框/折行：内容区最多 56 cells，总宽最多 60 cells，预留终端最后一列；model 尾部截断，directory 中间截断，每一行显式补齐。
- 抽取 Unicode/emoji 显示宽度及截断工具，输入框与启动信息框共享。
- 已用临时 Windows ConPTY 脚本连续切换 100→72→45→120→58→96 列；最终缓冲区肉眼检查只剩一份启动界面和一个输入提示。脚本未纳入仓库。

## 3. 尚未完成什么

- 所有 v0.1.19 改动和本文件都未 commit、未 push。
- 远程已有 `v0.1.18` tag；`v0.1.19` tag/release 尚未创建。当前机器没有 `gh`，未能直接检查 GitHub Release 页面。
- 最新实现尚未由用户在真实 Windows Terminal 中进行 Ctrl+滚轮验收。
- `runTerminalCommand(..., onOutput)` 的流式快照主要通过 TUI 集成测试覆盖，缺少工具层直接单测。

## 4. 关键架构/设计决定，以及原因

- 保持 Ink inline 模式：`alternateScreen: false`、`incrementalRendering: false`，以保留原生滚轮浏览能力。
- 不把终端 resize 当成新历史：即时 resize 只更新 live composer；75ms 稳定后清理终端并从 `timeline` 重放，避免每个中间尺寸进入 scrollback。
- `History` 使用 `Static`，`timelineEpoch` 只负责强制重新挂载并重放；对话内容的真实来源始终是 `timeline`，不是终端当前画面。
- resize 重放必须通过 `onReplayOutput(update)`：先开启 synchronized output 并清屏，再执行 React state update，最后等待 `waitUntilRenderFlush()` 后关闭同步输出，避免清屏和重绘分属两个可见帧。
- 信息框采用 Codex v0.154.0 的宽度规则（56-cell inner cap、逐行预截断），但保留 Everpeace 的品牌内容；这是在 TypeScript/Ink 中移植行为，不是复制 Rust/ratatui 组件。
- TUI 内的 `!` 命令不再把原始 ANSI/ConPTY 字节直接写到 Ink 管理的 stdout。输出先经过 headless xterm 解释，再以纯文本 snapshot 渲染，避免子进程控制序列破坏父 TUI。
- Windows 的直接命令仍使用 PowerShell；macOS/Linux 使用 Bash。模型请求触发的 Bash 工具仍走原有确认和 terminal suspension 路径。

## 5. 修改过的文件和各自作用

| 文件 | 作用 |
| --- | --- |
| `package.json` | 版本升级为 0.1.19。 |
| `README.md`, `README.zh-CN.md` | 更新版本、60 列信息框、75ms resize 重放和 PTY 流式输出说明。 |
| `src/tools/terminal.ts` | PTY 捕获、headless xterm 渲染、32ms snapshot、2 MiB 捕获上限和可选原始输出。 |
| `src/tui/types.ts` | `runTerminalCommand` 增加可选 `onOutput` callback。 |
| `src/tui/dependencies.ts` | TUI 调用终端时设置 `streamOutput: false`，把 snapshot callback 传入。 |
| `src/tui/app.tsx` | terminal activity、最终输出入历史、source-backed timeline、75ms resize debounce、`onReplayOutput` 协议。 |
| `src/tui/components/history.tsx` | 历史改用 Ink `Static`；终端输出逐行固定高度并截断。 |
| `src/tui/components/banner.tsx` | 手工生成固定 4 行、最大 60 cells 的 model/directory 卡片。 |
| `src/tui/components/prompt.tsx` | 使用共享显示宽度工具；现有单行裁剪/显式换行行为保持不变。 |
| `src/tui/text-width.ts` | 新文件；grapheme cell width、尾部/中间截断和定宽补齐。 |
| `src/tui/index.tsx` | synchronized terminal reset/replay；移除每次 resize 立即清屏的旧 listener。 |
| `tests/unit/tui/app.test.tsx` | 覆盖流式命令输出、resize 后历史恢复、单一 prompt 和 75ms debounce。 |
| `tests/unit/tui/banner.test.tsx` | 覆盖 60-cell 上限、窄窗口固定行宽及不占终端最后一列。 |
| `tests/unit/tui/index.test.ts` | 覆盖 reset sequence、inline render 配置和 synchronized-output 序列。 |
| `docs/HANDOFF.md` | 本交接文件。 |

## 6. 当前已知 bug / blocker / 风险

- 无已知编译或测试 blocker；最大未决项是真实 Windows Terminal 用户验收。
- transcript 重放仍有 75ms 延迟，这是 Codex 式 trailing reflow；composer 会立即缩放，但用户仍可能感知静态区域在 resize 结束后更新一次。
- `TERMINAL_RESET_SEQUENCE` 包含 `CSI 3J`，会删除原生 terminal scrollback，再从内存恢复 Everpeace timeline；Everpeace 会话可恢复，但启动 TUI 前的 PowerShell scrollback 不会恢复。
- synchronized output 依赖终端支持 CSI `?2026`；不支持的终端通常会忽略该序列，可能短暂显示清屏/重绘过程。
- 宽版 ASCII logo 仍是静态 transcript；从宽窗口快速缩到窄窗口时，终端可能在 75ms 重放前短暂重排旧 logo。
- 工具输出最多捕获 2 MiB、headless xterm scrollback 最多 10,000 行；执行中界面只展示最后最多 12 行，最终历史保存捕获到的完整结果。
- Git 仅提示 LF 将转为 CRLF；`git diff --check` 当前无 whitespace error。

## 7. 已执行的测试及结果

- `pnpm test`：51/51 通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `git diff --check`：通过，仅有 Windows CRLF 提示。
- 临时 Windows ConPTY resize smoke test：最终画面只有一份 banner/card 和一个 prompt；不是仓库内自动测试。

## 8. 下一步应该执行的具体步骤

在用户明确恢复工作后：

1. 先运行 `git status --short --branch` 和 `git diff --check`，确认没有覆盖当前未提交修改。
2. 在真实 Windows Terminal 中运行 `pnpm dev`，先产生多轮聊天和一条 `! Get-ChildItem`（或 `! ls`）记录。
3. 验证命令执行时界面不整页刷新、输出持续可见，完成后结果仍在历史中；普通滚轮可以回看。
4. 连续 Ctrl+滚轮放大/缩小并经过窄宽切换，检查顶部卡片不折行、历史未丢、最终仅一个输入框；特别观察 75ms 后是否仍有可见跳变。
5. 若复现问题，优先检查 `app.tsx` 的 resize effect、`index.tsx` 的 replay 原子性和 `History` 的 Static 重挂载，不要重新加入“每次 resize 立即清屏”。
6. 补一个 `runTerminalCommand` snapshot callback 的工具层回归测试，再重新运行 test/typecheck/build。
7. 用户验收后提交全部 v0.1.19 改动并 push `main`。`release.yml` 会在包含 `package.json` 版本变化的 main push 上创建 `v0.1.19` tag 和 GitHub Release；随后检查 Actions 和 Release 是否成功。

## 9. 需要继续遵守的约束

- 当前处于“暂停新功能”状态；未获明确指示前只允许检查和交接，不继续实现。
- 保留当前 dirty worktree，不要 reset、checkout 或覆盖这些修改。
- API key 不从环境变量读取；继续通过 `AuthStorage`/系统 keyring 与 `ModelRegistry` 管理，UI 不显示 base URL 或 key。
- 模型名必须保持供应商官方 model ID，不做自定义重命名。
- 保持 inline TUI 和普通滚轮历史；不要切换到 alternate screen。
- 不允许原始 PTY 控制序列直接写入 Ink TUI stdout。
- 每次正式版本变更都要有对应远程 tag 和 GitHub Release；当前目标版本固定为 v0.1.19，除非用户另行要求。

## 10. 推荐下一轮首先读取的文件

1. `docs/HANDOFF.md`
2. `src/tui/app.tsx`
3. `src/tui/index.tsx`
4. `src/tui/components/history.tsx`
5. `src/tui/components/banner.tsx`
6. `src/tui/components/prompt.tsx`
7. `src/tui/text-width.ts`
8. `src/tools/terminal.ts`
9. `tests/unit/tui/app.test.tsx`
10. `tests/unit/tui/banner.test.tsx`
