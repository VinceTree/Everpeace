# 当前交接

## 范围与候选

用户已授权实施问题 20–30、提交推送、更新补丁候选及 GitHub Release；本轮不执行付费模型请求。起点 main `7963b45ca1ef9665fb1dc2e2588c110634f3e650`，实现分支 `codex/verification-privacy-performance` 已通过保护分支流程合并。此前正式 Release 为 v0.5.2，本轮沿用未发布候选 **0.5.3**，冻结 main commit **`f6a857b91e56e78953f4be8d886489ae6a445398`**。旧候选 `8b6888cc1eb0bae682dc1e418d995e47d3b899be` 的任何收据均不作为本轮成功证据；后续交接提交只记录验收，不将文档提交重定义为已验收包的候选。前次问题 11–20 的交接归档见 [历史交接](archive/HANDOFF-2026-10-11-security-diagnostics.md)。

## 实现与保留边界

- 预算界面统一 Request token budget，并区分已知消耗、在途和计量完整性；费用仍为逐请求价格快照估算，不承诺账单硬上限。
- workflow 增加兼容的验证证据：检查类型、TAP/JUnit 数量、改动文件执行覆盖及独立验证。报告绑定本次文件身份和 workspace revision；断言证据保持 unknown，LCOV 文件执行不等于改动行或功能覆盖。项目脚本、模型新增测试和 `/verify` 不冒充宿主外置评分器。
- `/privacy` 和无模型 CLI 提供永久/按天保留预览、跨进程活动租约、扫描、白名单诊断导出及显式脱敏对话导出。默认永久保留；旧记录、安全状态不明、活动及团队成员记录保守跳过。TUI 与 Agent 共享引用计数租约，全部安全关闭后才允许自动清理。测试只使用隔离目录，不删除用户历史。逻辑删除不连带 Memory、凭据、输入历史、团队产物或用户导出。
- 项目 Memory 九十天到期暂停召回；用户长期偏好不自动到期。人工查看来源、纠正、续期、禁用及删除绑定 revision，取消旧操作并使缓存失效；实际 provider 请求及恢复/回退均复核有效性。不把提取 confidence 当事实准确率。
- 团队支持授权子目录及已有 linked worktree，快照仅复制授权子树，保护共享 Git 元数据和兄弟目录。保留并发原始字节检查、冲突产物、取消 ownership；子模块、链接逃逸、二进制整合和超限仍拒绝。
- ReactAgent 分离请求/流恢复、上下文/压缩、工具/文件观察状态；根保留取消、steering、准入、Goal/Memory 与最终清理。公开构造和事件顺序不变。
- `web_fetch` 改有界 DOM 正文抽取，保留标题、列表、引用、代码、表格与来源链接，忽略 base，不加载子资源。十二份有许可的项目技术文档渲染快照比较旧版与新版；外层站点结构明确为合成，不宣称外部网站实测。
- `/perf`、SDK 事件、JSONL 与诊断导出覆盖墙钟、累计/嵌套阶段、请求用途 Token、压缩和重复调用。任务内随机密钥摘要只在内存保留；记录无路径、命令或参数，未知数据不补零，晚到请求由 generation 隔离。
- 固定 fast-check 的七类安全不变量、日检扩大用例与可重放报告；专用 Windows native 必需验收新增子目录/linked worktree 隔离用例。修复及 single/team 分别准备十九任务、每臂三次的配对实验，保留计划分母。生产三轮上限与默认单 Agent 不变。

契约、源码与测试入口见 [验证、隐私与性能专题](architecture/VALIDATION_PRIVACY_PERFORMANCE.md)。

## 验证记录

本轮证据根：`C:\Users\39850\AppData\Local\Temp\everpeace-observability-a5fd694c54a64dcaae58b25d28bc184a`。最终本地串行 `typecheck → lint → test → build` 全部通过：1235 tests，1232 pass、3 skip、0 fail；`gate-7.json` 与 `gate-7-*.log` 保存命令、退出码及实际输出，`git diff --check` 和改动文档链接检查通过。跳过不作为原生验收成功；不将旧候选收据迁移为最终成功。

已完成的定向证明包括真实原生团队子目录与 linked worktree、跨进程 Session 租约/隐私、Memory 到期和请求重试失效、流恢复与新状态子系统、TUI/真实 PTY 确认取消 Esc resize、脱敏 JSONL、DOM 对照与安全日检。日检八个属性测试全部完成规定次数，无 skip；纯属性每项一万例、状态序列每项一千例，报告保存 seed 与重放信息。锁文件审计、Secret/许可证/SBOM 本地共享安全检查通过。十二份网页正文块新版 F1 为 1，八个标准代码块逐字保留；这只证明固定语料。中间两次完整门禁均通过，最终冻结重新执行，实际数量以最终收据为准。

九项扩展评分器基线、缺陷及参考修复全部证明通过，见 `expanded-final/expanded-proof.json`；真实模型请求零次。`experiments-main/frozen-protocol.json` 与四个配置绑定冻结 main 候选，修复及团队各计划 114 次运行，四个无凭据生产 preflight 全通过；源码变化后必须重新生成 source/build/evaluation 身份，不将预算草案视为执行授权。第 21、26 的真实收益及 Memory 模型效果仍未完成；任务专属错误修改分类缺乏独立证据时 rate=null、eligibleForDefault=false，不从 Agent 自评补造。

## 交付与外部依赖

实现和三个状态子系统分批提交，[PR #8](https://github.com/VinceTree/Everpeace/pull/8) 的 [最终检查](https://github.com/VinceTree/Everpeace/actions/runs/38149728289) 两平台、安全及 Required checks 全部成功后合并；冻结 main 的 [完整 CI](https://github.com/VinceTree/Everpeace/actions/runs/38150034870) 同样全部成功。失败记录保留：首轮修正 CRLF 快照摘要、Windows 短路径别名导出与 Worktree 注销，打包使用规范化补丁副本，不修改补丁语义；第二轮两平台捕获相同成员归属写入竞态，修正同进程重复操作的等待，十六次并发发布及生产 preflight 回归通过。

[独立候选验收](https://github.com/VinceTree/Everpeace/actions/runs/38150067516) 的 candidate、Windows/Linux 检查、security、package、两平台三种消费者安装及 evidence 全成功，均绑定冻结 commit。Linux 干净构建包 `everpeace-0.5.3.tgz` 的 SHA-256 为 `fe4586e4a2c49445cf9d79db3812b84471924e45fca78a455a889a8a53b97411`；锁文件摘要 `01ee6393d2fdf7645157eab38abe6595c0cb64b11d897ee8c72cdbe8c0aeadf0`。实际安装版本、许可证、SBOM、原生二进制及摘要以该 run 的 `verified-evidence/supply-chain.json`、`receipt.json` 和消费者收据为准。已下载候选包到证据根 `candidate-main-package`，本地重新校验准确 commit、平台、clean 状态与 tarball 摘要成功。本机 `package-final-2` 的三种安装、PTY 输入/resize/取消及清理也通过，但那是中间开发包，不替代准确 main 的收据。

专用 Windows 机器未准备，GitHub Runner 回读数量零，RUNNER_READ_TOKEN 未配置。候选 availability 实际失败，错误为 `Configure RUNNER_READ_TOKEN with repository administration read permission`；native skipped、gate failure、publish skipped，未创建 tag/Release。用户选择先完成代码和 [部署说明](WINDOWS_RUNNER.md)；该环境及其真实 native 验收未通过前禁止发布，不以本机测试、hosted skip 或旧候选成功代替。环境准备后重新执行冻结候选的完整 Release 工作流，核对全部必需结果；任何代码变化重新冻结，不手工绕过。

保留原有 untracked `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`。没有付费模型/Brave 请求，没有 npm registry 发布。后续真实模型实验另需端点、供应商原始模型 ID、凭据及 task/campaign 数值预算。
