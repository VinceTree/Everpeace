# 当前交接

更新日期：2026-10-08。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择专题。上一轮的项目地图、受控编辑与输出清理记录见 [归档交接](archive/HANDOFF_PROJECT_MAP.md)，更早连续性记录见 [历史](archive/HANDOFF_CONTINUITY.md)。

## 当前基线与授权

- 本轮开始 main HEAD：`9a2301dbd0e69eb82119598403f632fe4b408c48`；开始时包和双语 README 为 `0.3.10`，用户随后授权同步更新为 `0.3.11`。
- 用户明确授权实施 Plan 优化：带意见修订、批准后等待、仅 /plan execute 启动完整正文；待执行计划仅保留当前进程／当前会话。
- 离线 fake provider 验收，不调用真实模型。实现后用户明确授权提交、推送和更新展示版本，但禁止更新 Release；提交使用 `[skip publish]`，只推送 main，不创建或推送 tag。保留原有未跟踪内容，单 Agent、Responses、权限和宿主验证结算不变。

## 本轮实现

- [Plan runtime](../src/plan/runtime.ts) 分离公共／coding／Plan 指令；Plan 先调研与按需澄清，不携带 coding 持续实施或活动 Goal 完成指令。summary 同样采用当前模式。
- review 兼容旧字符串决定并支持 `{ decision, feedback? }`；非空修订意见随 submit_plan 配对结果落盘后继续，要求完整替代稿。批准结果包含标题及完整正文，返回／runner 交接后重查取消。
- [审阅界面](../src/tui/components/screens/plan-surface.tsx) 提供 Approve plan／Revise plan／Cancel plan。修订 Esc 返回菜单、菜单 Esc 取消，两处 Ctrl+C 均取消活动任务；预先 aborted 不开窗口，迟到决定只结算一次。
- [TUI App](../src/tui/app/app.tsx) 等规划 runner 清理后保存绑定 Session／Agent 的待执行计划，保持 Plan 并空闲。/plan show 不请求模型，/plan execute 消费完整正文启动共享 coding runner，取消／失败不自动重试。
- 新讨论、/plan exit、成功新建／恢复／fork／清空会话或 Agent 替换使批准失效；失败会话操作保留。重启不重建批准，压缩不改变正文。Plan 排队 guidance 返回草稿等待重交；coding steering 保持。
- 无 Session schema 或 exec／SDK 公共参数变更；非交互 Plan 仍只输出正文，必须回答的问题配对落盘后返回 interaction_required。

契约见 [RUNTIME](architecture/RUNTIME.md)、[STATE_AND_UI](architecture/STATE_AND_UI.md)、[DECISIONS](architecture/DECISIONS.md)；范围见 [PLAN](PLAN.md)。双语 README 与开发指南已同步。

## 本轮验证证据

Windows Node v22.19.0／pnpm@10.22.0。新增 Plan／TUI／production／exec／runner 定向回归共 117 项全部通过；SDK 独立 3 项全部通过。本地 fake HTTP SDK fixture 使用隔离用户目录与注入凭据，不接触真实模型服务。production TUI fixture 贯通地图／读取 → 提问 → 初稿 → 修订意见落盘 → 完整替代稿 → 批准等待 → 显式执行 → 完整宿主验证；fork 的旧验证债务在规划期间保留，执行通过后结算。验证命令使用内容检查替身，不当作原生 shell 或真实终端证据。

初次 sandbox 运行 pnpm script 无输出退出；直接 tsc 可执行。sandbox 临时路径导致已有文件观察／目录 rename 回归失败，随后获准宿主环境执行，同组既有 Agent／exec／TUI 回归 148 项全通过。新 TUI 回归初次输入发生在界面 listener 安装前，已同步组件挂载后重测；未放宽失败断言或跳过回归。

最终在获准宿主环境重新串行执行门禁：pnpm typecheck 通过；当前 scripts 无 lint，明确记为缺项；pnpm test 共 789 项，786 通过、0 失败、3 跳过，耗时 55,767.0667 ms；pnpm build 通过。原有跳过项保持，未新增跳过或放宽回归断言。完整日志位于宿主临时目录 everpeace-plan-final-test.log。另对新增两份 TSX 回归使用相同严格类型选项单独检查通过，弥补现有 tsconfig 的 tests/**/*.ts 入口未显式包含这些文件。

git diff --check、新文件尾部空白检查及 11 份文档的 205 个本地链接检查通过；新归档相对链接已按所在目录调整。展示版本更新后的门禁与授权交付结果另在下节记录，不引用上一轮 CI 作为本轮验证。

## 授权交付

用户授权后 package.json 与双语 README 同步为 `0.3.11`，依赖声明未变，无需变更 pnpm lockfile。已核对 Release workflow：main push 的发布 job 遇到 `[skip publish]` 会跳过，Test workflow 不受影响。版本更新后在宿主环境重新串行执行 typecheck → test → build，全部通过；当前无 lint script。完整测试 789 项，786 通过、0 失败、3 个原有跳过，耗时 52,750.7978 ms，日志为宿主临时目录 everpeace-plan-delivery-test.log。提交推送和远端 CI 结果待核对。

## 限制与独立后续

真实 Windows Terminal 的修订输入、取消、resize／scrollback、恢复及单 prompt 尚未手工验收。离线回归不能证明真实 DeepSeek 规划质量、成功率、缓存或 token 收益；live 评测需另行授权和数值预算。Windows LSP backend 的网络隔离门禁仍 unavailable，启动失败不回退宿主。

## 用户原有内容

开始时 tracked 差异为空；已有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，不清理、不加入交付。
