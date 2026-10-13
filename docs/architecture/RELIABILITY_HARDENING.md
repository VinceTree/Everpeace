# 取消、进程所有权与编辑恢复

本专题对应问题 13–23。当前候选、实际验收和未运行平台见 [HANDOFF](../HANDOFF.md)；原始安全边界见 [SECURITY_HARDENING](SECURITY_HARDENING.md)。

## 流与进程

流消费直接监听任务取消，不等待供应商配合或 idle timeout。关闭、未结束 next、底层 body cancel/read 共用单调时钟截止时间，默认五秒。截止时间到达返回 ModelStreamCleanupError，并永久关闭当前所有者的请求、恢复、重试和工具准入；可靠 usage 仍结算一次。迟到 Promise 被观察，迟到事件不能发布。期限仅保证返回明确故障，不证明无法关闭的第三方资源已经释放。provider dispatcher 和辅助所有者 dispose 同样有界。

Windows 固定辅助程序在 CreateProcess 时通过 PROC_THREAD_ATTRIBUTE_JOB_LIST 将目标加入私有 Job，禁用 breakaway，启用 kill-on-close。目标 stdout/stderr 与 owner-only、本地、随机命名的控制管道分离；句柄继承采用显式列表。命令、argv、cwd、环境通过有界 EPP2 协议传递，不由辅助程序解释任意 shell 文本。原生沙箱仍是模型 shell 的权限执行边界，Job 管理进程生命周期。嵌套不兼容、组件缺失或摘要不匹配拒绝启动。

状态查询与终态收据区分 confirmed_exited、still_running、unknown。正常完成及取消均检查 root 句柄和 Job 活跃成员，父进程提前退出也终止剩余 Job 成员。所有者崩溃触发 kill-on-close，但缺少收据时仍报告 unknown。重复停止共用结果；未知状态阻止后续任务、Goal 和成功 Memory。默认停止期限五秒，不使用短固定延时冒充退出。

模型 shell、后台任务、验证、benchmark、Git、MCP/LSP、搜索及文件 worker 共用 owner；Windows 用户 PTY 通过固定 helper 启动实际 shell，保留输入/resize/呈现。宿主可读取进程内至多 128 条诊断元数据，包含阶段、时长、状态、Win32 错误和身份摘要，不含命令、cwd、环境或输出；不写入 Session。裸 Windows PID 不再授权 taskkill。旧评测 taskkill 128 没有后代身份或终态记录，不能补造历史成功/失败原因。本轮证明提前退出、detached 后代和 owner 崩溃的状态，历史精确根因保持未定位。

显式宿主 MCP 仍需独立授权，也通过同一 owned duplex launcher 管理后代；这不提供沙箱文件或网络限制。Windows launcher 只接受明确的 PE 可执行程序和 argv，裸程序名仅在显式 PATH 中查找，环境名称按 Windows 大小写规则合并，不隐式搜索 cwd。`.cmd`/`.bat` 入口不能直接运行，请配置可核验的解释器及入口脚本；不回退 SDK 宿主 shell。任务取消传入 Git 跟踪、验证依据读取与子包扫描，取消后不启动新的观察进程。

Unix 保留独立进程组；发送 SIGKILL 后有界查询组是否消失，查询失败或期限耗尽保留未知状态与清理故障。关闭等待同样有界，不能据此声称 Windows Job 等价保证。Win32_Process.Create、服务或其他外部执行代理不是普通 CreateProcess Job 后代；full-access/host 例外仍不能被解释成无限隔离保证。

依据：[进程创建属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

源码：[stream consumer](../../src/agent/response-stream-consumer.ts)、[body owner](../../src/providers/response-stream.ts)、[OwnedProcess](../../src/tools/owned-process.ts)、[原生 owner](../../native/process/main.cpp)、[进程完成](../../src/tools/process-completion.ts)。回归：[流期限](../../tests/unit/agent/stream-deadline.test.ts)、[原生进程](../../tests/unit/security/native-process.test.ts)、[清理状态](../../tests/unit/tools/process-completion.test.ts)。

## 搜索和补丁

搜索总输出限制 2 MiB，包括路径重新标注后的结果；达到上限立即停止输入、进程并等待清理，不启动后续文件。返回 incompleteReason: output_limit 或 timeout，清理失败仍为资源故障。有界结果仅保留完整记录。

Unified Diff 严格核对声明与正文旧/新行数、安全整数、零长度范围、文件范围、顺序/重叠和累计新起点，允许不相邻合法 hunks。无末尾换行标记必须位置正确且与原文件匹配。全部操作先解析和预检，错误时零目标写入。

文本文件修改前后最大 16 MiB，最多二十项，单次补丁文本仍为 512 KiB，原始和目标字节合计最多 64 MiB。大文件用小 hunk/唯一 replace；整文件 content 同样受载荷限制。预览单文件至多 64 KiB、整批至多 256 KiB，截断明确标记；审批仍绑定完整版本/身份。原生团队字节整合保留已有单文件与总资源上限，原生普通修改每方向最多 32 MiB；控制 journal 删除有专门容量例外。

## 多文件恢复

多文件提交是逐项条件写入，没有文件系统级原子性，路径仍可能短暂不存在。apply_patch、undo 和团队字节整合共用 ByteChange 批次协调器，结果报告 committed、rolled_back、conflict 或 unknown，逐文件状态不能把已回滚的写入称为当前 applied。

首次目标修改前保存 immutable manifest、原始/目标字节。EPF3 retained 提交在移动原文件之前 flush EPJ3 journal，包含原/安装对象身份、工作区身份、原始/目标字节及 stage 路径；create 和 delete 也记录意图。批次 committed/rolled_back 终态为独占创建的追加记录。批次终态落盘之前保留恢复材料，团队外层状态落盘前也保留内层终态。

失败逆序恢复：必须匹配原版本/身份、实际安装身份，或有效的移动中间状态。每次回滚先追加意图记录，逆向提交也保留安装身份，因此重复恢复可核验上次回滚的实际对象。每文件最多十次回滚意图，超限拒绝继续。用户保存、同字节换对象、损坏/缺失记录都不能授权覆盖。恢复材料受受限 ACL 和工具/搜索/sandbox 路径保护，正文不进 Session。

`everpeace recover-batch <workspace>` 列出摘要；指定 batch-id 预览并在交互终端输入 yes 后恢复。非交互不能恢复；审批前后复核 manifest 摘要。已提交批次只清理材料，未完成批次尝试条件回滚，冲突保留入口和材料。启动只提示，不自动恢复。普通单文件旧 EPJ2 恢复入口继续兼容，缺字段不得推断已完成。

进程强杀、各原生阶段和磁盘失败注入属于可复现证据。真实断电、设备缓存异常、内核/映射写入没有在本机证明；flush 顺序不构成硬件级持久性承诺。

源码：[批次](../../src/tools/file-batch.ts)、[补丁](../../src/tools/apply-patch.ts)、[checkpoint](../../src/workflow/checkpoint.ts)、[团队整合](../../src/team/byte-integration.ts)。回归：[批次故障](../../tests/unit/security/native-batch.test.ts)、[严格补丁](../../tests/unit/tools/patch-integrity.test.ts)、[搜索限额](../../tests/unit/tools/search-limit.test.ts)。

## 权限和验证覆盖

ask 模式中的用户 allow 规则仅免匹配简单命令的普通命令批准。每个链式段分别求值：用户采用最长前缀，同长度 deny > ask > allow；项目限制独立求值，再取更严格结果。read-only、沙箱、网络、敏感外传和 revision 检查不放宽。变量/替换/重定向/解释器无法可靠分类则 ask。

策略存储 v2 兼容 v1。旧 allow 规则带 legacyAllowPending，普通设置修改不会自动激活；在 /permissions 中审阅并确认激活，预览绑定当前 revision。非交互保留 ask。项目 allow 仍被忽略。

Node 验证有界发现嵌套 manifest 和 npm/yarn/pnpm 工作区声明：至多 10,000 路径、32 子 manifest、每份 256 KiB、总子 manifest 1 MiB，扫描超限/声明无法发现报告 unknown。根脚本不证明子包检查。子包变更及共享 manifest/锁文件/工作区配置变更形成覆盖债务；未涉及子包仅报告发现信息。

`/verify --package <relative-path>` 显式在该包 cwd 串行执行实际存在的 typecheck/lint/test/build，首败停止。依据与生命周期脚本同样捕获/复核，审批过期拒绝；仅相同完整工作区 revision 的成功证据解除该包债务。包验证不会独自结算根 suite，后续根验证才能完成。进程内覆盖证明不随恢复重放，持久 Session 保留覆盖诊断及债务。任意 `/verify <command>` 继续只是补充证据。

源码：[coverage](../../src/workflow/verification-coverage.ts)、[basis](../../src/workflow/verification-basis.ts)、[policy](../../src/permissions/policy.ts)。回归：[覆盖债务](../../tests/unit/workflow/verification-coverage.test.ts)、[规则迁移](../../tests/unit/permissions.test.ts)。

## 明确能力限制

团队快照对 submodule_unsupported、lfs_object_missing、snapshot_incomplete、snapshot_changed、resource_limit 返回稳定分类和补救。未物化 LFS 指针拒绝；不初始化子模块、下载 LFS 或执行 checkout filter。普通、linked worktree 和授权子目录继续支持，失败材料保持所有权。

web_fetch 返回 javascriptExecuted: false、static_html/plain_text 提取方式与 contentLimitations。空正文、短脚本壳或明确的 JS 提示仅标记可能需要客户端渲染；启发式不是完整性证明。不新增浏览器或自动导航，真实链接和 SSRF/重定向检查继续适用。

安装需要同平台已核验 file worker 和 process owner，`files:build` 编译两者，`process:smoke` 从 dist 验证真实后代退出；测试输出程序不分发。正式包组件传递和跨平台消费者验收仍按原交付边界执行。
