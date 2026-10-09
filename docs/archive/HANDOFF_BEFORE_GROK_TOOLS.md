# 当前交接

更新日期：2026-10-09。先读 [AGENTS](../AGENTS.md)，再按 [索引](README.md) 定位。此前工程准备、原生导航、协议和评测装配的完整证据见 [上一轮交接](archive/HANDOFF_READINESS_BEFORE_TERMINAL.md)。真实 Windows Terminal 验收后，中转 DeepSeek 测试未通过；用户另行授权 Grok 测试，文本通过、实际读取工具通过，但读取后续请求超时且用量未知，本轮停止继续付费请求。

## 当前结论与授权

此前交付的 Windows Terminal 必需场景、本地工程门禁、公共安装和三组无凭据预检均已通过，同提交 Windows/Linux CI 通过。工程准备不证明真实模型的编码成功率、稳定性或成本。**当前指定中转端点的 Responses 兼容性尚未通过，不进入正式编码评测。** 本轮源码变化还未提交，原候选预检不能冒充新构建的证据。

- 本轮起点为 `9d466276fdc5b04158e36a7ae70e8b50125a5364`，个人任务冻结基线仍为 `197c3c48d5f789a7215a1ac6af5ce40cb10ba1ef`。展示版本 **0.3.24**，package.json 与双语 README 一致。
- 用户已授权更新版本、提交、推送，禁止更新 Release；提交带 `[skip publish]`，不关闭 Test CI，不打 tag、不 publish npm 包。
- 用户明确授权中转兼容两项、每项 10,000 / 合计 20,000 token；第一项用量未知后停止，第二项跳过。随后单独授权一次最小诊断、task/campaign 均 1,000 token；诊断返回 HTTP 400 且无可靠 usage，停止继续请求。用户随后说“没钱了，下次来”，停止付费调用。个人 400,000、smoke 900,000、正式 9,000,000 token 仍只是分别授权的草案，不是账单硬上限。
- 用户之后恢复 Grok 测试，明确授权文本任务 10,000、工具任务 20,000、campaign 合计 30,000 token；这是独立阶段，不清空前两次 DeepSeek 的 unknown。Grok 后续请求发生 unknown 后同样停止，未开展个人编码四任务或正式比较。
- 保留原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`，不纳入提交。

## 中转兼容测试与诊断修复

当前 HEAD `7a366caab3ff6e4e59a26de6559d903df92288bc`，本轮修复仍在工作区；未更新版本、提交、推送、tag 或 Release。端点为 `https://cc2.caaa.tech/v1`，模型原始 ID 为 `deepseek-flash`，注册 ID `57dff918-6973-4f06-8947-1511f16448e2`。用户通过内置登录保存密钥；模型列表返回 200 且包含该模型，不能再把失败归因于未经验证的 key 格式或模型名错误。

隔离证据根 `C:\Users\39850\AppData\Local\Temp\everpeace-relay-flash-619d7bdb1e794d99995f6960c96ee09d`。真实生产 TUI 使用 `profile`，自动 exec 使用独立 `automation-profile`，两者与日常 Session/Memory 分离；Memory 关闭，模型元数据只有 keyring 的 auth_ref，没有 API Key。workspace 是独立 Git 目录，marker 不出现在工具任务提示词中。

- 生产 exec 文本任务在 10:37:20–10:37:26 UTC 执行；输出上限 1,024、预算 10,000、read-only、最多两 step。Session `2cc69deb-cdb8-473e-902f-39cb674ba3b2`；没有助手正文或工具事件，退出 4 / `usage_limited` / `usage_complete: false`。`text.jsonl` 和 `text-process.json` 保留失败；计量显示的零不是零费用，原错误当时被停止路径隐藏。读取 marker 的第二项未执行。
- 原 campaign 未清空、未续跑。单独授权的最小诊断在 10:48:18 UTC 发送一次生产 provider stream 请求：input 为 `Reply OK.` 字符串、输出上限 16、预算 1,000，关闭 SDK 重试，无工具及 Memory；`minimal-diagnostic-result.json` 确认实际 POST 返回 400，非 HTML / Cloudflare 页面，无可靠 usage。该请求没有跑 coding runner，不能算第二项工具测试通过，也不能从 400 推断拒绝的具体参数、客户端策略或上游协议。错误正文未保存，具体原因仍待查。
- 不生成模型输出的读取证据：原生 fetch 与生产 SDK 的 `/models` 均 200；GET/OPTIONS `/responses` 返回 Cloudflare 403。GET 的 WAF 结果不能代替实际 POST 的状态。只读 `/api/v1/me/usage-logs/full` 查询返回 401，未取得后台错误或账单。公开站点链接到 Claude Code Hub，公开同版本源码只能作为排查线索，不能证明实例配置。
- 用户另问 Grok 4.6；仅 GET `/models`，返回 200 且列出 `grok-4.6`（`grok-model-list.json`）。[官方模型文档](https://docs.x.ai/developers/models/grok-4.6)与 [Responses 文档](https://docs.x.ai/developers/rest-api-reference/inference/chat)提供协议/工具能力依据；中转中的 Grok 生成、工具调用和计量均未验证，未发 Grok 付费请求，未切换注册模型或默认设置。

发现并修复真实诊断缺口：有界 provider attempt 失败且 usage unknown 时，原代码吞掉原始错误，只显示用量停止。现在 turn 保留宿主生成的 HTTP 状态与固定错误类别，共享 runner 的停止提示和 exec/SDK 已有 error 字段返回诊断；仍停止后续模型请求和工具，不记录供应商正文、message、headers 或凭据。生产 exec 离线回归在旧实现因缺少诊断失败，修复后检查一请求、退出 4、unknown sticky、Session 停止提示及凭据/正文不泄漏。

本轮最终串行门禁：typecheck pass → lint script 缺项 → test **1067 项，1064 pass、0 fail、0 cancelled、3 skip，71,903.0999 ms** → build pass；`git diff --check` pass。完整测试日志为证据根 `diagnostic-fix-test.log`。此前远端 CI 和候选预检仅对应其原提交；新修复没有远端 CI/安装/候选预检证据。下次先取得中转 400 错误详情，再按新候选补齐受影响预检，明确新阶段预算后继续；省 token 的目标尚未取得真实成功样本，不能发布成本优势。

## Grok 隔离兼容实测

独立根 `C:\Users\39850\AppData\Local\Temp\everpeace-grok-acceptance-5c41a0de51d34f2fafba6cf1f3ad457f`。仅在 owned profile 复制中转注册元数据、复用 keyring auth_ref，模型原始 ID `grok-4.6`、注册 ID `09694cca-f2f5-42ee-bfbb-a9ab5166e375`；没有修改日常注册、默认模型或密钥。Memory 关闭、read-only、每次输出上限 256，兼容端点不发送 reasoning 设置，不能把保存的 off 当作上游已关闭推理。使用公开 SDK `runTask`、正常生产 factory/共享 runner，首失败或 unknown 停止，未启用 SDK 自动重试。

`candidate.json` 绑定本轮工作树：revision `7a366caab3ff6e4e59a26de6559d903df92288bc`、sourceDigest `8c623182cfa8bfb5744939e1e7dc053e452b60522bd25fdec3da3e298f2f8002`、buildDigest `c7b9123baa4cb0dd08b809359b008c06b56c5e8e318bd0db84fa0b4c4f1d28c9`。无凭据 fake-fetch 预检经过真实 SDK SSE decoder、生产 Session 和文件工具；修正验收器误把文件工具 `ok` 当成 `completed` 后，两项通过（`offline-verified-preflight.json`）。首次评分器失败保留在 `offline-preflight.json`，不算生产故障。此预检是当前 SDK 兼容场景装配证据，不替代三组正式比较的 checkout preflight、安装或远端 CI；本轮未再改生产源码，前节本地门禁仍对应当前源码与构建。

2026-10-09 北京时间 19:01:47–19:02:08 实际执行三次 Responses 请求（`campaign-result.json`、各 case result/events、独立 Session）：

| 项目 | 结果 | 可靠计量 / 证据 |
| --- | --- | --- |
| 文本任务 | 通过；一请求，HTTP 200，准确 `GROK_TEXT_OK`，无工具，退出 0 / no_changes | input 6,511、output 34（reasoning 28 包含其中），合计 6,545；cached input 128；Session `fb0805c0-1e65-4684-b992-91d7a2a5b2bd` |
| 工具任务首请求及读取 | 部分通过；HTTP 200，模型实际调用 read_file，已配对持久化的结果包含未放进提示词的随机 marker | input 6,522、output 53（reasoning 39 包含其中），合计 6,575；cached input 128；`durable-evidence.json` 验证实际 context 配对 |
| 工具任务后续请求 | 失败；发出请求后、取得 HTTP response headers 前超时，退出 4 / usage_limited；没有最终助手回答 | usage null；Session `59310509-de3d-488b-88e1-2163b78d0d66` 保留 unknown 与停止诊断；具体网络/上游原因未确定 |

计划分母为两任务，一通过、一失败，零跳过；工具读取这个子步骤的通过不能覆盖整个工具任务失败。已知用量 input **13,033** + output **87** = **13,120 token**，reasoning **67** 不重复相加；超时请求未知，因此不能把 13,120 当作最终账单或确定剩余预算。没有自动重试、后续任务或 Memory 请求。隔离工作区只有原 marker 文件，未改仓库文件；Session 与结果已保存，进程结束。

省 token 的实际观察：空目录简单文本请求仍消耗约 6,500 输入 token，完整请求包含约 27 KB 指令/工具定义。该样本揭示固定上下文开销，尚不足以证明相对其他 harness 的成本优势；工具广告和指令的优化必须保留权限、工具准入和生产入口语义，不能因一次文本任务静默裁掉必要能力。

## 真实终端与修复

终端为 Windows Terminal **1.24.12741.0**，可执行文件 FileVersion **1.24.2610.01001**。用户将专属窗口置前后，由限定标题/PID/ownership/focus 的 helper 注入实际 GUI 按键、滚轮和 Ctrl+滚轮，使用 PrintWindow 截取该 HWND；这是实际窗口自动操作，不冒充用户亲手按键或 ConPTY 仿真。fake provider 只使用隔离配置，无个人凭据。

外置证据根 `C:\Users\39850\AppData\Local\Temp\everpeace-terminal-acceptance-1758ded3a5b548e999de9a7f7452a249`：`terminal-evidence/actions.jsonl` 和截图、`fixture/sessions/`、`acceptance-result.json`、`final-cleanup.json`。主子会话为 `0f84ab27-2a18-4b3d-b459-c2be41b5154e`。

| 场景 | 结果与关键证据 |
| --- | --- |
| Plan 修订、Esc/Ctrl+C、批准后空闲、显式执行 | 修订草稿 resize 保留（70/71）；批准和查看（73/75）；显式长任务、取消后旧批准拒绝（121–127） |
| 修改→test pass→build fail→repair→全检查 | /plan cycle 后批准、/plan execute；133 截图与 JSONL 记录 build 指定断言 exit 1，随后 typecheck/test/build 全通过、repair_attempts=1、债务清除 |
| 重复 Enter、运行中 guidance、Ctrl+C | 122–125；guidance 仍等待，Ctrl+C 取消实际活动请求；不是空闲退出 |
| 权限在审批期间收紧 | 168–176；切为 read-only 后旧 MCP 批准失效，MCP 与后续 navigation 均 cancelled |
| 中文/emoji、resize、scrollback、滚轮/缩放、单 prompt | 143–154；300 行保留，Ctrl+End 回到末尾；151/152 实际放大字体、153 恢复 |
| 直接 ! 输入独占、退出 | 155–160；子进程 10580 接收专属输入并退出，恢复单 prompt；对应文本仅在 timeline，不进入 context_append |
| 隔离扩展 | 134–141；Skill 内容、MCP pong、native hover 成功，Memory 窗口显示种子条目；不把 Memory UI 当作真实学习质量证据 |
| 同 root 重启、fork、债务与 unknown | 26/32、89、182–186；子会话及历史恢复，旧 Plan 批准不恢复，最终 status 仍 partial；成功验证没有覆盖未知用量 |

发现并修复：

1. 命令窗口 resize 后空白，下一按键才重绘。App 只在聊天视图执行 Static 历史清屏重放；命令窗口由 Ink 原位调整，保留草稿。旧代码回归失败，修复后实际修订和 status resize 均正常。
2. 恢复较长 Markdown 历史触发 MaxListenersExceededWarning。每个 stdout 共享一个列宽订阅，最后卸载时清理；不提高上限或屏蔽警告。新回归在旧代码复现 60 个订阅，修复为 1 个，resize 更新所有块，卸载归零；实际重启长历史无新警告。

helper 修正焦点恢复、NULL 标题查找、DPI/owned HWND 截图、真实 Ctrl+滚轮，并支持失败停止的连续控制。fixture 增加 wait-long、显式 Plan 场景。早期 79/98/111 是空闲退出，149 未产生字体缩放，不能算取消/缩放通过；最终 187 因焦点丢失拒绝发送，不记为成功 Ctrl+C。关闭专属 HWND 后记录后代退出，不关闭其他 Terminal 窗口。早期 05 截图方式不合格，已删除，不作为证据。

## 此前工程与候选门禁

最终重新发现 manifest 并串行执行：**typecheck pass → lint script 缺项 → test 1066 项、1063 pass、0 fail、0 cancelled、3 平台 skip（68,191.5033 ms）→ build pass**。完整日志保存于终端证据根 `.terminal-acceptance-final-*.log`；sandbox 内一次 App 附件测试超时单独保留，原生同回归通过，不把基础设施失败改写为通过。

公共安装已通过：隔离 consumer 安装本地打包产物，CLI/exec help、SDK import/runTask 的无模型配置结果与退出码契约通过，405 个安装构建文件与本地 dist 字节一致。收据位于终端证据根 `public-install-result.json`。提交后的准确 SHA、同 SHA Test CI、Release 未变化核对记录在 `final-delivery.json`；完成前不借用上一轮通过结论。

修复提交 `33a09e9129ee583a771efb5cff3e5cbee25d34fa` 已推送，[Windows/Linux Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37903249607) 均成功，[Publish version](https://github.com/VinceTree/Everpeace/actions/runs/37903249554) 实际 skipped。27 个 Release 的 ID/tag/更新时间/资产等与保护基线一致，没有创建 tag 或 Release。后续仅交接记录提交仍以最终收据绑定准确 HEAD 和 CI，不把这里的修复提交 SHA 冒充后续 HEAD。

## 两套付费测试准备

沿用独立根 `C:\Users\39850\AppData\Local\Temp\everpeace-readiness-2eb92be531ab475d80b9ac4f141fa66a`。`personal.json` 与外置参考验收器冻结四项任务；`personal-offline-preflight.json` 验证装配、计量、取消与恢复债务；`fixture-proof.json` 的十项 pristine→指定断言失败→reference 证明保持有效，任务与补丁未改。

`smoke.json` / `comparison.json` 分别准备 9/90 次，基线、当前候选、固定 dsh 三组；统一 deepseek-flash/high/32768、十五分钟、最多三轮修复。提交后重新 configs 和无凭据 preflight，绑定 revision/sourceDigest/buildDigest；本轮之前收据另行保留。源码/锁文件/构建/HEAD 再变化必须重做候选预检。

本轮首次最终预检中 dsh 达到 60 秒超时，基线和候选通过；失败原样保存为终端证据根 `preflight-first-failure.json` / `preflight.log`。未更改代码、超时或权限条件的独立复验三组全部通过，零网络调用、完整 usage、清理已等待；`preflight-result.json` / `preflight-retry-timing.json` 保留复验。超时原因未确定，不把首次失败改写为通过；后续实测遇到类似异常仍立即停止并诊断。

原生 TypeScript 四查询、写入/状态/网络拒绝、取消/权限变化后 PID 退出沿用上一轮有效证据，对应生产实现本轮未改。复现与授权边界见 [READINESS](benchmark/READINESS.md)、[DEVELOPMENT](DEVELOPMENT.md#离线-windows-terminal-手工验收)。后续先分别取得个人与 smoke 的数值预算授权；发现请求、计量、隔离或清理异常立即停止，修复并重新准备候选，再考虑正式比较。
