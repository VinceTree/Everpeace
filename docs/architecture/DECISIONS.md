# Architecture Decisions

状态快照：2026-09-16。

## Session 持久化

- 每个 session 使用一个版本化 JSONL 文件，存放于平台应用状态目录；API Key 仍只进入系统 keyring。
- 可见 timeline 与 Responses API context 分开记录，保证恢复界面完整，同时不把直接 `!` 命令错误加入模型上下文。
- 写入按 session 串行追加；不完整末行可忽略，其他损坏只隔离对应文件。
- `session_created` 保存模型引用和工作目录；`model_selected` 表达模型变化及是否重置 context。

## Session 生命周期

- 默认采用延迟创建：没有活动 session 时，第一次普通提问先建档再请求模型。
- `/new` 是显式立即创建：要求已有活动模型，写入临时标题“新 Session”并立刻切换到新 timeline/context。
- `/clear` 不等同于 `/new`：它只清屏并解除当前 session，下一次普通提问才创建文件。
- 切换 session 不需要丢弃确认，因为所有活动内容持续写入本地文件。

## 标题状态

- `/new` 创建的空 session 使用 `title_pending: true`；该状态持久化，因此空 session 经 `/resume` 后仍会由第一条问题命名。
- 首问先写入截断后的可靠回退标题并清除 pending，再并行执行无工具、`store: false` 的模型标题请求。
- `title_updated` 始终把 pending 状态置为 false；旧 JSONL 没有该字段时默认 false。
- 标题限制为单行 60 display cells，并移除常见 Markdown、引号和结尾标点。

## 恢复行为

- `/resume` 全局列出 session，按最后活动时间倒序显示“名称 + 时间”。
- 优先恢复 session 当前模型；模型缺失时允许选择替代模型并保留 context。
- 恢复其他项目时自动切换到原工作目录；目录不存在则拒绝恢复并保留当前会话。
- transcript 重放继续使用现有 synchronized output 和 source-backed timeline，不改变 inline TUI 与普通滚轮行为。

## 维护约束

- 功能、行为、接口或验证结果发生变化时，同步更新 `docs/PLAN.md`、本文件及 `docs/HANDOFF.md` 中受影响的内容。
- 根级 `AGENTS.md` 只保存跨 Session 长期有效的项目事实和工作约束；易变化的进度、验证结果及下一步统一记录在 `docs/HANDOFF.md`。
