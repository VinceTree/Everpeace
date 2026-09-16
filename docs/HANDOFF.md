# Session Handoff

状态快照：2026-09-16。分支 `main`，Session 持久化、`/resume` 和 `/new` 已通过提交 `3600b64` 推送至 `origin/main`；v0.1.20 已通过发布提交 `bab62c4` 正式发布。

## 1. 当前目标

Everpeace 需要提供完整的本地 Session 工作流：

- 普通首问自动创建 JSONL session。
- `/new` 立即创建并进入一个空 session。
- 首问由当前模型后台概括 session 名称。
- `/resume` 恢复完整历史、模型 context、模型和工作目录，并继续聊天。
- 输入开头的 `/` 显示可筛选、可键盘操作的 slash command 菜单。
- `/status` 使用 Codex 风格卡片展示当前版本、模型、供应商、Base URL、目录、session 和 token/context 用量。
- 保留既有 inline TUI、PTY 流式输出和 resize 稳定性行为。

## 2. 已完成

- 新增每 session 一个文件的版本化 JSONL SessionStore。
- 保存可见 timeline 和继续请求所需的 Responses context，不保存 API Key 或瞬时 UI。
- Session 文件按 ID 串行追加；列表按最后活动时间倒序；损坏文件隔离，不完整末行容错。
- ReactAgent 支持初始 context 和 context append callback，恢复后可继续完整对话。
- 首次普通提问先创建 session，再并行执行正常回复和标题生成。
- `/resume` 可查看本机全部 session，恢复原模型、原工作目录、timeline 和 context。
- 原模型不可用时可选择替代模型并保留 context；原目录不存在时不破坏当前会话。
- `/new` 要求活动模型，立即创建临时名为“新 Session”的记录、清屏并进入新 session。
- `/new` session 使用持久化 `title_pending`；首次提问或恢复后的首次提问会在同一 session 内完成命名，不重复建档。
- `/clear` 保持延迟创建语义，不作为 `/new` 的别名。
- 中英文 README、CLI/TUI help、PLAN 和架构决定已同步。
- `package.json` 与中英文 README 展示版本已提升至 v0.1.20。
- Release workflow 运行 `35097961255` 成功；`v0.1.20` tag 指向 `bab62c4`，GitHub Release 已发布且不是 draft/prerelease。
- 根级 `AGENTS.md` 已替换临时内容，集中记录新 Session 的启动顺序、架构不变量、关键代码入口和交付规则。
- Slash command 菜单在输入区下方按前缀实时筛选；最多显示八项，支持滚动选择、Enter 执行、Tab 补全和 Esc 关闭。
- 新增 `/status`：官方 Base URL 与 model 映射供应商和 context window；自定义或未知端点安全显示 `N/A`。
- 主 Agent 每次 Responses API 请求的 usage 都会累加并写入 session；工具循环中的中间响应也计入，后台标题请求不计入。
- 切换模型保留 session 累计输入/输出 token，并重置当前 context；旧 session 或兼容端点缺少 usage 时显示为不完整统计。
- `/status` 卡片作为结构化 timeline 条目写入 JSONL，退出并 `/resume` 后仍可原样恢复。

## 3. 关键设计决定

- JSONL 事件包含 `session_created`、`title_updated`、`timeline_entry`、`context_append`、`model_selected` 和 `usage_recorded`。
- timeline 与模型 context 分开保存；直接 `!` 命令可恢复显示，但不进入模型 context。
- usage 在 session 范围内累计；模型切换保留累计输入/输出并重置 context，缺失 usage 的响应会把统计标记为 partial。
- `/status` 只读取当前状态，不会单独创建 session；有活动 session 时，其快照会进入可恢复 timeline。
- 供应商和 context window 仅按已知的官方 Base URL 与 model ID 映射；自定义兼容端点不猜测上限。
- `/new` 立即建档；默认首问建档；`/clear` 只解除当前 session。
- `title_pending` 缺失时默认 false，以兼容本轮功能早期生成的 JSONL。
- 标题请求使用当前官方 model ID、无工具且 `store: false`；退出 TUI 时取消未完成的标题请求。
- Session 恢复仍通过 `onReplayOutput` 原子重放，保持 inline 模式和原生 scrollback。
- 跨目录恢复通过 `process.chdir` 切换；失败时回滚并保留当前会话。
- Slash command 候选复用 `SLASH_COMMANDS` 作为唯一命令源；筛选逻辑保持纯函数，菜单不引入额外 `useInput` 监听器。

## 4. 主要实现位置

- `src/storage/session-store.ts`：JSONL schema、路径、读写、列表、恢复与兼容逻辑。
- `src/agent/react-agent.ts`：初始 context 和增量持久化 callback。
- `src/status/model-status.ts`：Base URL/provider/context 映射、usage 累加与 status snapshot 类型。
- `src/tui/app.tsx`：session 生命周期、`/new`、`/resume`、命名和工作目录切换。
- `src/tui/components/status-card.tsx`：Codex 风格 `/status` 方框、窄终端截断和 token 格式化。
- `src/tui/components/session-picker.tsx`：名称和时间选择列表。
- `src/tui/dependencies.ts`：默认 SessionStore、标题模型请求及目录切换。
- `src/tui/commands.ts`、`src/tui/components/prompt.tsx`：slash command 筛选、菜单渲染和键盘交互。
- `tests/unit/status/model-status.test.ts`、`tests/unit/tui/status-card.test.tsx`：映射、累计和卡片布局回归。
- `tests/unit/storage/session-store.test.ts`、`tests/unit/agent/react-agent.test.ts`、`tests/unit/tui/app.test.tsx`：存储、usage 回调和完整 TUI 流程回归。

## 5. 验证结果

- `pnpm test`：84/84 通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `git diff --check`：通过，仅有 Windows LF/CRLF 提示。
- 尚未在带真实模型凭据的 Windows Terminal 中手工完成 `/status`、`/new` 与 `/resume` 全流程验收。

## 6. 下一步

1. 在真实 Windows Terminal 中运行 `pnpm dev`。
2. 完成一次真实模型问答后执行 `/status`，核对 Model、Provider、Base URL、Context window、Input tokens 和 Output tokens。
3. 触发一次工具调用，确认工具循环的多次响应累计；切换模型后确认总输入/输出保留而 context 重置。
4. 使用自定义兼容端点或缺少 usage 的响应，确认未知 provider/context 显示 `N/A` 且 TUI 不崩溃。
5. 退出并 `/resume`，确认历史 status 卡片和累计 usage 恢复；同时复验 `/new`、标题生成和旧 context 延续。
6. 验证跨工作目录恢复、原模型缺失时选择替代模型，以及 `/clear` 仍在下一次提问时才建档。
7. 同时复验 Ctrl+滚轮缩放、普通滚轮、`! Get-ChildItem` 流式输出、单一 prompt 和窄终端 resize。
8. 在真实终端输入 `/`，复验八项窗口滚动、逐字筛选、Enter 执行、Tab 补全和 Esc 关闭。
9. 后续功能改动继续同步更新版本计划、测试状态和相关 docs。

## 7. 继续遵守的约束

- 保留 dirty worktree，不要 reset、checkout 或覆盖现有修改。
- API Key 继续由 `AuthStorage`/系统 keyring 管理，session 文件和 UI 不显示 key。
- 模型名保持供应商官方 model ID。
- 保持 inline TUI；不要切换 alternate screen，不允许原始 PTY 控制序列写入 Ink stdout。
- 每次修改功能、行为、接口或测试状态后，同步更新相关 `docs/` 文档。
- 每个新 Session 先读根级 `AGENTS.md` 和本文件；长期规则放在 `AGENTS.md`，实时状态只更新本文件。
