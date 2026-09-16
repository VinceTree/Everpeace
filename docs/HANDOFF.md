# Session Handoff

状态快照：2026-09-16。分支 `main`，Session 持久化、`/resume` 和 `/new` 已通过提交 `3600b64` 推送至 `origin/main`；v0.1.20 已通过发布提交 `bab62c4` 正式发布。

## 1. 当前目标

Everpeace 需要提供完整的本地 Session 工作流：

- 普通首问自动创建 JSONL session。
- `/new` 立即创建并进入一个空 session。
- 首问由当前模型后台概括 session 名称。
- `/resume` 恢复完整历史、模型 context、模型和工作目录，并继续聊天。
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

## 3. 关键设计决定

- JSONL 事件包含 `session_created`、`title_updated`、`timeline_entry`、`context_append` 和 `model_selected`。
- timeline 与模型 context 分开保存；直接 `!` 命令可恢复显示，但不进入模型 context。
- `/new` 立即建档；默认首问建档；`/clear` 只解除当前 session。
- `title_pending` 缺失时默认 false，以兼容本轮功能早期生成的 JSONL。
- 标题请求使用当前官方 model ID、无工具且 `store: false`；退出 TUI 时取消未完成的标题请求。
- Session 恢复仍通过 `onReplayOutput` 原子重放，保持 inline 模式和原生 scrollback。
- 跨目录恢复通过 `process.chdir` 切换；失败时回滚并保留当前会话。

## 4. 主要实现位置

- `src/storage/session-store.ts`：JSONL schema、路径、读写、列表、恢复与兼容逻辑。
- `src/agent/react-agent.ts`：初始 context 和增量持久化 callback。
- `src/tui/app.tsx`：session 生命周期、`/new`、`/resume`、命名和工作目录切换。
- `src/tui/components/session-picker.tsx`：名称和时间选择列表。
- `src/tui/dependencies.ts`：默认 SessionStore、标题模型请求及目录切换。
- `tests/unit/storage/session-store.test.ts`、`tests/unit/tui/app.test.tsx`：存储和完整 TUI 流程回归。

## 5. 验证结果

- `pnpm test`：68/68 通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `git diff --check`：通过，仅有 Windows LF/CRLF 提示。
- 尚未在带真实模型凭据的 Windows Terminal 中手工完成 `/new` 与 `/resume` 全流程验收。

## 6. 下一步

1. 在真实 Windows Terminal 中运行 `pnpm dev`。
2. 执行 `/new`，确认立即出现创建提示且 `/resume` 已能看到临时名称。
3. 发送第一条问题，确认正常回答不被标题请求阻塞，并在 `/resume` 中看到模型生成的新名称。
4. 退出并重启，恢复该 session，确认完整历史出现且下一轮回答带有旧 context。
5. 验证跨工作目录恢复、原模型缺失时选择替代模型，以及 `/clear` 仍在下一次提问时才建档。
6. 同时复验 Ctrl+滚轮缩放、普通滚轮、`! Get-ChildItem` 流式输出和单一 prompt。
7. 后续功能改动继续同步更新版本计划、测试状态和相关 docs。

## 7. 继续遵守的约束

- 保留 dirty worktree，不要 reset、checkout 或覆盖现有修改。
- API Key 继续由 `AuthStorage`/系统 keyring 管理，session 文件和 UI 不显示 key。
- 模型名保持供应商官方 model ID。
- 保持 inline TUI；不要切换 alternate screen，不允许原始 PTY 控制序列写入 Ink stdout。
- 每次修改功能、行为、接口或测试状态后，同步更新相关 `docs/` 文档。
- 每个新 Session 先读根级 `AGENTS.md` 和本文件；长期规则放在 `AGENTS.md`，实时状态只更新本文件。
