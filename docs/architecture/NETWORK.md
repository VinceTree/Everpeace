# 公共资源网络边界

网页搜索的 Bing、Bing China、DuckDuckGo、页面读取和 Skill HTTP 下载共用 [公共资源客户端](../../src/network/public-http.ts)。模型 API、MCP 及用户直接 `!` 的网络行为保持各自边界。

## 当前问题与证据

| 项目 | 触发条件／原保护 | 本轮处理与复现入口 | 性质 |
| --- | --- | --- | --- |
| DNS 校验未绑定实际连接 | 先校验域名解析，再由 fetch/Git 独立连接；已有 URL、私网和逐跳保护 | 受控解析器先返回公网、随后返回私网；实际 socket 只使用首次获准 IP，[网络回归](../../tests/unit/network/public-http.test.ts)记录真实连接 | 已修复的潜在 SSRF 风险；不声称此前已利用 |
| 响应释放不完整 | 页面和 Skill 重定向／错误分支未统一释放正文 | 响应租约包住解析，截断、失败、取消和重定向都销毁 dispatcher 并等待 socket close；真实慢响应与大正文回归 | 已修复的生命周期缺口 |
| Git 继承宿主重写与代理配置 | 只有 clone 前 DNS 检查和部分 `-c` 参数 | 本次目标专用 CONNECT 转发器；隔离 Git config/env；真实 HTTPS smart Git 浅克隆与恶意继承配置回归 | 已修复的网络边界缺口 |
| lint 缺项 | 原交付仅 typecheck/test/build | Oxlint correctness 门禁及失败 fixture | 工程门禁，不能当作漏洞 |
| pnpm 补丁分发 | 消费者依赖安装不继承本仓库补丁 | 固定 node-pty，干净源码安装检查实际补丁、CLI/SDK 与原生 PTY | 安装限制，独立分发仍被阻塞 |
| 当前团队候选缺少付费对照 | 已有历史候选及合成 Responses 证据 | 无凭据 preflight、离线评分、候选摘要和待授权分阶段配置 | 验收缺口，不能当作质量失败或已通过 |

历史沙箱修复继续由已有回归保护，不重新标记为当前漏洞。当前执行结果及平台证据只写入 [HANDOFF](../HANDOFF.md)。

## 解析、连接与释放

[地址校验](../../src/network/public-address.ts)拒绝非 HTTP/HTTPS、URL 凭据、本地域名、空答案、非公网／特殊范围、格式或 family 不一致及混合答案。IPv6 采用保守的全球单播允许范围，排除特殊用途和转换范围；特殊用途地址即使存在部分全球可达例外也拒绝。

带 `%` zone/interface 的 IPv6 一律拒绝，即使 Node isIP 将其识别为 IPv6 且其地址位于允许范围。独立 [IANA 地址用例](../../tests/unit/network/public-address.test.ts)覆盖范围首尾、相邻全球单播、注册表例外、映射/转换/scoped IPv6 和 URL 的整数、八进制、十六进制写法；预期值不从生产网段表生成。

MCP 不使用这个仅允许公网的响应租约层。其独立策略要求非回环 HTTPS，本机 HTTP 单独授权，并拒绝全部重定向；长期 SSE 的 dispatcher 归 MCP transport 所有，关闭时统一销毁。启动信任及凭据边界见 [MCP](CODEX_CAPABILITIES.md#启动信任与-http-边界)。

每次请求生成不可变地址快照，新的 Undici Agent 的 connector 只能连接此集合；地址失败时依次使用同一集合，不重新解析 origin。HTTP Host 保留原 URL，TLS 使用原域名的 SNI 与证书身份，始终启用证书校验。每次重定向建立新快照。DNS、连接和正文使用同一个取消／期限信号；系统 DNS 查询本身无法强制取消，迟到答案不能创建连接。

响应只能在 `withPublicResponse` 的消费回调内使用。退出后取消未读正文、销毁 dispatcher、关闭并等待所有直属及 TLS wrapper socket。固定诊断包括 invalid_target、dns_failed、non_public_address、proxy_configuration、proxy_failed、connection_failed、response_failed；不转发内部异常对象或代理凭据。

## 宿主代理与 Git

读取大小写 HTTP_PROXY、HTTPS_PROXY、NO_PROXY，显式小写值优先；HTTPS 无专用代理时可用 HTTP_PROXY。NO_PROXY 支持星号、主机／域名后缀及端口，按域名边界匹配。只支持 HTTP/HTTPS 代理，拒绝 SOCKS/PAC；代理失败不改用直连。代理由宿主配置，是受信任基础设施：CONNECT 目的地是已验证 IP:port，可信代理必须忠实执行该目标。HTTPS 代理自身也进行 TLS 校验；origin HTTPS 在隧道内校验原域名。代理认证只在 CONNECT 发送。

[Git 转发器](../../src/network/git-relay.ts)只监听临时 loopback 端口，使用随机 Basic 认证，仅接受批准域名及端口。Git 保留 HTTPS 源 URL与目标证书校验；转发器向批准 IP 连接，可继续经过宿主代理。克隆退出或取消后关闭 listener、隧道和子进程，不重放调用。

Git 子进程移除继承 GIT_*、代理及 askpass 注入，禁用 system/global config，显式设置唯一临时代理；禁用交互认证、credential helper、extra headers、cookie file、模板和 hooks，禁止重定向及非 HTTPS transport，强制 TLS 校验。认证 token 只通过子进程环境传递，不出现在参数、诊断、Session 或事件中。保留 no-checkout/shallow/sparse 流程和预览确认。

## 回归边界

网络回归使用真实本地 HTTP、TLS、IPv6、HTTP/HTTPS 代理、Git http-backend 与实际 socket 记录。测试通过 Node mock 把校验过的公网 IP 映射到本地监听器，并只在测试 TLS 入口添加公开 fixture CA；生产接口没有本地地址映射或关闭 TLS 的设置。测试证书与私钥是公开的测试身份，仅用于这些本地 fixture。

特殊用途表的来源：[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry)、[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry)。Git 取消先拒绝新 CONNECT，保持已建立隧道直到进程树终止得到证据，再统一关闭转发器，避免断流使 Git 提前退出而与 Windows taskkill 竞态。dispatcher 清理失败仍关闭全部直属 socket，并只报告固定诊断。
