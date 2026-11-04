# 当前交接

2026-11-03：按用户要求接入 OpenCode Go，随后测试套餐内的 Flash。开始时分支 `codex/source-candidate-evidence-2026-11-01`，HEAD `b30f993`，工作树干净；沿用当前 checkout。当前展示版本保持 `0.6.0-rc.4`。上一轮 Memory 修复交接完整移至 [归档](HANDOFF-2026-11-02-memory-hardening.md)，历史结果不替代本轮验证。

用户已购买 Go、有 API Key，最新要求是先对准接口，完成后再提供 Key，并表示可使用套餐做测试。本轮采用首轮总计 20,000、每项 10,000 tokens 的停止阈值，在途请求可能超出；凭据到位后可继续既定接口测试，无须重复询问授权。本轮未授权提交、推送、改展示版本、tag 或 Release。Key 应通过本机遮罩登录进入系统 keyring，不写聊天、文件、命令参数或模型注册 JSON。

## 实现范围

- CLI/TUI 登录新增 OpenCode Go 预设，推理 base 为 `https://opencode.ai/inference/go/openai/v1`，模型发现使用独立的 `/inference/go/v1/models`；保留供应商原始模型 ID。
- 精确匹配 Go HTTPS 路径时发送真实 Everpeace User-Agent 和稳定 `x-opencode-session`。主 Agent 使用当前持久 Session ID；TUI 标题、Skill、手动 Memory、doctor 与 benchmark Memory 传递所属 Session，没有 Session 的独立 runtime 使用自身 UUID。其他供应商不接收 Go 会话头。
- Go 保持 compatible/generic 默认能力；不根据模型名启用官方 reasoning、OpenAI 缓存参数或原生压缩。首轮兼容 fixture 显式 deepseek profile/high，不改变日常注册默认设置。
- 兼容准备器增加 `--base-url`；custom base 未指定登记 ID 时，live 阶段要求唯一匹配的地址及原始 ID。各阶段冻结源码、构建、验收器和新工作区，unknown／清理失败停止，不能覆盖旧结果或自动换服务。
- 同步双语 README／使用指南及运行时、评测、计划和设计决策。未读取真实 Session、Memory；仅检查已有登记凭据的可用状态，未输出秘密。

## 证据与验证

公开无 Authorization 的 GET 模型目录成功，当前返回 `deepseek-v4.1-flash`；推理 base 下的默认 `/models` 路径返回 404，已修正路由。带合成无效凭据的 GET 返回 401，不能当作有效凭据的认证结果。以上均为模型发现，无生成请求，收据 `.cache/opencode-go-2026-11-03/public-catalog.json`。官方协议与客户端要求见 [Go 文档](https://opencode.ai/v2/docs/console/go/)，声明支持 Responses 转换仍待实测。

最终在 Node 22.19.0、pnpm 10.30.3 下重新发现实际脚本，串行执行 typecheck → lint → test → build，四项全通过，耗时约 1.80、2.00、350.61、1.86 秒。全量 1418 项中 1415 pass、3 个既有环境／平台 skip，零失败／取消；skip 为文件 symlink 不可用、Windows 临时目录 alias 的 CI 覆盖和 Unix child 超时回归。Go 实际 SDK 请求、原始模型 ID、模型列表路径、独立 UUID、惰性 Session／恢复／工具调用、路由限定及 TUI 遮罩登录回归均在该轮通过。日志 `.cache/opencode-go-2026-11-03/gate-{typecheck,lint,test,build}.log`、`gates.json`。

904 份源码／测试／脚本／原生组件／manifest 与 lock 输入在门禁前后完全一致，SHA-256 `157eeb20df47398844af0de9e19e833d66aa9776019e65a0172ac83b794be29d`，收据 `identity.json`。门禁后仅更新文档收据；双语文案及插值、公开文档路径／链接和 diff 检查通过，日志 `{ui-verify,docs-verify,diff-check}.log`。本轮只在本机 Windows 验证，不代表真实 Go 认证、上游计量或模型质量已验收。

最终构建后冻结仓库外兼容根，绝对路径保存在本地索引 `.cache/opencode-go-2026-11-03/compat-root.json`，prepare／offline 日志在同目录。两项离线验收全通过，四次合成响应，真实原生文件读取及持久化配对、完整 reasoning 回传与最终隐藏 marker 校验完成；无跳过、无付费请求、无 live-started 标记。冻结的原始 ID 为 `deepseek-v4.1-flash`，显式 deepseek profile/high，验收器 digest `560bda2b215324049d47c0839f702597710d798fcdc13a3e9f4d20ed20fd6702`。代码或构建变化后必须使用新根重新准备。

## 真实兼容测试：等待区域设置

用户已在本机遮罩登录录入 Go Key，并明确要求立即开始测试。只核对唯一匹配的 Go 登记与系统凭据可用状态，没有输出或重新保存 Key。登记 ID `9e850e73-381d-42ef-b89f-193f931c4442`，原始模型 `deepseek-v4.1-flash`，地址与冻结 plan 一致；源码、构建和验收器身份复核通过。

原兼容阶段已执行 `live --token-budget 20000`，进程约 5.62 秒后失败退出：计划两项，文本项一次请求失败，无模型响应、无工具调用且 usage unknown，连续读取项保留 skipped。生产账本以 `transport_failure` 保留未计量 attempt 并停止，不能把已知 token 汇总为零解释为免费或剩余额度可靠。原目录的 `live-started.json`、`live-{text,result}.json` 与 Session 保留，日志 `.cache/opencode-go-2026-11-03/compat-live.log`，进程收据 `live-process.json`。原验收器没有保存 HTTP 错误细节，不能从这一项单独确定状态码。

随后在用户既有测试授权下另建独立诊断，未恢复或覆盖原阶段。每项及阶段阈值均为 10,000 tokens，最多一次 provider 请求，输出上限 1,024，HTTP 超时 30 秒；元数据和验收器摘要在独立 plan。使用相同生产 runner、deepseek profile/high 和 Session 标识，捕获 SDK 错误的 HTTP 状态、固定错误类别及区域／隐私等提示分类，不保存原始错误正文或 headers。诊断一次请求返回 HTTP 400，区域／隐私提示分类命中，宿主结算为 `usage_limited`；同样无可靠 usage，资源清理完成。诊断独立根的本地索引 `.cache/opencode-go-2026-11-03/diagnostic-root.json`，入口 `diagnose-request.ts`，日志 `diagnostic.log`。诊断进程退出 0 只表示报告写入完成，不表示接口验收成功。

目前共两个真实请求尝试，均未通过且费用／tokens 未知；正式兼容仍为文本失败、工具 skipped，不能合并诊断缩小失败分母。没有继续生成、自动切换端点、调整系统凭据或改 Go 隐私设置。根据错误分类及 [Go 官方说明](https://opencode.ai/v2/docs/console/go/#enable-restricted-models)，下一步请用户在 Console → Settings → Privacy → Regions 启用 Global，DeepSeek 需要该选项；这仍需实际账户设置及后续响应验证，不能把分类提示当作完整服务端根因证明。已向用户发出设置提示，等待其反馈。

用户完成设置后，在新的仓库外目录重新 prepare／offline／live，沿用已授权的首轮 20,000／每项 10,000 tokens 停止阈值，保留原失败与诊断。凭据仍由系统 keyring 读取，无须重新粘贴或重复询问测试授权。未验收前不宣称 Go 已兼容、不启动正式多任务 campaign。原四门禁的代码身份未变；本次只增加忽略目录中的独立诊断材料和文档收据，不重跑无关源码门禁。未提交、推送或发布本轮改动。
