# 当前开发计划

本轮用户授权十项全量优化及源码预发布；当前逐项验收以 [优化报告](implementation/REPORT.md) 为准，真实修复/团队收益未达标、Linux 本机验证待服务器。

## 当前：验证证据、隐私、Memory 与性能（20–30）

按用户授权补齐 Request token budget 表述、可选验证解释、任务性能报告、Session 保留/安全导出/扫描、Memory 到期及 revision-bound 审查、Git 子目录/linked worktree、运行时状态抽取、结构化正文及安全属性回归。契约见 [专题](architecture/VALIDATION_PRIVACY_PERFORMANCE.md)，实际门禁与交付见 HANDOFF。

生产保持最多三轮修复和默认单 Agent，benchmark 才能启用修复候选策略。独立 repair/team 交错计划、固定分母和未知计量用于未来对照；无任务专属错误修改证据不能计算错误率或推荐改默认。修复收益、团队收益、Memory 实际模型效果及既有 DeepSeek 闭环仍缺真实数据；本轮零付费调用。

新代码重新冻结候选，不能复用前次成功收据。沿用当前用户的提交、推送、补丁及 Release 授权；保护 PR 门禁、准确候选消费者和专用 Windows required native 全成功前禁止发布。用户机器未就绪时先完成代码和部署说明，不降低门槛。

## 已实施：安全、诊断与评测补丁（11–20）

按用户已批准方案完成私密报告、持续供应链门禁、多层 SBOM 与发布收据、外部来源/宿主注入验收、Web 压力/DOM 与 Brave、分阶段 doctor、九类固定评分器、逐候选成绩与请求费用估算。实现契约与入口统一在 [安全与诊断专题](architecture/SECURITY_AND_DIAGNOSTICS.md)，进度和实际证据只在 HANDOFF。

本轮零付费模型/Brave 请求，第 16 项正式 DeepSeek 与中转 coding 闭环保持未完成。保持 macOS 实验性；专用 Windows Runner 未准备，不能以本机或 hosted skip 代替。本地串行四门禁通过后提交推送，PR 两平台 CI 与新安全门禁成功后合并；冻结 main 候选，再验证同包消费者及准确 commit 的 required native，全部成功前不得创建 tag/Release。未发布候选号沿用，已发布则重新递增并冻结。

## 已实施边界：发布、分发与平台验收补丁（问题 5–10）

共享门禁、准确 SHA 发布 DAG、原生依赖 bundle、独立消费者验收、专用 Windows 必测模式与 Action SHA 固定已实现，保留第 7 项 Oxlint，并按用户选择将 macOS 标为实验性支持。用户授权实施及补丁版本、提交、推送与 GitHub Release；专用 Windows 机器尚未准备，先交付代码和部署说明。远端激活、消费者完整证据与失败演练按下列验收执行，实际进度只在 HANDOFF 维护；原生任务未通过不能发布。

### P0：发布必须依赖同一候选的完整检查（5、10）

1. 将 Test 的 Windows/Linux Node 22 检查提取为同仓库可复用 workflow，供 PR/main CI 与 Release 共用。保留 `typecheck → lint → test → build` 首败停止、安装验证与超时。新增总门禁 job，逐一要求必需 job 为 success，缺失、失败、取消、skipped 均拒绝。实施时将总门禁设为仓库 ruleset/分支保护 required check，并通过 API 回读；YAML 不等于已设置合并限制。
2. Release 改为从 main 上显式 `workflow_dispatch`，输入完整候选 commit SHA；删除 package.json 变化及 tag push 的直接发布入口。验证候选属于 main 历史，后续 checkout、检查、打包与发布始终使用该 SHA，不重新解析 main。禁止把 fork/PR 代码送入专用 Runner。
3. DAG 为候选检查 → 共享 Windows/Linux 门禁 → 构建打包 → 两平台消费者安装；另对同一候选执行专用 Windows 原生验收。最后汇总所有必需结果才创建 tag/Release。仅最终发布 job 授予 `contents: write`，安装/测试任务不持有发布凭据。
4. 只构建一次拟交付 tarball，生成收据，绑定候选 SHA、lockfile 摘要、tarball SHA-256、工具链及验收 run/job 身份。消费者任务下载同一 artifact ID 并核验摘要；发布上传这个已验收包，不临时重建，不接受别的 run/PR artifact 替代。
5. 创建 tag 前核对 manifest 版本；既有 annotated tag 剥离后必须等于候选 SHA，既有 Release 的目标与产物也须匹配。冲突报错，不移动 tag、不覆盖不同资产。按目标版本串行，重跑幂等；检查失败前不得创建 tag/Release。
6. 所有远程 `uses:` 固定完整 40 位 commit SHA，注释发行版本，向所属上游仓库核对对象；复核 Action 的 Node runtime/Runner 兼容性后选择受维护发行版。新增 Dependabot 的 `github-actions` 定期升级 PR，升级继续走门禁。静态规则拒绝远程分支/版本标签及未固定容器引用，允许本仓库相对 workflow 引用。

验收：Windows 必需测试故意失败，以及取消、skip、候选 SHA 不符、包摘要不符、tag 冲突，均阻止发布。先做离线策略回归，再以 failure_drill 运行同一 DAG 的真实 Windows 失败场景，强制 publish skipped；保存 run/SHA/job 证据并核对没有新增 tag/Release。故障注入只能使检查失败，不能跳过必需检查或强制正式发布成功。

### P1：node-pty 修复随安装包交付（6）

1. 分别验证控制台查询竞态、输入 socket 和 worker 清理。先核对上游已发布包，仅当实际包通过所有行为回归，才精确锁定并移除相应本地补丁；上游 main 或 issue 状态不等于发行包已修复。
2. 若无满足条件的发行包，采用维护者构建阶段生成的 patched bundled dependency：在独占 staging 中从校验过的上游包应用补丁，以标准 npm bundle 语义纳入主 tarball。保留源码、许可证、原生安装材料及平台 prebuild，锁定必要构建依赖，记录上游完整 revision、原包完整性和补丁摘要。普通 prepack 拒绝未准备包并指向 pack:release，专用入口执行准备/核验，不能悄悄生成未修补包。不依赖消费者继承 pnpm-workspace.yaml，不增加消费者 postinstall 改写依赖。跨平台 bundle 安装或脚本行为未验证时，分发继续阻塞。
3. 新增独立消费者验收：空项目 `npm install <tgz>`、`pnpm add <tgz>`、隔离 prefix 的全局 CLI 安装。目录不得拥有仓库配置、tsx、源码 node_modules 或用户授权；生产安装不得依赖 devDependencies。明确构建机原生编译工具要求，不能放开全部第三方脚本掩盖问题。Linux pnpm 不执行 bundled 子包脚本，正式 Ubuntu x64 产物需在已校验 staging 编译并携带 `pty.node` prebuild；固定上游只在 macOS 构建 spawn-helper，Linux 直接 forkpty。Windows 本地打包仅作开发。
4. 从安装结果启动 CLI、导入公开 SDK，并实际验证 PTY 输出/输入、resize、正常退出、重复启动、启动即取消与清理。Windows 用 PID/退出证据检查受控后代消失，helper/socket/worker 不拖住宿主，不能只搜索补丁文本。将“AttachConsole 异常返回空列表”和“进程树已清理”分别验收，前者不能证明后者。

验收：同一个 tarball 的 Windows/Linux npm/pnpm/全局安装全部成功，Windows 必需生命周期用例零跳过，用户无需克隆或手动打补丁。保留源码安装回归，更新双语安装说明及实际受验架构；npm registry 发布不是本计划的隐含操作。

### P2：专用 Windows 原生必需检查（8）

1. 使用用户选定的专用 Windows 机器，提供部署清单：Windows/虚拟化能力、MXC backend、Node/pnpm、受限工作账户、专用标签、任务隔离/重置、超时与日志收集。机器提供、配置、注册是外部基础设施依赖，仓库文件不能替代真实机器。优先一次性 Runner/可恢复镜像，不能用带日常凭据的开发账户执行公开 PR。
2. 将 sandbox-boundaries 和 team 测试中的 `GITHUB_ACTIONS` 一刀切 skip 改为明确 hosted/required-native 模式。专用任务先实际探测 backend；能力缺失、零用例、必需测试未执行、skip/TODO、清理失败均失败，不能伪造环境变量代替能力证明。
3. 必需集合覆盖 MXC 启动、取消/超时、detached 后代清理、文件读写越权、控制目录/用户状态/Git 保护、禁网时直接 socket 拒绝，以及两个生产 team worker 的隔离/整合和失败关闭。收据绑定准确 SHA、backend/OS/Node 身份、测试结果及日志摘要；使用离线 provider fixture，不需要付费模型请求。定期巡检不能替代每个候选验收。
4. 仅受信 main 候选和定期任务可触发专用 Runner；不以 `pull_request_target` 执行 PR 代码。发布前检查匹配 Runner 可用性，缺失立即报基础设施失败；限制排队/执行时长，任务前后重置并检查残留进程。专用任务不持有发布 token。

验收：上述真实用例执行且必需集合零跳过；Runner 离线、backend 不可用、网络越权和残留进程均阻断发布。基础设施未接入前，第 8 项与完整发布验收保持未完成。

### P3：保留 lint，明确 macOS 范围（7、9）

- 第 7 项不重复引入 ESLint/Biome：保留锁定 Oxlint correctness、`--max-warnings 0` 与维护目录扫描。临时 fixture 证明 lint 错误返回非零、后续检查停止，核对 PR 总门禁包含 lint。当前没有启用独立类型感知 Promise 分析，不把它写成已完成；更多异步规则另行试跑并收敛误报。
- 按用户选择，在双语 README、开发指南、sandbox 专题统一标明 macOS 实验性支持、尚无完整 CI。暂不加入正式发布必需矩阵；未来升级正式支持须补构建、真实 Keychain、Seatbelt/权限、取消与安装包 CLI/SDK/PTY 验收。Windows/Linux 保证也只覆盖实际验收的系统和架构。

### 实施顺序与交付

先完成发布失败关闭与 Action 固定，再完成依赖打包/消费者验收；专用机器准备可同期推进。最后接入原生门禁、更新平台说明并执行端到端失败演练。对应验收通过后才标记第 5、6、8、10 项修复；第 9 项按实验性范围收敛，第 7 项保留已实现状态。

各阶段定向回归，候选冻结后串行 `pnpm typecheck → pnpm lint → pnpm test → pnpm build`，首败停止，再执行安装包/专用原生/发布失败演练及 `git diff --check`。最终本地和远端证据绑定同一提交，源码变化后重新验证。同步专题、双语 README、决策、计划和 HANDOFF，保留用户已有文件；提交、补丁版本与 GitHub Release 在实施交付阶段按当时明确授权执行，不复用旧补丁成功证据。

依据：[GitHub 可复用 workflow](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)、[Action SHA 与自托管安全边界](https://docs.github.com/en/actions/reference/security/secure-use)、[node-pty 控制台清理问题](https://github.com/microsoft/node-pty/issues/952)。外部报告用于制定回归，本项目行为以实际测试为准。

## MCP 启动信任与传输安全

已按本轮授权实施独立 stdio 启动信任、工作区级持久审批和撤销，非回环 HTTP 全部拒绝、回环 HTTP 单独批准、SDK 全路径重定向拒绝；不扩展 MCP 原生沙箱。配置/环境变化使授权失效，非交互缺少启动信任时在模型请求前停止。实现与稳定边界见 [集成能力](architecture/CODEX_CAPABILITIES.md#启动信任与-http-边界)。

已补充真实 stdio 零启动、跨进程授权更新与撤销、HTTP/TLS/SSE、TUI 取消/resize、headless preflight 和独立 IANA 地址边界回归，并完成串行 typecheck → lint → test → build 与真实终端专项验收；当前证据及实机终端范围只维护在 HANDOFF。用户随后授权按补丁更新展示版本、提交、推送与 GitHub Release；更新候选后重跑门禁，两平台 CI 通过后推送匹配 tag 并核对 Release。保留用户已有文件，不运行付费模型评测。

## 前轮：公共网络、工程门禁与候选验收

此前按网络修复 → lint/源码安装 → 无凭据验收工具及离线证明实施，并另获补丁交付授权；历史结果见交接归档，不授予本轮提交或发布权限。保持仓库内 pnpm 源码安装，HTTP/HTTPS 代理与直连同时受控。新的模型调用或交付仍需独立授权。

| 阶段 | 交付边界 |
| --- | --- |
| P0 | 公共 DNS 地址绑定实际 socket、TLS 原域名身份、逐跳校验、响应租约、宿主代理 CONNECT、认证 Git relay 与继承配置隔离；真实本地网络回归 |
| P1 | 锁定 Oxlint correctness 与警告失败、Windows/Linux 门禁顺序；固定 node-pty、实际补丁检查、干净候选源码安装及 CLI/SDK/PTY 验收 |
| P2 | 可选 team 贯穿 benchmark adapter/worker/config，总账幂等汇总；当前候选无凭据 preflight、同模型离线对照及固定目录 proof，冻结摘要和待授权分阶段配置 |
| 待授权 | 实际模型/profile 与 task/campaign 数值预算确定后才运行协议探测、六次 smoke、六十次正式对照；unknown、清理/隔离失败停止阶段，失败/skipped 保留分母 |

当前风险、历史修复、设计限制及验收缺口在 [NETWORK](architecture/NETWORK.md)分开记录；候选冻结与预算草案见 [TEAM_READINESS](benchmark/TEAM_READINESS.md)。独立 bundle 和消费者验收本轮按上文实施，不引入消费者补丁 postinstall。执行与未完成证据见 HANDOFF。

## 已交付基础：多 Agent、可靠性与开发体验

用户已授权实施 opt-in 团队：根拆任务，最多两个成员调查、编码或审查，根串行整合，宿主完整验证。默认关闭，保留 DeepSeek、Windows、Node/TypeScript 单包方向。具体契约见 [TEAMS](architecture/TEAMS.md)，实际检查、当前版本和实机证据只在 [HANDOFF](HANDOFF.md)。

| 阶段 | 实现与验收范围 |
| --- | --- |
| P0 共享基础 | 不可 reset 的团队计量 scope、集中准入／在途预留、sticky unknown、稳定请求 ID、持久 ownership 与诊断分类；单 Agent 回归 |
| P1 只读协作 | 角色模型冻结、独立上下文、只读成员并行、依赖、取消／权限传播、恢复不继承旧审批 |
| P2 并行编码 | 当前内容快照、detached worktree、真实原生隔离、范围／并发版本检查、串行幂等整合、根最终检查 |
| P3 产品入口 | 英文 /team 面板、状态／诊断、CLI／SDK 共享配置、schema v2 事件、显式继续与产物清理；真实 Windows Terminal 验收 |
| P4 效率与扩展 | project_map 入口／import／测试候选、内容指纹缓存、团队重复调用观察、Skill 来源／更新预览／卸载、MCP 显式重连、离线固定对照 |

阶段先跑定向回归，最终串行 typecheck → lint→ test → build，首败停止并执行 git diff --check。原生 Windows/Linux 与真实 Windows Terminal 的实机证据不能用 mock 或 CI skip 替代；当前状态以交接为准。

固定单 Agent／团队 fixture 使用合成 Responses、实际 Git/native executor 和独立断言，记录评分、耗时、tokens、重复调用、冲突与人工介入。它验证工程行为，不证明实际模型质量或效率；不改变默认循环策略。后续付费对照需新的 campaign/task 数值预算授权。

## 保留的后续范围

DeepSeek 既有协议工程及付费 A/B 准备保留；历史候选不能代表当前团队实现，源码变化需重绑定 source/build/harness/evaluation digest。预算草案见 [BENCHMARKING](BENCHMARKING.md)，不构成调用授权。递归团队、成员互调、远程分布式执行、Web/Desktop、OAuth、私有 Skill 和插件市场留待独立设计。

此前团队交付已完成，证据见交接归档。历史交接本身不授予新操作权限；本轮提交、推送和补丁交付按当前用户明确授权执行，付费模型实验仍需另行取得数值预算授权。保留用户全部既有 tracked/untracked 内容。
