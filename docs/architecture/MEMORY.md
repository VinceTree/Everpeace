# Learned Memory

Everpeace 的 learned memory 是本地、分层、可审计的经验存储。它不替代当前 Session context、`AGENTS.md`、仓库证据或用户当前指令，也不使用向量数据库。设计参考 Codex 的“提取与整理分离”原则，但使用 Markdown、JSON 任务文件和普通 Responses 请求适配当前单 Agent 与兼容端点。

## 数据与作用域

- `learned.md` 保存用户级长期偏好；`projects/<workspace-hash>/learned.md` 保存项目经验。
- `capture-jobs.json` 保存待处理、运行中和失败任务；`memory-candidates.json` 保存候选、待审和已合并状态。
- 项目路径规范化后做 SHA-256 哈希，不把原始路径写入文件名。读改写使用 `proper-lockfile` 跨进程锁并通过临时文件原子替换。
- 每个 scope 最多保留 100 条 active 条目。superseded、archived、候选与 review 状态不挤占 active 配额；未合并临时候选保留 30 天。
- 旧 Markdown 条目继续读取为 legacy 来源，不补造验证证据，也不默认回扫旧 Session。

长期条目包含稳定 ID、scope、kind、confidence、status、完整创建/更新时间、适用条件、来源 Session 和最多三个脱敏证据片段。归档条目不会被相同自动提取重新激活。

## 读取与召回

每个逻辑 Agent step 在请求准备阶段生成一个 `MemorySnapshot`：

```text
revision + loadedAt + entryIds + injected text
```

检索词来自当前用户问题和本轮已实际访问的文件，支持中文双字片段、英文词、路径和标识符。只选择 active 条目，并以完整条目为单位装入字符预算；装不下的条目整体跳过，不截断半条规则。普通网络重试复用当前快照，工具 follow-up 或 guidance 进入下一 step 时重新检索。

主 prompt 注入的是带 ID 的短索引，并明确标记为不可信背景。`memory_lookup` 是受 scope 和读取策略限制的只读工具，可按 ID 返回脱敏详情及证据；Plan 模式允许读取。当前聊天关闭 `readExisting` 后，下一 step 不再广告该工具，dispatch 也会拒绝读取。`/memory view` 展示最近一次实际发送的 snapshot，而不是重新读取磁盘形成一个不同视图。

全局开关同时控制 learned Memory 的读取和自动学习；聊天级策略也仅影响 learned Memory。`session_search`、`session_event_search`、`session_event_read`、`session_relations` 和同工作区 `read_tool_output` 属于独立的只读历史能力，关闭 Memory 不会关闭它们；历史记录也不会因此自动成为长期经验。聊天级 `readExisting` / `captureFuture` 通过 `memory_policy_updated` Session 事件保存；`/new` 使用默认策略，`/resume` 恢复原 Session 策略，旧 Session 使用默认值。Session 分支继承该策略；公开 exec 固定读取已有 Memory、关闭本次 capture，不在任务清理后产生提取请求。

## 后台生命周期

前台通过共享 runtime 调用：

- `beginTurn`：暂停 idle timer，取消正在进行的后台请求，并把未开始任务的空闲期向后推。
- `finishTurn`：在 workflow 验证完成后提交结构化 outcome。verified 任务及明确的长期记忆请求可以排队；failed、unverified、cancelled 和受限停止不会把助手自称成功晋升为长期事实。
- `setPolicy`、`clear`、`archive`、`deleteEntry`：提升 runtime generation，取消或隔离旧工作；迟到结果在写入前必须再次通过 generation 与策略检查。
- `dispose`：停止当前 runtime，但保留持久队列供下一实例或进程恢复。

生产默认等待五分钟真实空闲，后台并发为 1，一次空闲最多处理 5 个任务。每个请求 60 秒超时，失败最多重试 2 次；running 任务持有一小时租约，过期后可重新排队。任务 ID 根据 Session、工作区和脱敏后的轮次材料计算，重复提交保持幂等。连续轮次分别进入队列，不再由单个 timer 覆盖。

## 两阶段写入

第一阶段从一个已验证轮次提取最多三条候选，记录 scope、lesson、适用条件、置信度、来源和证据。输入只包含明确用户信息、助手结果摘要与本地可追溯 transcript；网页、MCP 文本和助手自称成功不能单独作为验证依据。

第二阶段先做确定性去重和冲突检查。与 active 条目或同批候选在相同适用条件下冲突的内容进入 review，不注入 prompt。只有同批存在多条非冲突候选时才额外调用普通模型提出合并结果；模型没有工具或文件写权限，程序重新解析、脱敏、限制数量并提交。模型失败时保留原有长期记忆和持久任务状态。

所有输入先脱敏再裁剪，模型输出在保存前再次脱敏。凭据匹配规则通过 [redact-secrets](../../src/util/redact-secrets.ts) 与历史/附件共享，覆盖 JSON/配置形式的 key、token、password、Bearer、常见 token 前缀，以及完整或被截断的 PEM。Memory 保留原有空白清理、标签清理和字段裁剪；历史/附件使用保留换行、缩进与 CRLF 的脱敏函数，再按 UTF-8 字节分页。Memory 请求 usage 单独累计；provider 未返回 usage 时显示 unknown，不计入前台 context 占用、Session 主 usage 或 Goal 预算。

## 安全与兼容边界

- 自动学习不读取历史 Session，不跨项目提升项目事实，也不允许模型直接写 Memory 文件。
- 用户 scope 只接受明确要求长期记住的偏好；其他候选降为 project scope。
- 删除或清空会取消当前后台请求、移除对应任务/候选并提升 generation，避免旧响应回写。
- 文件格式继续兼容旧条目；新增 Session 事件为可选事件，旧 JSONL 不迁移。
- 当前实现不包含向量检索、多 Agent、远程 Memory 服务、通用 hooks 或历史回填。
