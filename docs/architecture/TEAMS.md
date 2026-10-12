# 多 Agent 协作

## 产品与入口

协作默认关闭，开启后仍由一个根 CodingTaskRunner 决定任务是否完成。TUI `/team`、CLI `exec --team` 和 SDK `runTask({ team: {} })` 共用 production 的 TeamRuntime；没有第二套 UI 调度循环。默认最多三个活动 Agent（根加两个成员），范围 1–3；根当前模型不变，explorer、worker、reviewer 可分别绑定注册 ID，未设置则继承根模型。注册、凭据、Responses profile 和请求设置先校验并冻结；不静默换模型。

只有根拥有 spawn_agent、list_agents、wait_agents、send_agent_message、cancel_agent、integrate_agent。成员不递归委派、不完成根 Goal、不写成功 Memory、不直接调用 MCP。explorer/reviewer 使用只读工具和独立 Plan context；worker 使用隔离工作区与自己的 coding runner。根 Plan 禁止 worker 和整合。非 Git 项目仍允许只读成员。

任务必须指定目标、验收、相对文件范围、依赖成员 ID，可以附必要约束与有来源摘要。传递当前用户任务、最新 guidance 和原项目规则快照，不复制根完整会话或 opaque reasoning。上下文、摘要、证据读取与任务数量均有界；list_agents 的 include_evidence 必须指定单个成员。报告属于不可信证据，不能提升权限或授予写授权。

## 调度、整合与验证

依赖只读成员完成，或编码成员完成整合后才启动后续任务。重叠编码范围串行，Windows 范围比较忽略大小写。取消单个成员不取消独立成员；根取消、权限 revision 改变、存储或清理故障向团队传播，迟到结果不发布成功。用户 steering 使受影响的旧 worker 失去自动整合资格，新任务仍可按当前指导委派。

编码支持 Git 根及授权子目录、已有 linked worktree，宿主在 TEMP/everpeace-teams 下创建 detached worktree，不创建用户提交、不碰用户 index。HEAD 清单、tracked 字节/删除及非 ignored 普通 untracked 只枚举授权子树；gitRoot/workspacePrefix 映射参与恢复及整合。不运行 checkout filter，不共享可写 node_modules，不硬链接源文件。外部链接、子模块、数量／大小上限或快照不完整明确拒绝。依赖只能在成员目录按当前命令权限独立准备；需要授权子树外文件时明确报告限制。[布局与验收](VALIDATION_PRIVACY_PERFORMANCE.md)。

HEAD 在快照前解析为不可变 commit，文件复核期间 HEAD 改变则拒绝；之后创建 worktree 和初始化成员 index 都使用捕获的 commit。Windows Git 调用显式启用 core.longpaths，不修改用户 Git 配置；文件枚举报告不完整时拒绝快照，保留中文路径、BOM 和 CRLF 原始字节。

每个 worker 启动 Session/provider 前必须通过固定原生后端的真实隔离探测：cwd 在成员目录、本目录可写、主工作区不可写、其他成员不可读写、宿主 ownership 记录及 Git 公共 config 不可读。团队 profile 基于 read-only，仅授予自己的写目录；从宿主所有的非 Git 父目录启动，避免 Git 自动推导授权。Windows 使用成员 PSDrive，Linux 显式 cd；nonce 绑定的产物证明实际执行。探测失败关闭，无宿主执行降级。

完成后宿主冻结变更清单与目标字节 hash。整合串行：范围、受保护路径、原快照和当前文件必须匹配；当前已经等于目标则幂等完成，否则冲突保留产物。仅处理 apply_patch 当前支持的文本变更，复用 preview、原字节版本、审批 revision、checkpoint 和回滚。不会覆盖用户并发修改或自动插入冲突标记。超过单批限制需要重新拆任务。

integrationId 与目标 hash 在写入前持久化；重启不盲目重放。子项目检查仅是成员证据；整合收束后根 runner 重新发现并执行 typecheck → lint → test → build，首败停止，沿用三轮修复。只有根完整验证成功才能完成 Goal、捕获成功 Memory、回收已整合工作区。

## 总账与恢复

TeamLedger 是唯一总账，成员只持有不可 reset 的计量 scope。真实请求，包括重试、压缩和修复，只累计一次；reasoning 属于 output，不重复扣除。根 Session 累计成员消耗但不把成员输入当成根 context estimate。Goal 以持久化的起始累计加团队总量结算，重复恢复不重复扣款。

默认总计 96 provider attempts、30 分钟，可在任务前调整，与根更严格限制取最小值。可选 token budget 使用输入估算加固定输出上限集中预留；不足时等待已准入请求结算，再决定停止，不降低设置。预算是请求准入约束，不是供应商账单硬上限。unknown 为永久缺口，关闭新请求；成功样本不能覆盖。真实请求前先落盘 in-flight ID，进程崩溃无法结算时恢复为 unknown。

TeamStore 原子保存任务、成员、模型绑定摘要、usage、in-flight、整合 ID 与 elapsed，并以 exclusive PID/nonce 锁拒绝另一个活跃宿主认领。Session 仅保存团队引用，成员各自保存 context/timeline；关系与 fork lineage 分开，普通历史工作区边界不放宽。凭据、旧审批和验证正文不进团队元数据。

重启后 running/queued 标 interrupted，产物保留。用户显式继续时重新检查 Session/工作区、当前模型/profile、权限和文件状态；不恢复旧审批或旧请求。TUI 选 Continue 后须提交新 guidance；CLI/SDK 需 root Session 与 resumeTeamId。unknown 不能靠继续清空。成功回收属于本团队的工作区；失败、中断、冲突产物通过 /team 明确清理，不能清用户目录。

## UI、事件与边界

/team 是英文独立命令窗口，/team <team-id> 在所属根 Session 打开旧团队产物，空闲修改启用、模型、名额、token/attempt/time；详情显示任务、模型、状态、消耗、文件、证据和保留目录，c 取消、d 清理。Esc 返回同一 Session，保持 inline、原生 scrollback 和单 prompt。根聊天显示成员里程碑，完整成员正文不混播。审批同队列，显示成员、动作、目录并绑定 revision。非交互入口需要回答或审批时先收束，再返回 interaction_required；仅根发布最终状态。

协作 JSONL 使用 schema_version 2，团队事件带 teamId/agentId/taskId；关闭协作的原 v1 保持兼容。TeamSnapshot 自身持久格式 version 1 与 JSONL schema 不同。

首版不含递归团队、成员自由互调、远程执行、Web/Desktop、OAuth 或插件市场。离线固定任务只验证流程和独立断言，不证明真实模型更快、省 token 或成功率更高。付费对照需要独立数值授权；当前实机证据及限制见 [HANDOFF](../HANDOFF.md)。

## 源码与回归

- [runtime](../../src/team/runtime.ts)、[ledger](../../src/team/ledger.ts)、[store](../../src/team/store.ts)、[workspaces](../../src/team/workspace.ts)、[isolation](../../src/team/isolation.ts)、[tools](../../src/team/tools.ts)。
- [shared production](../../src/runtime/production.ts)、[root runner](../../src/workflow/task-runner.ts)、[Session](../../src/storage/session-store.ts)。
- [team panel](../../src/tui/components/screens/team-surface.tsx)、[exec](../../src/exec/runtime.ts)、[SDK](../../src/sdk/index.ts)。
- [team regressions](../../tests/unit/team/team.test.ts)、[panel regressions](../../tests/unit/tui/team-surface.test.tsx)、[offline comparison](../../tests/fixtures/team-comparison.ts)、[real terminal fixture](../../tests/fixtures/tui-offline.ts)。
