# 当前交接

## 当前候选与授权

当前源码候选 **0.6.0-rc.1**。用户明确授权十项优化、deepseek-flash 真实评测不限 Token/费用总额，以及提交、推送、更新版本和 GitHub Release。用户接受先在 Windows 测试，Linux 本机/云服务器检查后续进行。正式原生安装包仍保留原有完整发布门禁；本次发布为源码预发布，不把本机成功或跳过当作正式包验收。

起点目录缺少 Git、根工程配置及锁文件。完整性清单在 [baseline-manifest.json](../implementation/baseline-manifest.json)，恢复依据见 [RESTORATION](../implementation/RESTORATION.md)。本地基线及阶段提交全部保留，随后与远端 main 的真实历史连接，不覆盖上游提交。pnpm 固定 10.30.3、依赖使用本机安装记录核验的精确版本。

## 逐项交付

十项实现、验收、迁移和复现方式见 [优化验收报告](../implementation/REPORT.md)。报告分别标出已有能力、补强、测试及真实效果待验证。生产修复上限继续三轮，团队默认仍单 Agent。验证 v1/v2 增量兼容；独立功能验证只能由宿主入口绑定。Memory 来源不足可读但不注入，纠正/禁用会在下一请求前刷新。二进制整合以宿主原始字节与事务恢复为边界，64 MiB 单文件、256 MiB 快照及 10,000 文件资源限制不代表费用预算。

## 真实评测结果

模型使用可解析凭据的 deepseek-flash 注册项；较新的另一注册项凭据不可用。密钥只经 AuthStorage 读取，没有写入源码或报告。修复/团队各计划十二任务、每臂五次、共 120 次；实际运行与全部跳过均保留。四个配对通道并发，配对内顺序随机且串行，存在同端点/同机器竞争限制。

- 修复：46 passed、32 failed、3 error、39 skipped；33 recorded runs 的 Usage 未知。
- 团队：0 passed、28 failed、1 error、91 skipped；28 recorded runs 的 Usage 未知。
- 两个 campaign 都因 Windows taskkill 128 清理失败停止；有失败模型请求、计量不完整与未运行项。没有达到策略门槛，不宣称效率改善，也不推荐自动开启团队。
- Memory：90 次全部执行；无记忆 30/30、有效记忆 29/30、过期/禁用/纠正组 30/30。旧错误经验注入零次；一例解析失败且 Usage 未知，整体不能记为全通过。
- Web：24 页固定技术文档对照，包含十二份有许可的 Node 上游快照；正文及关键代码保持，合成页面外壳不宣称通用网站效果。

脱敏证据见 [evidence](../implementation/evidence/manifest.json)。原始计划、JSONL、模型原始记录和冻结 harness 保存在本地 .cache/evaluation；不上传原始源码/客户路径/输出。修复已知 Token 5,218,486，Memory 已知输入 350,289、输出 6,812；这些是部分已知消耗，不是完整账单。先前基础设施失败 pilot 的已知输入 653,238、输出 41,803 及在途未知用量另行保留，不从总工作记录中删除。

## 当前检查与发布状态

最终 Windows 四项检查、干净安装、安装烟测、工作流配置及安全检查正在本次候选上执行。最后结果与远端 CI/PR/Release 链接将追加在本节；旧交接收据不迁移为本次成功。当前 Linux 本机未执行：WSL 映像不可用，用户选择后续服务器验证。GitHub hosted 检查如运行，将独立记录其结果和平台跳过。

原有 question、test-me、NUL 及私有 .cache 模型产物保留。没有 npm registry 发布。上轮交接已归档到 [observability base](HANDOFF-2026-10-12-observability-base.md)。

### 本次最终 Windows 收据

串行 typecheck → lint → test → build 全部通过：1258 tests，1255 pass、3 skip、0 fail、0 cancel；CLI/SDK/native PTY 安装烟测 7 pass。干净安装及工作流固定/门禁配置检查通过。命令和日志摘要见 [windows-checks.json](../implementation/evidence/windows-checks.json)。安全工具初次下载连接中断不计成功，重试及远端安全结果另行追加。

### 本次远端独立验收

[PR #10](https://github.com/VinceTree/Everpeace/pull/10) 的第二轮 [完整 CI](https://github.com/VinceTree/Everpeace/actions/runs/38216807264) 全部通过，绑定 commit 4483a606113baf0709853a4a4d7d9ca986163169。Ubuntu hosted：1258 tests、1249 pass、9 skip、0 fail；Windows hosted 结果见 [hosted-ci.json](../implementation/evidence/hosted-ci.json)。security 与 Required checks 全成功。首次远端失败原样保留：Memory CLI 测试隔离变量误用 XDG_CONFIG_HOME，修正为 XDG_STATE_HOME；合成 PEM 标记增加精确历史/当前文件哈希的审查记录，不放宽扫描。

本机安全工具下载失败及 TLS 中断仍记录为未完成；远端安全扫描独立通过。Linux hosted 源码检查现在有实际证据，本机 WSL 及专用 Windows native 发布验收仍未执行。末次仅补正文展示版本及验收文档的提交继续接受同一分支保护门禁。正式原生安装包不因源码预发布绕过其门禁。

本次源码预发布名称 v0.6.0-rc.1，[Release 入口](https://github.com/VinceTree/Everpeace/releases/tag/v0.6.0-rc.1) 在合并及打标签之后创建；公开附件仅含脱敏 evidence。
