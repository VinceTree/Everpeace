# 当前交接

更新日期：2026-10-08。新 Session 先读根 [AGENTS.md](../AGENTS.md)，再按 [文档索引](README.md) 选择专题。上一轮完整交接与计划见 [连续性历史](archive/HANDOFF_CONTINUITY.md)，更早记录见 [历史交接](archive/HANDOFF_HISTORY.md)。

## 当前基线与授权

- 本轮开始 main HEAD：`77b3cb5dcb36247e5dba3f1425546ca9c2a9cf2b`；包和双语 README 已同步 `0.3.10`。
- 用户明确授权按需项目地图、显式空白容错编辑、双平台 exec 输出修复，完成后自动更新版本、提交并推送 main；不创建／推送 tag、不更新 Release。提交含 `[skip publish]`，保留独立 Test CI。
- 离线 fake provider 验收，不读取模型凭据、不调用真实模型、不付费评测；默认 high／32,768、Responses、Windows native sandbox、单 Agent 和 runner 验证结算不变。不扩展 LSP、MCP、多 Agent 或新协议。

## 本轮实现

- [project-map](../src/tools/project-map.ts) 经现有文件工具注册进入 TUI／exec／SDK 的共享 production Agent，coding／Plan 均可按需使用。path 为工作区内目录，depth 默认 2、允许 1–4，仅影响结构展示。随包 rg 遵守 ignore、不跟随链接，排除依赖／虚拟环境及宿主控制目录，每次重新生成，不自动注入请求或持久化数据库。
- 返回观察结构、文件类型、受限 Node package 元数据、声明入口／脚本与文档／规则／测试／配置／其他语言 manifest 位置；候选入口只按文件名约定，不读取源码正文、规则正文或建符号依赖图。地图作用域不登记规则加载路径，也不登记文件写观察，随后编辑仍需 read_file。
- 枚举 5 秒／2 MiB／10,000 路径；最多 32 份 package manifest，每份 256 KiB、合计 1 MiB；结果 JSON 最多 32 KiB。上限、损坏／变化的文件返回 incomplete、原因与缩小目录提示。
- [apply-patch](../src/tools/apply-patch.ts) 的 replace 增加 matchMode，默认 exact。只有显式 line_whitespace 且精确未命中，才尝试唯一完整行块；仅忽略首尾 ASCII 空格／Tab，保留空行与行内文本，拒绝纯空白／歧义／大小写／标点／内部空格差异。应用实际范围，不自动缩进，保留 BOM／EOL。预览和执行共用定位，返回实际 matchMode、matchedLines，审批正文显示方式与行号。权限 revision、原始字节、并发变化与回滚保护保持。
- [exec-writer](../src/cli/exec-writer.ts) 的 owned writer 扩展到 Windows／Linux 非 TTY 标准流，流写入 callback 后 ACK，父进程控制超时和取消，保持 16 KiB 块及有界队列。先结算 pending 写入、关闭代理流并等待子进程退出，再移除宿主监听器；处理迟到错误，主动清理关闭不伪造任务取消。半条 JSONL 不补终态。
- fixture IPC 分别报告 provider_ready、task_cancelled、task_cleaned、output_cleaned；取消必须先于任务清理。仍检查退出码、owned helper 回收、完整 exit.json、唯一 final／半条无 final，没有跳过回归或仅放宽超时。

相关机制见 [TOOLS](architecture/TOOLS.md)、[RUNTIME](architecture/RUNTIME.md)、[STATE_AND_UI](architecture/STATE_AND_UI.md) 和 [DECISIONS](architecture/DECISIONS.md)。

## 上一轮 CI 的实际失败

[上一轮 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37724288689) 对上述基线双平台失败：

- Linux：stderr 停滞、stdout 停滞及半条 assistant 输出期间取消未及时退出，回归超时结束子进程后退出码为 null；不是成功交付证据。
- Windows：stderr 关闭场景的 exit.json 未完整写入，JSON.parse 报 Unexpected end of JSON input；迟到 stream error 与清理顺序是本轮修正范围。
- 上轮 Release workflow completed／skipped、Publish job 跳过，已有 27 份 Release 元数据未变。该历史结果不能替代本轮推送后核验。

## 本轮验证证据

Windows Node v22.19.0／pnpm@10.22.0。定向离线回归 138 项全部通过，覆盖 agent／生产 factory／exec／SDK、文件与搜索、地图、显式替换、真实输出进程；随后补充权限拒绝／审批期间权限收紧和长空行块回归 11 项全部通过。地图覆盖单包、monorepo、非 Node、中文空格路径、ignore、越界／junction、损坏 manifest、扫描／metadata／输出限制与新增删除后的刷新。编辑覆盖默认精确、显式容错、Tab／CRLF／BOM、完整行／歧义／行内差异、无效参数无副作用、并发／审批变化与回滚冲突。

fake provider 的 [共享生产闭环](../tests/unit/runtime/project-editing.test.ts) 贯通地图定位 → 规则刷新／盲写拒绝 → 读取 → 精确失败 → 显式容错 → 完整宿主验证；另行证明 Plan 广告和地图不加载子目录规则。已有 TUI、exec、SDK 共用 production factory，不新增分叉实现。

最后补齐地图的深层 manifest 元数据诊断和极长路径／文件类型的输出上限保护，以及后述 CI 诊断／取消时序回归，再重新执行最终串行门禁：pnpm typecheck 通过；实际 scripts 无 lint，明确记为缺项；pnpm test 共 759 项，756 通过、0 失败、3 跳过，耗时 47,936.5281 ms；pnpm build 通过。跳过项仍为当前文件系统不允许的 file symlink、Windows 临时目录 alias 和 Unix-only timeout；没有新增跳过以回避输出问题。测试日志在临时目录 everpeace-map-0.3.10-test.log。git diff --check、新文件空白检查及本轮 9 份文档的本地链接检查通过。

定向入口仍使用 node --import tsx --test，当前 Windows 的 pnpm exec tsx shim 未解析成功；pnpm scripts 可运行，依赖／工具链配置未改。完整测试在获准宿主进程运行，供 Windows native sandbox fixture 初始化；模型 shell 的隔离与失败关闭规则不变。

实现已提交并推送为 `abd0b31e1a16e10890332c080a76d27e9cc1fcc2`（feat: add project maps and controlled edits, fix pipe cleanup [skip publish]）。[首次本轮 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37727322912) 的 Linux 安装／typecheck／完整测试／build／差异检查全部通过，758 项、755 通过、3 跳过。Windows 758 项、753 通过、1 失败、4 跳过；唯一失败为新增回滚测试按临时目录原路径比较，未识别 hosted runner 的短路径别名，模拟故障未触发。输出停滞／关闭／取消回归在两平台均通过。现已把故障目标比较改为 realpath，并加入实际目录 alias／junction 复现，定向 5 项全部通过，继续重跑门禁／推送修复，包版本不再递增。

[首次本轮 Release workflow](https://github.com/VinceTree/Everpeace/actions/runs/37727322999) completed／skipped，Publish job 跳过；远端现有 27 份 Release 元数据和 26 个 tag 引用与推送前基线完全一致。后续未改 package.json 的提交不触发该 workflow；最终双平台 CI 完成后继续核对元数据并回填。

继续本轮时，一次本地重跑的 stdout stall 与独立 MCP stdio 回归均跨约 35 分钟后超时，原断言／超时未放宽，保留为无效交付运行；随后完整重跑恢复通过。独立定向复现还发现关闭 stdout 时 write Promise 已失败、Writable error 却等待异步 destroy 后才通知，导致 IPC 取消标记偶尔晚于任务清理。CLI host 已在写入失败边界立即通知取消，继续等待迟到 stream error／close 和 owned writer 清理。真实输出／MCP stdio／容错回归 25 项通过；新增不发 stream error 的失败注入明确验证 stdout／stderr 写失败先取消、后清理，CLI 回归 12 项全部通过。最终完整门禁结果见上，修复继续提交推送，不递增包版本。

修复已提交推送为 `5e04fbc053399a3eb9b1590caf411e3abd259a0b`（fix: cancel failed output writes before cleanup [skip publish]）。[修复后 Test CI](https://github.com/VinceTree/Everpeace/actions/runs/37731315535) completed／success：Linux 759 项、756 通过、0 失败、3 跳过，耗时 66,447.689328 ms；Windows 759 项、755 通过、0 失败、4 跳过，耗时 129,222.3676 ms。两平台安装、typecheck、完整 test、build 和差异检查均通过；Windows hosted runner 的原生 sandbox 跳过范围见 [开发指南](DEVELOPMENT.md)，不当作真实隔离／终端验收。本轮未扩增跳过或放宽输出进程回归超时。该提交没有触发 Release workflow；再次核对 27 份 Release 元数据和 26 个 tag 引用完全未变。实现／测试代码至此固定，交接文档的后续同步不递增包版本或改变发布条件。

## 保持的能力与限制

结构化 assistant 压缩交接、冻结宿主 workflow 事实、 typed tool feedback、Session 历史与附件续读、恢复／fork 的验证债务和文件重新读取边界保持；详见运行时／工具／状态专题及连续性历史。TaskProgress 完成不等于验证成功，Goal 与成功 Memory 仍由 runner 结算。

exec 已支持 --resume 的独立 Session 分支、只读 --plan 输出计划与权限收紧；TUI Plan 通过人工批准才执行，exec 不自动批准。SDK runTask 复用 exec runtime。

Windows LSP 仍因固定 backend 的 TCP/IPv4 网络隔离门禁失败而 unavailable；native sandbox 启动失败不回退宿主。真实 Windows Terminal 的取消、resize／scrollback、恢复与单 prompt 仍需手工验收。离线结果不能证明真实 DS 成功率、缓存命中或 token 成本改善；live smoke／dsh 对照需另行授权及数值预算。固定 dsh 参考仍为 `639ed015397290b3745d163aafe02ffee4aa3f84`。

## 用户原有内容

开始时 tracked 差异为空；已有未跟踪 `.everpeace-benchmark/`、`.patch-node-pty/`、`NUL`、`benchmark/`、`question/`、`test-me/`、`{}` 全部保留，不加入提交、不清理。

最后边界复核补齐 line_whitespace 的纯 Unicode 空白拒绝（含 NBSP、中文全角空格、换页符），默认 exact 及只允许 ASCII 首尾空格／Tab 的匹配规则不变。定向 5 项通过，重新执行完整门禁 759 项、756 通过、0 失败、3 跳过，类型检查／构建通过；版本仍为 0.3.10。该补充继续按同一 skip publish／无 tag 路径提交推送，新的 CI 完成证据随后记录。
