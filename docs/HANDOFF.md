# 当前交接

## 范围与候选

用户授权实施问题 11–20，完成后提交推送并按补丁交付；本轮不执行付费模型或 Brave 请求。起点 main `84be0baafc67f3c41d3e17e65cc45e32f0f6d34a`，分支 `codex/security-diagnostics-evaluation`。候选号仍为 **0.5.3**，此前正式 Release v0.5.2；交付前再次核对远端。前次问题 5–10 的证据归档于 [前次交接](archive/HANDOFF-2026-10-11-distribution.md)，不迁移为本轮候选成功。

## 实现与边界

- 私密报告政策、公开 Issue 提醒、npm/Actions Dependabot。已实际启用并回读 GitHub 私密报告、依赖告警/安全更新、Secret Scanning 和 Push Protection；交付前再核对设置。
- 完整锁文件审计、固定 SHA 工具、脱敏 Gitleaks、SPDX 许可证、多层 Syft SBOM 接入 Required checks 与候选 Release。严重漏洞、服务故障、缺报告或摘要不符拒绝。两平台三种消费者安装分别记录实际依赖及原生二进制；静态链接内部依赖覆盖限制明确保留。
- MCP 说明、作用域规则、用户调用 Skill 和 Memory 从宿主动态指令层分离；外部工具结果持久来源标记，压缩记录类别。不同 Responses 布局保持低信任；宿主授权机制与 full-access 语义保留，不宣称模型永远不受骗。
- Web 保留统一响应租约，补压力验收。搜索改 DOM 和真实脱敏结构快照；`/web` 明确选择 Brave，Key 仅 keyring，保存不请求，固定 HTTPS、拒绝重定向及额外付费重试。
- `/doctor --live` 默认 Cancel，先预览有界阶段，配置假设与实测/未知分开，身份绑定及七天时效。`/cost` 是用户定价的逐请求快照估算，涵盖失败、重试、压缩、辅助和成员；币种分开，缺字段不按零金额，预警不保证停止在途计费。
- 八类合成任务和固定 node-pty #952 helper 路径冻结外置评分器。历史独立计划保留失败/未知，首页显示成功/计划，不合并不同候选。第 16 项正式 DeepSeek/中转 coding 闭环仍未完成；准备记录不含执行授权或数值预算。

稳定契约、源码与测试入口见 [安全与诊断专题](architecture/SECURITY_AND_DIAGNOSTICS.md)。

## 验证与交付

实现阶段：Web 独立 GC 压力预热后十批、每批百次、并发八，批末连接/租约归零，heap/external 增长各在 32 MiB 上限内。九项评分器基线/缺陷/修复证明通过，真实模型运行零次。生产 coding runner 六入口 × 六攻击通过；Ink 和真实 PTY 的新面板确认、取消、Esc、resize 通过。doctor 穿过真实 SDK 的官方/配置型中转/通用布局离线 SSE；旧 ReactAgent/恢复/MCP/Memory/TUI dependencies 兼容回归通过。

最终本地串行 `typecheck → lint → test → build` 全部通过：1196 tests，1193 pass、3 skip、0 fail；`git diff --check` 通过。跳过不作为原生沙箱验收。门禁收据 `local-gates-14.json` 及 `final-14-*` 记录实际命令和退出码。九项完整评分器证明见 `expanded-drain-final/expanded-proof.json`，evaluation digest `d19c65dd1f592cec824bb7e5c67067e0d8170f846817f8505b60409ad5fc875a`，真实模型运行零次。工作证据根：`C:\Users\39850\AppData\Local\Temp\everpeace-security-2e61f0e7347246339d51bc14e24b8f50`。工作证明不冒充发布候选收据；安装目录许可证检查包含关键组件，最终仍须验收新锁、新补丁和准确候选的消费者产物。

远端 CI 的失败均保持 Required checks 拒绝：新面板改为等待实际画面与交互输入；正常 Web 连接期限与故意超时分开；取消模拟器在异步准入后检查已取消状态；CI 显式固定 Python 3.12，并保留严格取消验收。本地全量复验另发现真实 Windows Conpty worker 的 EPIPE 关闭竞态，修复到既有分发补丁，真实 stream 回归验证关闭后停止写入、继续排空，其他错误仍报告；冻结锁与评分器依赖同步更新。失败日志仅供诊断，不重用旧 commit 的成功证据。[PR #5](https://github.com/VinceTree/Everpeace/pull/5) 等待最终提交的两平台、安全扫描和 Required checks 全成功，然后冻结准确 main 候选验收同包消费者。

## 发布与外部依赖

专用 Windows 机器未准备、Runner 未注册、RUNNER_READ_TOKEN 未配置。用户选择先完成代码与 [部署说明](WINDOWS_RUNNER.md)。新安全门禁、两平台同包消费者和准确 commit 的 required native 全成功前禁止创建 tag/Release；不手工绕过，不复用旧候选证据。付费评测另需明确端点、原始模型 ID、凭据及 task/campaign 数值预算。

保留原有 untracked `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`；没有付费请求、上游投稿或 npm registry 发布。授权允许提交推送及补丁交付，Release 仍受真实门禁约束。
