# 当前交接

2026-11-02：实施用户确认的 Memory 八项缺陷修复。开始时分支 `codex/source-candidate-evidence-2026-11-01`，HEAD `5c2865c`，工作树干净；沿用现有 checkout，未读取真实用户 Memory 或凭据。当前展示版本保持 `0.6.0-rc.4`。上一轮交付记录移至 [交接归档](archive/HANDOFF-2026-11-01-source-candidate.md)，其中历史测试结果不代表本轮验证。

用户最新授权为完成后自动提交并推送，提交使用 `[skip publish]` 保留 CI；不付费调用模型、不改展示版本、不打 tag、不创建 Release、不合并其他 PR。

## 实现范围

- 完整共享脱敏后再清理、裁剪，入队、提取、合并、保存和读取保持幂等。旧部分脱敏内容整字段遮罩并暂停召回，要求人工纠正。
- 自动学习严格要求 verified；关键词无豁免，旧队列同样拒绝非 verified。独立 `/remember` 兼容 `/memory remember`，保留取消、全局开关和计量。
- 新增持久 scope epoch 和 store 控制锁，网络不持锁，提交检查 epoch、策略和租约；清空及人工变更以事务意图为提交点，中断后读写先恢复。user 清空跨工作区，project 清空限定当前项目，混合任务保留有效 scope 和 pending/unknown 用量证据。
- 新增、续期、纠正统一 active 上限，过期和最旧 active 优先归档；去重保留 ID 与到期时间。预览失效等业务错误可恢复，真实存储和清理故障仍关闭所有者。
- 合并后规范化并在控制锁内重查当前条目和同批冲突。CLI/TUI 候选列表、详情、预览、接纳、纠正、拒绝闭环；默认 Cancel，原子 supersede 冲突规则并保存来源、多条替代关系及候选结算，拒绝不能被重试重新激活。
- 同步中英文 README、使用指南、命令帮助及 [Memory](architecture/MEMORY.md)、[计划](PLAN.md)、[设计决策](architecture/DECISIONS.md)。

## 验证结果

所有新增回归使用合成临时目录、离线模型响应和受控子进程。新 hardening 覆盖秘密、验证门槛、容量、恢复业务错误、跨 runtime 和两个真实进程的延迟提交、全局清空、混合 scope、冲突、候选审查、中断清理和中断接纳恢复、控制文件损坏。回归入口为 [hardening](../tests/unit/memory/hardening.test.ts)、[CLI](../tests/unit/cli/memory-review.test.ts) 和 [TUI](../tests/unit/tui/app.test.tsx)。

最初检查发现两个 unused 参数与新 fixture 的三个 unused 变量，以及未本地化 CLI 错误和菜单命令字面量，已修正；首次候选 TUI 回归的窗口退出时序已修正。补查发现公开配置表达式被裁剪后再次脱敏会变化，加入有界稳定化和边界回归；提取输出进一步限制声明字段和合法类型，回归检查任务中间文件也不含合成秘密。后续完整检查以最终门禁为准。

裁剪补强前的四门禁通过，证据保留在 `.cache/memory-hardening/before-truncation/`。补强后首轮完整 test 的既有 MCP stdio 用例在 after hook 的 `McpRuntime.close()` 报清理未结束，按首败规则未启动 build，日志保留于 `mcp-cleanup-failure/`。相同用例随后连续三次单独运行均通过，暂未再次复现，见 `mcp-cleanup-{1,2,3}.log`；未修改 MCP 实现、超时或清理断言。该次失败不能被定向结果替代，重新运行完整门禁。

随后在检查恢复准入时发现，非 verified 的旧 running job 缺少结算标记也必须维持 unknown。中断当时测试后补齐恢复判断及四种旧 outcome 回归，保留中断收据于 `interrupted-for-recovery/`；中断不记为成功。最终结果以完成本项补强后的整轮门禁为准。

最终在 Node 22.19.0、pnpm 10.30.3 下重新发现实际脚本，串行执行 typecheck → lint → test → build，四项全通过，耗时约 2.14、1.33、385.73、2.66 秒。全量 1413 项中 1410 pass、3 个既有环境／平台 skip，零失败／取消；skip 分别为文件 symlink 不可用、Windows 临时目录 alias 的 CI 覆盖和 Unix child 超时回归。日志 `.cache/memory-hardening/gate-{typecheck,lint,test,build}.log`、`gates.json`。

最终 903 份源码／测试／脚本／原生组件／manifest 与 lock 输入在门禁前后完全一致，SHA-256 `09a8db51c52ad583d76355e73921e973f7830e094e85ae8b3bd1e79d5282d905`，收据 `identity.json`。Memory／runtime／CLI／脱敏定向 130/130 通过，见 `targeted-final.log`；TUI 审查、取消和生产关闭定向 8/8 通过，见 `tui-final.log`。补强后的整轮全量测试也通过之前失败的 MCP 用例，未调整其实现或断言。

本轮实现与测试完成后只更新文档收据。补充检查通过：959 项双语文案及插值、169 份公开文档路径／链接、构建后 Memory CLI 帮助和 `git diff --check`，见同目录 `{ui-verify,docs-verify,cli-help,diff-check}.log`。门禁不代表真实 Windows Terminal、Linux、付费模型提取质量或远端 CI 已验收。没有迁移或批量重写真实用户存储。

## 交付

按用户最新授权提交并推送当前分支，使用 `[skip publish]`，不使用 `[skip ci]`。已核对 Release workflow 仅接受显式 workflow_dispatch，本轮不触发发布、不改展示版本、不创建 tag 或 Release。提交身份和推送结果以当前分支 Git 记录及远端 ref 为准；本地证据保存在 `.cache/memory-hardening/`，不把原始日志加入仓库。
