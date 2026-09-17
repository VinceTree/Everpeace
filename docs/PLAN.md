# Everpeace Current Plan

状态快照：2026-09-17。

## 当前目标

提供可持久化、可恢复、可继续对话的本地 Session：

- 每个 session 使用独立 JSONL 文件保存可见 transcript 和模型 context。
- 首次普通提问自动创建 session，并由当前模型在后台生成名称。
- `/new` 立即创建并进入一个新 session；第一次提问后替换临时名称。
- `/resume` 列出本机全部 session，恢复模型、工作目录、历史和上下文。
- `/clear` 只退出当前 session，下一次普通提问时再创建新记录。
- `/status` 在独立命令窗口中显示当前模型、provider、context 和 session token usage；窗口隐藏原会话内容，Esc 原子恢复原 Session，usage 累计持久化，窗口不进入 session。

## 已完成

- [x] SessionStore、跨平台存储路径、串行追加和损坏文件隔离。
- [x] Agent context 导入及增量持久化。
- [x] 后台模型命名、标题清洗及失败回退。
- [x] `/resume` 选择器、原模型恢复、替代模型和跨目录恢复。
- [x] `/new` 立即建档、切换界面和 `title_pending` 首问命名。
- [x] JSONL 旧格式兼容：缺少 `title_pending` 时按已命名处理。
- [x] 中英文 README、CLI/TUI help 和 docs 同步。
- [x] 根级 `AGENTS.md` 汇总新 Session 必读的长期项目知识和工作约束。
- [x] 输入开头的 `/` 打开实时前缀筛选菜单，最多显示八项并支持键盘选择、执行和补全。
- [x] 主 Agent Responses usage 采集、JSONL 增量持久化和 `/resume` 恢复。
- [x] `/status` Codex 风格状态方格、官方 base URL/model context 映射及兼容端点安全降级。
- [x] 信息型命令和选择型 picker/wizard 使用独立命令窗口，隐藏 banner、历史、composer 和全局状态栏，并通过 Esc 原子恢复 Session。
- [x] 异步命令使用独立加载窗口；Esc 返回后忽略迟到结果，resize 时继续保持历史隐藏。
- [x] 所有独立命令窗口使用共享的水平、垂直居中布局，最大 80 列，并在窄终端自适应安全边距。
- [x] Slash command 界面与可恢复 transcript 分离，不写入 JSONL 或模型 context。

## 验收与后续

- 自动验证目标：完整测试、类型检查、构建和 diff 检查全部通过；最新实际结果记录在 `HANDOFF.md`。
- 待在真实 Windows Terminal 中验证 `/new` → 首问命名 → 退出 → `/resume` → 继续聊天。
- 待使用真实 OpenAI、DeepSeek 和自定义兼容端点复验 `/status` usage 返回、context 映射、居中与窄终端排版，以及 Esc 返回原 Session。
- v0.1.21 已发布；Release workflow、annotated tag 和 GitHub Release 均已确认成功。

## 文档规则

后续每次修改功能、行为、接口或测试状态时，必须在同一批改动中更新相关 `docs/` 文档；至少检查本文件、`architecture/DECISIONS.md` 和 `HANDOFF.md` 是否需要同步。
