# 当前交接

2026-10-24：第三轮按用户授权测量 CLI 冷启动、长 Session 恢复、历史搜索和项目扫描，依据复测优化，完整门禁后提交并推送。分支 `codex/public-contract-core-experience`，起点 `85695e8fd187d710fcd18d9200ad86309a9f0eb5`，开始时工作树干净；展示候选仍为 `0.6.0-rc.4`。未读取 keyring 或真实 Session，未调用模型、付费评测、改版本、打 tag 或创建 Release。

上轮取消、清理失败和持久恢复修复已提交推送，证据在 [历史交接](HANDOFF-2026-10-24-core-recovery.md)；旧结果不作为本轮门禁。原有 ignored 用户目录及私有材料保持原样，所有性能数据为新建隔离合成 fixture。

## 测量与结果

入口 [local-performance.mjs](../../scripts/benchmark/local-performance.mjs)，协议见 [本地性能对照](../benchmark/LOCAL_PERFORMANCE.md)。基线为上述 Git revision 的只读 archive 独立构建，链接同一依赖；两臂原生组件摘要相同。每场景每臂九次，奇偶轮交换顺序、串行创建新 Node 进程。测量前后核对 fixture、源码、构建与原生身份，全部正确性断言通过。

Windows x64、本地 NTFS、Node 22.19.0、pnpm 10.30.3，Intel Core Ultra 5 125H。原始逐次墙钟／CPU／峰值 RSS／trace／身份保留在 `.cache/performance-round3-final/paired.json`，fixture manifest 同目录 `fixture.json`；基线构建在 `.cache/performance-round3-v3/baseline`。fixture SHA-256 `aae98281858fa211d9034914534fc7d48b3296015c2cacd9457cbf1584c4f652`，runner SHA-256 `473ffa92acf21d7e0edfd1ae1797bb7b0ea6db67aa7ca611a28b488d198e2b84`。

| 场景 | 优化前中位 ms | 优化后中位 ms | p95 前 → 后 ms | 结论 |
| --- | ---: | ---: | ---: | --- |
| CLI `--lang en --help` | 96.08 | 94.99 | 104.05 → 99.48 | 持平，未修改 CLI |
| 长 Session 恢复 | 537.53 | 499.91 | 544.98 → 539.66 | 下降 7.0% |
| 历史搜索冷缓存 | 223.54 | 209.68 | 226.97 → 214.13 | 下降 6.2% |
| 历史搜索暖缓存 | 18.73 | 18.67 | 22.32 → 19.16 | 持平 |
| 项目地图扫描 | 7215.16 | 4957.00 | 7373.56 → 5109.03 | 下降 31.3% |

九次样本的 nearest-rank p95 即样本最大值，不承诺稳定尾延迟。CLI 是新进程帮助启动，未清空 OS 缓存，不含终端首 prompt；恢复计时不含 Ink 渲染。合成目录不证明真实大型仓库、跨平台或模型收益。

- 长日志 103,956,100 字节／80,002 记录，恢复 40,000 条 timeline 与最终一项压缩 context；两臂读量相同，最大输入缓冲均 66,840 字节。异步交接从逐条降至 1,587 批。峰值 RSS 中位 255,520,768 → 253,362,176 字节，不宣称稳定内存下降。
- 搜索 100 个 Session、32,100 记录，冷读均 11,283,100 字节；总匹配 100、返回 50、skipped 0，暖缓存 100 次命中且没有新增日志读取。缓存上限和正文匹配语义不变。
- 项目 fixture 为 20 包、422 个可枚举文件，含 ignore 内容；两臂都完整枚举，唯一 incomplete 原因为既有 `source_insight_limit`。原生启动均 128 次且退出已确认；未通过减少检查或漏扫提速。项目峰值 RSS 中位 70,397,952 → 73,805,824 字节，宿主 system CPU 中位 328,000 → 422,000 微秒；并发以少量内存和 CPU 开销换取墙钟收益。

## 瓶颈与修改

- 初始完整扫描中位约 7.37 秒，128 次安全原生进程访问的累计所有者时间约 5.9 秒；改为每批最多四个源码候选读取，全部仍经原生安全访问、workspace pin、固定进程所有者与清理。每批全部结算后按文件顺序应用原有字节预算和输出顺序；typed 清理失败优先于取消，不启动下一批。
- 初始长 Session CPU profile 显示逐记录 UTF-8 解码及重放占主要成本。整块解码候选使恢复退化到约 598 ms，已撤掉；最终只合并块内异步交接，每条仍独立解码，保留跨块 UTF-8、旧大记录、固定 EOF、尾部损坏和取消检查。
- 诊断证据保留在 `.cache/performance-round3-v3/{before,candidate,replay-batched}.json` 与 `restore-before.cpuprofile`、`help-before.cpuprofile`。较大初始项目样本触发枚举期限，未纳入对照；初始 fixture 缺少 compaction automatic 字段被正确拒绝，修正后另建 fixture，未更改生产校验。
- CLI profile 未显示需要扩大本轮范围的启动瓶颈；暖搜索已有缓存收益，不增加持久索引、schema、依赖或模型配置。生产文件改动仅 SessionStore 与 project insights；双语 README、专题、计划、项目地图与开发指南同步。

## 本轮验证

新增多小记录的真实 JSONL 重放／搜索位置回归，以及受控四路读取、乱序字节预算、取消等待、并发 typed 清理故障和当前字节缓存复核。首批定向 streaming／insights 9 项通过，0 失败／跳过；日志 `.cache/performance-round3-targeted-initial.log`。交错性能对照另通过全部正确性、fixture 和构建身份断言。

完整门禁按实际 package scripts 串行执行 typecheck → lint → test → build，一次全部通过；1367 项测试，1364 通过、3 跳过、0 失败，约 306 秒。日志 `.cache/performance-round3-gates/{typecheck,lint,test,build}.log`。跳过为本机文件 symlink、Windows 临时目录别名专门场景和 Unix 超时子进程实测，与前轮一致。

补充静态检查通过：164 份公开文档路径和链接、953 组双语语言键与插值、workflow 固定身份及门禁、`git diff --check`。门禁后只补充本交接收据；提交前重查文档、暂存差异及最终源码／构建身份。

最终源码及 JS 构建摘要与性能采样候选一致。门禁 pretest 会重编译原生 helper，采样时与门禁后的原生摘要分别保存在 `.cache/performance-round3-final/final-identity.json`；两臂采样期间的原生身份相同，原生源码和构建参数未修改。

## 交付边界

本轮按授权以 `perf batch session replay and bound project reads [skip publish]` 提交并普通 fast-forward 推送当前分支，推送后核对远端 SHA，不使用 `[skip ci]`。Release workflow 仍仅 main 显式 dispatch；当前功能分支 push 不自动触发 PR/main Test，不声称远端 CI 已通过。真实终端、干净安装、取消收尾性能和跨平台仍未验收，不因此扩大当前授权任务。
