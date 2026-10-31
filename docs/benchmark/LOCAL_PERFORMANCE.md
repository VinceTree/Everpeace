# 本地离线性能对照

用 [local-performance.mjs](../../scripts/benchmark/local-performance.mjs) 测量已构建代码，不调用 provider、keyring 或真实 Session。当前结果及原始样本位置在 [HANDOFF](../HANDOFF.md)。原始日志与本机路径留在 ignored 证据目录，不作为公开资源打包。

## 运行

先为基线和候选准备依赖相同的源码 checkout，并分别构建。两个 checkout 的 `native/files/bin`、`native/process/bin` 必须完全相同；Windows 本地 NTFS 的安全原生组件必须可用，其他平台不能把 unavailable 当成性能收益。可以从明确 Git revision 的只读 archive 准备基线并链接当前依赖目录，不切换或清理日常工作树。

```powershell
pnpm build
node scripts/benchmark/local-performance.mjs prepare .cache/perf-example
node scripts/benchmark/local-performance.mjs compare .cache/perf-example paired C:/path/to/baseline-checkout
```

`prepare` 要求目标不存在，生成固定合成数据；`compare` 要求已有 fixture，产物 `paired.json` 排他创建，不覆盖旧证据。候选默认是脚本所在 checkout；`EVERPEACE_PERF_CHECKOUT` 可显式选择另一候选。单臂诊断可运行 `measure <fixture-root> <label>`。每次复测使用新的 label，保留失败和退化候选。

脚本在测量前后核对 fixture、源码、构建与原生摘要，记录 runner 摘要、Node、平台、架构和 CPU。每场景两臂各九次，奇偶轮交换先后顺序，全部串行运行。每次创建新 Node 进程；API 计时在模块加载后开始，CLI 计时覆盖进程启动直到退出。禁止同时运行测试、构建或其他重负载来污染采样。

## 场景与正确性

| 场景 | 固定工作量 | 成功条件 |
| --- | --- | --- |
| CLI | 编译入口 `--lang en --help` | 退出成功并显示帮助；不启动凭据或模型 |
| 长 Session | 交替 timeline/context 后最终压缩 | 恢复全部可见消息与最终 context |
| 历史搜索冷缓存 | 独立 Store，标题／正文合成集合 | 总匹配数、分页数、skipped 与双臂一致 |
| 历史搜索暖缓存 | 同进程先执行相同查询，再计时 | 同上，同时保留 cache hit 和读取计数 |
| 项目地图 | 多包目录、源码／测试、ignore fixture | 全部预期文件，不能枚举超时，双臂原因一致，原生退出已确认 |

API 样本保留墙钟、宿主 CPU、进程峰值 RSS、读量／缓存计数与正确性摘要；CLI 只保留完整进程墙钟。原生所有者记录只保留有界最近收据；其累计时间不是任务墙钟，并发时不能相加当耗时。中位数用于比较，九次样本的 nearest-rank p95 等于样本最大值，不据此承诺稳定尾延迟；常规测试不以耗时阈值作门禁。

这是新进程冷启动，未清空操作系统文件缓存；API 恢复不包含 Ink 历史渲染，CLI help 不等于真实终端首 prompt。项目地图仍可能因源码候选或输出上限标记 incomplete，但枚举必须完整且原因一致。合成文件树不代表任意真实大仓库，也不证明模型速度、成本、成功率或其他平台收益。
