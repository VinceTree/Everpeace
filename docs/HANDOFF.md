# 当前交接

2026-10-31：按用户“修改全部 PR”的要求，在 `codex/public-contract-core-experience` 整合未合并 PR 对应依赖更新并修复兼容性。起点 `dae8a9a`，开始时工作树干净，展示版本仍为 `0.6.0-rc.4`。用户随后明确授权提交、推送及合并可以合并的 PR，禁止创建 Release；不改展示版本、不打 tag、不调用付费模型。

上轮离线性能测量及交付收据移至 [历史交接](archive/HANDOFF-2026-10-24-local-performance.md)。其性能数字绑定旧依赖与候选，本轮不复用为新候选证据。原有 ignored 用户目录及私有材料保持原样，不读取 keyring 或真实 Session。

## PR 处理范围

GitHub 当前九项未合并 PR：#11 为当前分支的 Draft 功能 PR，#12–#19 为 Dependabot 更新。已 fetch 远端并读取八个依赖分支的实际差异；功能 PR 无 review。官方 gh 没有独立登录，现通过 Git 已有的 GitHub credential helper 在内存中向 gh 子进程提供认证，不落盘凭据。认证后核对当前九项均因既有 CI 失败而 BLOCKED，须推送新候选并等待实际 Required checks；不能以本地通过代替远端通过。

| PR | 本地处理 |
| --- | --- |
| #12 | marked 更新至 18.1.1 |
| #13 | 保持 Node 22 基线，采用同主版本最新类型补丁 22.20.5，不采用 Node 26 类型；Dependabot 忽略 Node 类型跨主版本更新 |
| #14 | tsx 更新至 4.23.15 |
| #15 | Ink 更新至 8.0.0，适配普通 stream 类型与 resize |
| #16 | React 更新至 19.3.1，同步 react-test-renderer 至相同精确版本；Dependabot 将 React、renderer 和 React types 归组 |
| #17 | MCP SDK 更新至 1.32.0 |
| #18 | setup-python 更新至 7.1.0，保留 PR 的完整固定 SHA |
| #19 | undici 更新至 7.30.1 |

## 兼容性与冻结身份

- App/Composer 通过公开 `useWindowSize` 获取宽度；独立 Composer 也响应 resize。聊天历史的去抖重放与命令窗口保持原有边界。
- Markdown 继续按输出流共享一份 resize 订阅，收窄普通 Writable 的可选列宽；缺失、零、非有限值回退到 80 列，卸载移除监听器。
- 新增通用 PassThrough 输出流的表格重排，以及独立 Composer 连续缩放、中文长草稿保留、终端回报丢弃和只提交一次的回归。
- 根锁文件、expanded 与 real-fixtures evaluator lock 同步重冻结，expanded setup 同步 React/renderer 精确版本。旧 evaluation 摘要、真实模型成绩及性能数据仍绑定旧身份；本轮不修改历史报告或参考解。
- 同步双语 README、开发指南、终端专题、评测指南、计划与决策。未修改产品版本、公共 CLI/SDK 或 Session schema。

## 依赖安全审计

原 PR 组合的 npm 官方审计仍报告一项 high、三项 moderate 和三项 low。先在独立锁候选中按现有上游范围定向更新 body-parser 2.4.0、fast-uri 3.1.9 和 qs 6.17.1，审阅确认仅替换这三项传递依赖，直接 manifest、补丁及 importer 不变，不新增 overrides；随后应用到根锁并以 frozen-lockfile、strict-peer-dependencies 安装成功，重新同步两份 evaluator lock。

最终已安装组合的官方审计为 info 0、low 1、moderate 0、high 0、critical 0，现有 `checkAudit` 策略通过；192 项组件许可证通过现有 `checkLicenses` 策略。残留为 `@inkjs/ui → deepmerge@4.3.1` 的 [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)，公告未提供修复版本；未忽略公告或变更安全门禁。证据 `.cache/pr-integration-2026-10-31/audit-final.json`、`licenses.json`；原始高危审计为 `audit-npmjs.json`，独立候选为 `audit-candidate.json`。默认本机镜像缺少 audit endpoint 的初次失败也保留为 `audit.json`，不能视作通过。

## 本轮验证

定向 UI/MCP/网络/expanded/workflow 回归 262 项全部通过，零跳过，日志 `.cache/pr-integration-2026-10-31/targeted.log`。安全传递依赖更新前的首轮完整门禁全部通过，1369 项中 1366 通过、3 跳过、零失败，日志 `initial-gates/`；其约 337 秒 test 包含 pretest，Node suite 本身约 324 秒。

应用最终安全依赖后重新发现实际 manifest，串行执行 typecheck → lint → test → build，四项全部通过；1369 项测试中 1366 通过、3 跳过、零失败，test 含 pretest 约 329 秒，Node suite 本身约 321 秒。跳过仍为本机文件 symlink、Windows 临时目录别名场景和 Unix 超时子进程实测。最终日志 `.cache/pr-integration-2026-10-31/{typecheck,lint,test,build}.log` 与 `gates.json`；不以首轮结果代替最终组合验证。

补充通过：安全文件 read/create/update/delete/冲突 smoke、Windows 进程 owner 根与 detached 子进程清理、构建后 CLI/SDK 启动和原生 PTY 生命周期 7/7；安装补丁、workflow、953 组语言键与插值、165 份公开文档路径/链接、Dependabot 策略解析和 `git diff --check`。新增归档另查空白；未增加平台跳过或降低任何门禁。对应日志同目录 `{files-smoke,process-smoke,install-smoke,install-verify,workflows,ui,docs}.log`。

根锁与两份 evaluator lock 字节一致，最终锁 SHA-256 `f29df206ef83bf59d28dbdeefb3bd7fb7f21bd4e62ac1b070a22ea1feaa3f9c2`，固定 setup-python SHA 与上游 tag 核对一致；收据 `final-receipt.json`。门禁后仅补交接验证记录，源码、依赖和构建未再修改。

## 未覆盖与远端交付

真实 Windows Terminal、Linux/macOS、干净消费者安装、包含 secret/SBOM 的完整安全扫描及真实模型评测未执行；本轮 audit/许可证检查和当前源码安装 smoke 不替代这些证据。real-fixtures 上游联网 proof 未重跑，旧 proof 不算新依赖验收。当前安全文件支持范围仍为 Windows 本地 NTFS。

修复提交为 `9bbcec5`。已逐项核对 #12、#14–#19 的原始提交只修改对应 manifest/lock 或 setup-python 固定 SHA，目标升级全部包含在已验证组合中；随后用保留当前内容的 merge 记录七项原始提交，每次核对 Git tree 完全不变，#13 不在整合历史中。最终通过 #11 的实际 Required checks 后以 merge commit 合入 main，保留这些提交的可达性，使 GitHub 能将对应依赖 PR 结算为间接合并；不能采用丢弃来源 ancestry 的 squash/rebase，也不单独接受旧依赖锁。

正在按授权推送整合组合，所有新提交使用 `[skip publish]`，保留 CI。核对 main 的 Required checks 保护开启且管理员也适用、要求分支跟上 main；不更改保护或使用 admin 绕过检查。Release workflow 仅接受 main 上的显式 workflow_dispatch，push/merge 不会创建 Release，本轮不 dispatch。#13 保持 Node 22 策略，不合并其 Node 26 更新；远端结算以实际状态为准。
