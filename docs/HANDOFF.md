# 当前交接

更新日期：2026-10-09。先读 [AGENTS](../AGENTS.md)，按 [索引](README.md) 定位。

## 当前范围与授权

用户指定版本为 **0.4.0**，package.json 与双语 README 已同步，并授权提交、推送，禁止创建或更新 Release。提交必须包含 `[skip publish]`，保留独立 Test CI；不创建或推送 tag，不发布 npm 包。

用户先要求测试结果不推送远端，随后明确要求将结果图放入 README，并使用 readme-generator skill 修饰中英文首页。授权公开范围为 `assets/features.webp` 汇总图和配套范围说明；详细报告、原始证据、工程门禁和交付收据继续只在本地保存。本地报告入口：`C:\Users\39850\Desktop\Everpeace-test-report-0.4.0`。上一份详细交接也已在该目录保留，不将 private-evidence 加入仓库。

保留原有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}`；不纳入提交。

## 实际修改

- 请求失败且用量未知时，公开 exec/SDK 与共享 runner 提供安全 HTTP 状态或固定错误类别，停止后续准入，不保存供应商原错误正文或密钥。
- Web 搜索依次尝试国际 Bing、中国区 Bing、DuckDuckGo，在总时限内分配每个服务的尝试时间；取消阻止后续尝试。Bing GET 手动重定向并逐次检查公共网络边界，DuckDuckGo POST 拒绝重定向。
- 新增显式开发 fixture `tests/fixtures/live-tool-acceptance.mjs`，复用生产 factory、原生 sandbox 和 coding runner，不新增公共接口，不从 pnpm test 隐式发付费请求。操作约束见 [评测指南](BENCHMARKING.md#independent-live-tool-acceptance)。
- 双语 README 同步上述用户可见行为与指定版本。
- 按用户指定的 readme-generator 优化首屏、上手路径与结果展示；首页复用同一张真实汇总图，lossless WebP 保留原始像素，明确组件证据跨候选、至少一次闭环与未完成项，不发布竞品排名或成本优势。package files 保留 assets，保证安装产物中的 README 图片路径存在。
- 模型 client 增加环境 HTTP/HTTPS 代理与 NO_PROXY 支持；连接由拥有者在请求清理结束后关闭。主 factory、登录、标题、Skill、手动 Memory 与 doctor 使用同一入口；不修改全局 dispatcher、网页 SSRF 或原生 shell 网络边界。新增真实本地 CONNECT、直连排除、取消、关闭后拒绝重连及凭据隐藏回归。
- 工具验收冻结 harness digest，网页场景要求搜索返回的官方来源、实际读取及独立事实断言。旧阶段 unknown 和未执行项保留，详细续测证据在本地报告入口下的独立目录维护。
- HTML 网页工具增量返回真实、有界、去重的 links，供模型沿页面导航；验收按事件先后追溯搜索/链接发现链，正文空白归一化。重复搜索、验收器空白误判和候选变化导致的未执行项均保留在本地，不能覆盖原报告。

当前本地工程门禁：typecheck、test、build 通过；1075 项测试，1072 通过、3 跳过、0 失败，耗时 65224.1699 ms。当前无 lint script，未记为通过。README 汇总图由本地实测记录重新生成，说明独立阶段、原 unknown 停止及保留的失败/跳过；不公开原始报告。

## 后续工作与交付约束

Responses 稳定性、真实模型学习质量与成本仍需独立评测；不能从已授权的工具闭环汇总推断。完整响应未落盘不能执行其中的工具调用；用量 unknown 不能清空或被后续成功掩盖。DeepSeek 阶段先验证原始 `deepseek-flash` 在该中转上的文本终态/usage 和工具配对，再进入个人任务与固定对比；此前 DeepSeek 请求失败不因 Grok 通过而消除。

个人任务、smoke 与正式 DeepSeek 对比仍是独立范围，已有预算草案不构成付费授权。实际运行应冻结候选 revision/source/build digest，代码或构建变化后重新绑定。最终 manifest 门禁按 typecheck → 实际存在的 lint → test → build 串行执行；当前没有 lint script，不能补记为通过。准确提交的 Windows/Linux CI、安装与无凭据 preflight、Release/tag 保护核对保存在本地交付收据。

本次 README 与图片交付的门禁、链接/锚点检查、缩放预览、打包图片原始字节校验及远端核对收据位于上述本地报告目录的 `readme-update-a11e3cf537d34d08bc3728ba639232b6/`。图片保留原实测快照，不把文档交付误记为新增付费测试。
