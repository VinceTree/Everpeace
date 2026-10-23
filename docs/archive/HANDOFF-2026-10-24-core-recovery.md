# 当前交接

2026-10-24：继续第二轮核心链路审查，范围为取消、超时、清理失败与 Session 恢复，用户明确授权发现问题直接修复、完整门禁后提交和推送。分支 `codex/public-contract-core-experience`，起点 `d4b948e2d292c5a1c8e58a15513076f4e7cdaf3a`，开始时工作树干净；当前源码候选仍为 `0.6.0-rc.4`。未调用真实模型、读取 keyring 或执行付费评测，不改版本、不打 tag 或创建 Release。

第一轮构建／检查修复及 MCP 启动前关闭修复的交付记录在 [历史交接](../archive/HANDOFF-2026-10-23-build-mcp.md)，提交 `ec6acde` 与 `d4b948e` 已推送并核验远端；历史结果不作为本轮证据。原有 ignored 用户目录和私有资料保持原样。

## 已复现和修复

- 团队验证的异步收尾期间取消或达到期限，runner 会先完成 Goal 再发现取消。现在返回后先复核 signal，再进入 Goal／Memory 结算。
- team.cancel 抛错会跳过根 Agent 的 stopAll，虽然父信号已取消 worker，调用方却没有等待 worker 真正结束。现在分别请求两类资源清理，等待全部结算；typed 资源故障保留在 Agent，禁止新请求复用。
- resumeTurn 和冷观察的初始 Git 快照漏传 signal，预取消可能仍启动快照并保存新状态。现在入口拒绝预取消，并将 signal 传入基线与路径追踪。
- 恢复后的 pending 债务在变更路径为空或 Git 不可用时被覆盖为 no_changes；旧 failed/unverified 缺少 pending 字段、中断验证阶段也可丢失。现在把既有失败／中断／受限状态保留为 pending，债务独立于路径列表；重新发现当前完整检查，仍检查当前验证依据授权，追踪不可用继续 unverified。

不新增 Session 字段或格式，保留修复计数、原生 sandbox、当前权限和文件重新观察边界。专题、架构决定、项目地图、计划、开发指南和双语 README 已同步。

## 本轮验证

- 首批 10 个新增回归在旧源码全部失败；修复后通过，补充当前授权与冷快照边界后共 13 项通过，0 失败／跳过。入口：`tests/unit/workflow/recovery-boundaries.test.ts`、`tests/unit/agent/cleanup-boundaries.test.ts`。
- 真实 SessionStore JSONL 写入／重开、真实 GoalRuntime、受控后台 worker 和 Git 工作区参与测试；provider 为离线 fixture，不代表真实模型或终端验收。
- 扩展 workflow、exec、连续性与 Memory 空闲回归 124 项通过，0 失败／跳过，日志 `.cache/core-recovery-targeted.log`。
- 首轮门禁 typecheck 因新增 Session fixture 缺少必填 titlePending 失败并停止，lint/test/build 未运行；只补齐测试字段，日志 `.cache/core-recovery-r1/typecheck.log` 保留为诊断。
- 修正后重新串行执行 typecheck → lint → test → build，全部通过。全量 1362 项，1359 通过、3 跳过、0 失败，约 293 秒；日志 `.cache/core-recovery-r2/{typecheck,lint,test,build}.log`。跳过为本机文件 symlink、Windows 临时目录别名专门场景和 Unix 超时子进程实测，与前轮一致。
- 文档／UI／workflow 静态检查通过：162 份公开文档、953 组语言键及插值、固定 workflow 身份及门禁。源码验证后只补充本交接收据，提交前重查文档和暂存差异。

## 交付和边界

本轮修复及收据按用户授权以 `fix cancellation and durable recovery boundaries [skip publish]` 提交并普通 fast-forward 推送当前分支，推送后核对远端分支 SHA；禁止 `[skip ci]`。Release workflow 仍仅 main 显式 dispatch，当前功能分支 push 不自动触发 PR/main Test，不声称远端 CI 已通过。

本机 Windows x64、Node 22.19.0、pnpm 10.30.3；本轮未执行真实断电、Windows Terminal 人工交互、Linux/macOS 原生或跨平台消费者安装。默认分支先前提示的 8 项依赖告警仍待单独核对，不把它当作当前分支的供应链审计结果。
