# Everpeace Current Plan

状态快照：2026-09-18。

## 当前目标

Codex 核心 Agent Loop TypeScript 适配已接入：独立轮次控制、逐工具结果持久化、采样重试和取消、完成判断、并发 turn 防护。上游来源与未移植模块见 `architecture/AGENT_LOOP.md`。

完成终端交互改进：Ctrl+C 取消、跨重启输入历史、Shift+Enter 配置、统一紧凑命令输出与 `/outputs`。不新增 OS 沙箱，也不实现 Ctrl+R、任务队列或外部编辑器。

权限管理第一阶段：Codex 官方文档摘录与对标、`/permissions`、模型工作目录文件查看和工具运行时审批。见 `architecture/PERMISSIONS.md`。本轮不宣称实现 OS 沙箱；pi/Grok Build 后续再比较。

提供可持久化、可恢复、可继续对话的本地 Session：

- 每个 session 使用独立 JSONL 文件保存可见 transcript 和模型 context。
- 首次普通提问自动创建 session，并由当前模型在后台生成名称。
- `/new` 立即创建并进入一个新 session；第一次提问后替换临时名称。
- `/resume` 列出本机全部 session，恢复模型、工作目录、历史和上下文。
- `/clear` 只退出当前 session，下一次普通提问时再创建新记录。
- `/status` 在独立命令窗口中显示当前模型、provider、context 和 session token usage；窗口隐藏原会话内容，Esc 原子恢复原 Session，usage 累计持久化，窗口不进入 session。
- 为 DeepSeek、OpenAI 和自定义兼容端点提供普通 function call 形式的网页搜索和公共页面读取，使模型可以回答依赖最新网络信息的问题。

## 已完成

- [x] `/resume` 从会话恢复输入导航并清空草稿，召回斜杠命令不抢占方向键。
- [x] 修复恢复上下文中的缺失工具结果；工具异常返回结构化结果，避免后续请求出现缺失 output 的 400。

- [x] Ctrl+C 取消模型请求、审批等待和运行命令；取消后的工具调用补齐结果，下一轮可继续。
- [x] 全局输入历史、上下键草稿恢复、多行粘贴和 `/history` 清理。
- [x] `/terminal-setup` 显式确认、JSONC 保留、冲突拒绝、备份及过期预览检查。
- [x] 模型 Bash 运行时有界保留并展示真实首五行/尾五行，矮终端自适应缩减；直接 `!` 保持尾部预览，完成后折叠并由 `/outputs` 提供分页详情。
- [ ] 真实 Windows Terminal 手动验收键位、复制、缩放、resize 和带凭据模型的完整流程。

- [x] 应用层 ask/read-only/full-access 模式，完全访问二次确认，网页工具独立开关。
- [x] `read_file` / `list_directory` 路径校验、内容上限、结构化失败返回。
- [x] 权限独立窗口；切换不清空 context、不向 JSONL 写入授权。

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
- [x] 新增 `web_search` 和 `web_fetch`，支持搜索结果摘要、网页正文提取、来源 URL、失败降级和取消信号。
- [x] 网页读取限制为公共 HTTP/HTTPS，逐次验证重定向并阻止 localhost、内网和链路本地地址。
- [x] 搜索采用 Bing 优先、DuckDuckGo 回退，不额外要求搜索服务 API Key。

## 验收与后续

- 自动验证目标：完整测试、类型检查、构建和 diff 检查全部通过；最新实际结果记录在 `HANDOFF.md`。
- 待在真实 Windows Terminal 中验证 `/new` → 首问命名 → 退出 → `/resume` → 继续聊天。
- 待使用真实 OpenAI、DeepSeek 和自定义兼容端点复验 `/status` usage 返回、context 映射、居中与窄终端排版，以及 Esc 返回原 Session。
- v0.1.24 已发布；Release workflow、annotated tag 和 GitHub Release 均已确认成功。

## 文档规则

后续每次修改功能、行为、接口或测试状态时，必须在同一批改动中更新相关 `docs/` 文档；至少检查本文件、`architecture/DECISIONS.md` 和 `HANDOFF.md` 是否需要同步。
