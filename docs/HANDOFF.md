# 当前交接

更新日期：2026-10-09。先读 [AGENTS](../AGENTS.md)，按 [索引](README.md) 定位。此前 Windows Terminal、DeepSeek 中转诊断和首轮 Grok 兼容测试见 [上一轮交接](archive/HANDOFF_BEFORE_GROK_TOOLS.md)；本文件只记录本轮真实工具检查和交付。

## 当前结论与授权

用户要求全部工具在真实模型环境中测试，并明确表示额度可以使用；之后明确指定版本为 **0.4.0**，已授权提交、推送，禁止创建或更新 Release。package.json 与双语 README 已同步。提交使用 `[skip publish]`，不关闭 Test CI、不打 tag、不发布 npm 包。

本轮原始起点 HEAD 为 `7a366caab3ff6e4e59a26de6559d903df92288bc`。**37/37 工具入口有真实调用成功记录，13 个场景至少取得一次闭环，但不能判为全部 live 验收完成。** Plan 修订/批准仍因中转 SSE 不完整而失败，搜索结果相关性也未完成验收。真实编码修复、Goal、后台命令等闭环通过，不证明 DeepSeek 的成功率、长期稳定性或成本优势。

旧 DeepSeek 和 Grok 阶段的 unknown 保持原样。当前检查是用户授权的独立工具场景，不是正式固定任务 campaign；每组新 Session/账本，unknown 停止该组，不续旧账本、不用复测覆盖失败。单组 200,000 token 与汇总已知用量 3,000,000 token 是本轮 harness 守卫设置，不能冒充用户逐字指定的数值，也不是账单硬上限。个人四任务、smoke 和正式 DeepSeek 对比没有因此获得运行授权。

保留原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`；不纳入提交。

## 实测入口和证据

端点 `https://cc2.caaa.tech/v1`，模型原始 ID **`grok-4.6`**，正常 ModelRegistry/SystemAuthStorage 读取既有 keyring auth_ref；没有写出 API Key，没有改日常默认模型。工具使用生产 factory、固定原生 sandbox executor、SessionStore 与共享 CodingTaskRunner，不用 fake provider。宿主 Question/Plan 回答明确标为 fixture，MCP 为真实隔离 stdio 服务，Skill/Memory 使用独立种子目录，Memory 后续捕获关闭。

主要 owned 根：

- `C:\Users\39850\AppData\Local\Temp\everpeace-live-tools-b92b3c47bdc747938a068b1b13727e2c`：首轮 13 组、最终工程/安装收据、完整总览 `tool-coverage.json`。
- `C:\Users\39850\AppData\Local\Temp\everpeace-live-tools-040-99490a7150a54e729dbaadff6ba83474`：当前构建的编辑、历史、Goal、Web 与修复闭环及失败复测。
- `C:\Users\39850\AppData\Local\Temp\everpeace-live-tools-retry-d54460b0d29d48f997bb9f960f4fef01`：后台闭环通过，Plan 失败保留。
- `C:\Users\39850\AppData\Local\Temp\everpeace-live-tools-plan-bfe82a3b656d4b44b2186b883f85c12b`：缩小 fixture 和简化 Plan 提示词后仍失败；不计通过。

每根 `plan.json` / `candidate.json` 冻结实际候选；各组 `result.json`、`tools.jsonl`、`requests.json`、Session JSONL 保留实际调用、HTTP/安全错误和 SSE 类型统计。首轮与复测分别绑定其实际 source/build digest；首轮未变化组件的证据不能冒充全部组都重新在最终构建运行。另有两份未请求模型的 recheck/final 准备根，不能算执行结果。

## 工具与闭环结果

| 场景 | 当前证据 |
| --- | --- |
| 项目地图、目录、文件、文本搜索、glob、搜索续页 | 首轮闭环通过；随机 marker 不在提示词中，模型读取后准确返回 |
| 修改、新建、删除及四类工作区审阅 | 初测改动及快速检查成功，但后续流失败；当前构建独立复测和完整检查通过 |
| 前台 PowerShell | 实际 native sandbox 输出 SHELL_OK，模型取得结果并完成 |
| 后台命令 | 两次后续请求失败均保留；复测观察 BACKGROUND_OK，poll → stop → poll 的 cancelled 状态，清理等待后结算 |
| 大输出分页 | 实际文件输出保留附件，read_tool_output 分页后模型完成；不把附件历史当作写授权 |
| Session 四接口 | 首次 fixture 只写 timeline，搜索模型 context 无结果并触发预算停止；修复为同时追加真实 context，离线证明后复测通过，保留原失败与开销 |
| Question 与进度 | 真实 request_user_input / update_plan，宿主 fixture 回答 blue，模型后续执行与最终回答反映该值 |
| Plan | submit_plan 曾实际执行并返回修订反馈；后续批准未闭环，多次流缺少 response.completed，仍失败，不恢复或伪造批准 |
| Goal | create/get/update 实际调用，修改后全 suite 通过，宿主将 pending completion 结算为 complete |
| Memory 与 Skill | memory_lookup、read_skill 主文件和引用资源实际执行，返回种子 marker；不代表自动学习质量通过 |
| Web | example.com 页面读取通过；首轮搜索国际 Bing/备用失败，修复后 API 与模型返回闭环。通用 IANA 查询曾返回无关网站，相关性未验收；site:iana.org 限定的宿主直接查询取得官方链接，不冒充模型事实问答通过 |
| MCP 六类接口 | ping、资源列表、模板列表、读取、提示词列表、获取均实际执行并闭环；不扩展为任意个人服务/OAuth 验收 |
| Windows 原生导航 | 固定后端的 definition/references/implementation/hover 均实际执行并闭环，不绕过原生探针 |
| 编码修复 | DRAFT 的实际 typecheck/test pass、build 指定断言失败；模型读取失败后修成 NEW，最终 typecheck/test/build 全通过，真实 repair_attempts=1，检查脚本未改 |

总览：工具测试 **98 次模型请求，已知 input + output 647,383 token，9 次请求 usage unknown**；reasoning 已包含在 output，不重复计费。另两个非流式最小诊断各发一请求，均 HTTP 400 / unknown，安全信号指向 streaming 要求；不据此修改生产为非流式或消除先前 unknown。本轮合计 100 次请求，整体计量不完整，已知 token 不是最终账单。初测、所有复测、失败、预算超出和未闭环均保留，不发布成功率排名。

## 实际修改

- 保留并交付此前请求失败诊断修复：有界 attempt 失败且 unknown 时，公开 exec/SDK 和共享 runner 返回安全 HTTP 状态/固定类别，仍停止后续准入，不保存供应商原错误正文或密钥。
- 搜索依次尝试国际 Bing、中国区 Bing、DuckDuckGo，同一总时限内分配每个服务的尝试时间；取消阻止后续服务。Bing GET 手动重定向逐次检查公共网络边界；DuckDuckGo POST 拒绝重定向。回归覆盖首选超时后中国区成功、内网重定向不访问、取消不启动后备服务。
- 新增显式开发 fixture `tests/fixtures/live-tool-acceptance.mjs`；不新增公共入口、不从 pnpm test 发付费请求。分组只装配相关数据/集成，避免不相关 Skill 与目录探索增加请求。历史 fixture 修复不改生产历史语义。
- 双语 README 同步搜索行为和用户指定版本；不宣称全部 live 能力通过。

## 最终门禁与交付收据

最终 manifest 门禁：**typecheck pass → lint script 缺项 → test 1070 项，1067 pass、0 fail、0 cancelled、3 skip（64,511.8735 ms）→ build pass**。日志为主要证据根 `040-*.log`，`040-checks.json` 保存状态。fixture 的 node --check 通过。

隔离 public consumer 安装本地 pack 产物后 CLI/exec help、SDK import 与 runTask 的无模型配置/退出码契约通过；405 个安装构建文件与本地 dist 原始字节一致，见 `040-public-install.json`。首次 --offline 安装因未缓存依赖失败，日志保留；使用显式 npmjs registry 的正常安装通过，不把第一次失败抹掉。

提交前保护基线为 27 个 Release，见 `releases-before-authenticated.json`；未认证 API 的 404 不算保护基线。最终 commit、push、Windows/Linux CI、候选无凭据 preflight 和 Release/tag 不变核对以主要证据根 `delivery.json` 与其关联收据为准；交付前若未完成，保持 pending，不能借用旧提交的 CI。固定个人/十任务 fixtures 未改，最终候选变更需重新绑定相应 preflight 配置。

后续优先处理：取得中转不完整 SSE 的可靠错误/结束记录并完成 Plan 修订审批；补搜索事实问答的相关性验收。继续保留 unknown，不能执行未完整落盘的流中工具，不能将 Grok 工具覆盖当作 DeepSeek 全定位完成。
