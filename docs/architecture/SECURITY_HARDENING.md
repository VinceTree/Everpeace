# 安全边界与隐私加固

本文记录问题 01–12 的当前实现与验收边界。当前版本、提交和检查结果只在 [HANDOFF](../HANDOFF.md) 维护；此前公开契约工作见 [历史交接](../archive/HANDOFF-2026-10-12-core-experience.md)。

## 文件访问与提交

Windows 本地 NTFS 使用随包 C++ 文件辅助程序，进程间只传有界二进制协议，不传 shell 文本。工作区对象身份在当前进程固定，根到父目录逐层持有句柄，拒绝重解析点、ADS、非普通文件与多重硬链接。目录枚举和文件读取使用句柄相对访问；实际打开对象不依赖先前检查的绝对路径。辅助程序缺失、摘要不匹配、协议异常及其他平台/文件系统均返回 `FILE_ACCESS_UNAVAILABLE`，没有旧宿主实现降级。

update/delete 在目标句柄禁止并发写入和删除期间比较完整原始字节。更新先保留原文件与受限访问的恢复日志，再排他安装完整的新文件；竞争者在间隙创建目标时保留用户目标与原版本，返回冲突。目标路径可能短暂不存在，不能称为单步原子替换。正常更新复用原 DACL/文件属性；原始字节检查点保留 BOM 与换行。回滚与 `/undo` 复用同一版本约束提交，不覆盖后来保存的文件。取消、辅助进程失联和清理未知不能声称回滚成功。

恢复材料不进入文件工具、模型上下文、搜索或 Session。`everpeace recover-file <workspace> <relative-backup-path>` 验证日志、备份身份与原始字节，只在目标缺失或仍匹配本次 post-image 时恢复；用户修改会阻止恢复。恢复材料有独立生命周期，冲突或崩溃后须显式恢复/清理；不随 Session 保留期限删除。恢复采用保守权限，不承诺恢复此前所有 ACL 配置。内核权限、恶意可写映射和管理员进程不属于本轮已验证并发模型。

搜索从安全枚举和安全读取取得内容，再通过 stdin 交给固定 `rg --no-config`；rg 不重新打开原工作区文件。敏感文件不返回搜索摘录，应通过 `read_file` 单独审批。枚举、内容字节和结果有界，达到限制返回 incomplete。安全遍历支持分层 `.gitignore`/`.ignore`/`.rgignore` 常用 glob 与反选，排除控制目录/node_modules；不承诺完整复制 Git ignore 语义。改动审阅的未跟踪/未暂存正文也从原生层取得，Git 提供索引/已暂存基线；Git 元数据是独立边界。

源码：[safe-files](../../src/tools/safe-files.ts)、[原生程序](../../native/files/main.cpp)、[恢复](../../src/tools/file-recovery.ts)、[patch](../../src/tools/apply-patch.ts)、[checkpoint](../../src/workflow/checkpoint.ts)。

## 敏感内容与外传

敏感路径包括 `.env` 及变体（模板也不自动豁免）、`.npmrc`、凭据目录、私钥与恢复材料；内容扫描复用已有规则。工具输出、附件、项目规则、Skill/MCP 描述与 Memory 在进入上下文前共用保护：遮罩、本次授权原文或拒绝。原文确认说明模型供应商接收及 Session 保存，绑定权限 revision；文件读取还复核原始版本与对象身份。遮罩读取不登记覆盖文件的观察授权。

原文敏感状态用宿主上下文标记保存；压缩不清除进程内状态，恢复/分支未知历史保守视为敏感，历史审批不恢复。敏感状态进入前停止既有后台任务与 MCP，并等待真实清理。Web、MCP 与相关 shell 动作逐次确认；审批期间权限变化使授权失效。Web 重定向目的地重新判断。模型 shell 默认禁网；`/permissions` 显式启用后每条命令需确认，授权范围是整个进程联网能力。项目配置不能提升权限。Plan 保持工作区只读，并遵守联网和敏感外传审批；界面分别显示三个边界。

原生 shell、LSP、MCP 配置拒绝已发现工作区敏感路径、常见用户凭据根及应用状态。检测规则不是完整秘密识别器，未识别业务数据、恶意编码或显式宿主/full-access 例外仍需要用户判断。本轮合成攻击证明宿主阻止受测的禁止副作用，不证明真实模型不会受 Prompt Injection 影响，也不代表已复现过真实凭据泄露。

源码：[敏感保护](../../src/permissions/sensitive-access.ts)、[Agent](../../src/agent/react-agent.ts)、[sandbox policy](../../src/tools/sandbox-policy.ts)。

## 验证与 MCP

任务开始捕获 manifest 原始摘要、四项脚本及 pre/post 生命周期、packageManager 和锁文件选择依据。快速/最终/手工 suite 每项启动前复核。无关元数据变化只通知，执行依据变化或恢复缺可信基线需要 `verification_basis` 审批。批准后再次变化立即失效；拒绝或非交互缺授权保留未验证债务，不能结算 Goal 或成功 Memory。当前实际存在的检查仍按 typecheck → lint → test → build 串行执行，首败停止。

stdio MCP 默认原生沙箱、禁网和过滤环境，权限不高于根策略。`/mcp mode <server> sandbox|host` 先预览具体程序与权限，再保存用户级模式；模式变化关闭旧进程并撤销旧信任，须重新 `/mcp trust <server>`。host 是显式宿主权限例外，工具调用审批不隔离其初始化动作。关闭不能确认时保留清理债务。

启动信任包含程序、可识别入口脚本、邻近 manifest/锁文件的内容摘要与隔离模式。审批提交、调用/启动与重连复核；动态下载 launcher 只允许一次启动，不保存可重复使用的启动授权。预览显示安全 flags、数值及已识别安全脚本路径，秘密和不明参数遮罩，拒绝终端控制字符。摘要复核不等于原子执行文件加载，也不验证全部传递依赖，因此问题 08 按缓解处理。

## 隐私与测试

`/history no-save` 关闭下一次输入历史保存，Session 仍保存对话。疑似秘密提交前提供遮罩/原文/取消；授权原文也不写输入历史。历史 v2 保存 Session ID、时间和策略，v1 不猜归属，删除 Session 清理对应记录；旧未关联记录须单独清理。恢复不会从 Session 文本自动补回输入历史。

首次交互设置推荐 30 天，并复核所选期限的清理预览。未确认配置不启用自动清理；已有配置保留原策略。非交互用户使用 `privacy preview`/`configure` 明确设置。活动、所有权未知和保留团队 Session 仍不自动删除。删除不等于抹除备份或外部副本。

## 验收口径

回滚、undo 和恢复同时核对实际提交的原始字节与对象身份。含敏感标记、已识别敏感读取或秘密的恢复上下文重新审阅；缺交互授权在模型请求前停止。遮罩影响当前模型投影，不抹除此前已授权保存的历史。压缩持久化保留敏感边界标记。

团队敏感状态由宿主双向传递，原文进入成员模型、成员 Session 或团队存储前重新审阅，并说明接收模型与存储范围。根与成员审批共用串行队列；首次进入敏感状态等待既有进程清理，保留已完成产物。遮罩文件读取不返回原文 SHA-256，防止低熵秘密被摘要猜测。

二进制整合也使用原生提交与身份校验，保留大文件基线能力。单文件更新/恢复上限 32 MiB，原生管道/读取上限 64 MiB，前后版本合计须留出恢复日志空间；普通 read_file 16 MiB 与 apply_patch 512 KiB 上限不变。超限保留产物并拒绝，不回退宿主替换。团队恢复日志 v2 记录实际安装身份；旧日志缺字段不能推断整合成功或覆盖恢复。

敏感搜索审批包含所选服务及回退目的地，MCP 包含当前目的地和连接绑定；自定义集成缺少对应能力时拒绝敏感调用。

问题 01/02 的原生保证只适用于实现和实际受测的 Windows 本地 NTFS 文件入口；内核/管理员、Git 对象数据库、同一用户恶意替换已安装组件不纳入这一证明。03 作为数据外传风险路径仍待真实模型验证；08 是启动身份变化的缓解，摘要不是原子加载或全部依赖认证；12 的离线设施不能替代真实模型评测。具体执行证据见 HANDOFF。

Windows CI 执行完整测试；Linux CI 仅执行 `test:portable`，覆盖可移植隐私/网络/供应商行为和原生文件能力拒绝。非 Windows 原生用例明确跳过，Linux/macOS 文件能力保持不可用，绿色可移植检查不代表平台文件验收。

组件发布包必须包含 Windows worker 与摘要，禁止包含故障注入 worker。正式跨平台打包流程尚未接入经过 Windows 验收的组件传递，会拒绝缺组件的包；本轮交付源码预发布。Win32 分享与不覆盖重命名依据 [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) 和 [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)。

离线入口：[native races](../../tests/unit/security/native-files.test.ts)、[sensitive/egress](../../tests/unit/security/sensitive-boundaries.test.ts)、[MCP 原生初始化](../../tests/unit/mcp/sandbox.test.ts)及既有六来源攻击矩阵。`pnpm files:verify` 使用单独编译的故障注入程序，该程序不纳入安装包；`pnpm files:smoke` 验证构建后实际安装路径的辅助组件。真实模型验收继续暂停，未执行平台不得列为通过。
