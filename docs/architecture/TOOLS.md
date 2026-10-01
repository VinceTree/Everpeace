# 工具：文件、规则、搜索与后台命令

本文是工具修改的知识入口。启动仍先读 [AGENTS.md](../../AGENTS.md) 和 [HANDOFF](../HANDOFF.md)；只修改某类工具时，阅读对应小节及链接的实现/测试即可。请求与最终结算见 [RUNTIME](RUNTIME.md)，权限配置和原生后端细节见 [PERMISSIONS](PERMISSIONS.md)、[SANDBOX](SANDBOX.md)。

## 职责地图

| 能力 | 主要实现 | 回归入口 |
|---|---|---|
| 读取、目录、搜索、glob | [files.ts](../../src/tools/files.ts) | [files.test.ts](../../tests/unit/tools/files.test.ts) |
| 文件版本与结构化编辑 | [file-version.ts](../../src/tools/file-version.ts)、[apply-patch.ts](../../src/tools/apply-patch.ts) | [apply-patch.test.ts](../../tests/unit/tools/apply-patch.test.ts)、[ReactAgent tests](../../tests/unit/agent/react-agent.test.ts) |
| 项目规则链 | [project-context.ts](../../src/agent/project-context.ts) | [project-context.test.ts](../../tests/unit/agent/project-context.test.ts) |
| 结果截断与续读 | [context-limits.ts](../../src/agent/context-limits.ts) | [context-limits.test.ts](../../tests/unit/agent/context-limits.test.ts) |
| 模型命令与后台任务 | [bash.ts](../../src/tools/bash.ts)、[background-jobs.ts](../../src/tools/background-jobs.ts) | [bash.test.ts](../../tests/unit/tools/bash.test.ts)、[background-jobs.test.ts](../../tests/unit/tools/background-jobs.test.ts) |
| TypeScript 导航 | [code-navigation.ts](../../src/tools/code-navigation.ts) | [code-navigation.test.ts](../../tests/unit/tools/code-navigation.test.ts) |
| Git 状态与 diff | [workspace.ts](../../src/tools/workspace.ts) | [workspace.test.ts](../../tests/unit/tools/workspace.test.ts) |
| 公共网页 | [web.ts](../../src/tools/web.ts) | [web.test.ts](../../tests/unit/tools/web.test.ts) |

`ReactAgent` 负责广告工具、解析参数、观察读取、审批和 dispatch；工具实现不自行决定任务成功。新增工具要同时检查快照广告、Plan/权限、取消、结果持久化与最终变更追踪，不能只添加 schema。

## 文件读取与版本

- `read_file` 限定工作区内的普通 UTF-8 文本文件，最大 16 MiB；二进制和非法 UTF-8 拒绝。
- 参数 `start_line` 为一基行号，`max_lines` 默认 200、最多 1,000；返回 `start_line`、`end_line`、`total_lines` 和 `next_line`，中段内容可以继续读取。
- 返回的 `sha256` 是完整原始字节指纹，不是当前页或解码后文本指纹。不存在的文件返回 `exists: false` 和空版本。
- 路径先检查词法包含关系，再检查真实路径；不能利用 symlink/junction 越出工作区。Windows ADS 不支持；Linux 文件打开还使用 no-follow/non-blocking 保护。
- `list_directory` 返回有界条目及类型，不递归授权整个目录。搜索或 LSP 返回文件位置不等于读取过文件版本。

`ReactAgent` 在进程内维护 `read_file` 观察记录。update/delete 必须已有本进程观察版本，模型省略 `expectedSha256` 也不能绕过；模型提供的版本若与宿主记录不一致立即拒绝。Session 恢复的历史文本不能重新授权覆盖文件，恢复后必须重新读取。

`decodeTextFile` 从原始字节计算 SHA-256，并分别保存 BOM 和换行风格；编辑编码复用原文件的 UTF-8 BOM 与 LF/CRLF 风格，回滚保存原始字节。混合换行按检测到的风格编码，不应宣称任意混合格式逐字节保持。

## 结构化编辑、审批和撤销

`apply_patch` 接受 create/update/delete 操作，由宿主预览并绑定观察版本。审批绑定预览文件 SHA-256 与权限 revision；审批期间权限变化或文件内容变化时不能沿用旧批准继续写入。create 使用排他创建，不能把期间新增的用户文件覆盖。

真正写入前再次比较目标版本；update 使用临时文件原子替换，delete 检查原版本后删除。工作区控制目录与平台状态保护继续有效，详见权限文档。

批量写入失败后，只逆序回滚本批已实际修改的文件，而且当前文件必须仍匹配本批 post-image。用户在此期间再次修改时保留用户内容，返回 `rollbackConflicts`；回滚 IO 错误返回 `rollbackErrors`，不能无条件报告 `rolledBack: true`。

`/undo` 使用 [TurnCheckpoint](../../src/workflow/checkpoint.ts) 的进程内检查点，只恢复结构化编辑，不承诺撤销任意 shell 副作用。恢复前比较当前版本，发生冲突不能覆盖用户内容。检查点及文件内容不写入 Session JSONL，重启后不伪造可撤销状态。

文件观察是防止盲写的必要条件，不替代完整验证；显式修改 ignored 文件也要纳入工作流追踪，详见 [RUNTIME](RUNTIME.md)。

## 按路径项目规则

`ProjectRuleSnapshot` 包含工作区根到已访问目标目录的 `AGENTS.md` 链、相对 scope、原始内容指纹、scope revision 和加载诊断，同时提取根 `package.json` 的开发脚本信息。

每个逻辑 step 读取根和本轮已访问路径的规则；普通网络重试复用当前快照。文件创建也检查目标父级规则。结构化编辑前加载目标的最新规则，发现模型尚未收到的 scope 或 revision 时返回 `rules_refresh_required`，到下一采样边界重新提供后才允许重试。

规则文件单项上限 128 KiB，总量上限 256 KiB，manifest 上限 256 KiB。不可读、越界、超限都保留诊断，不能静默声称已读全规则。

规则更新通过既有 context 渠道持久化；每次请求以当前有效快照替代历史版本，压缩过滤过时的 snapshot。恢复 Session 后从当前工作区重新读取。项目规则不会提升权限或覆盖更高优先级指令。

README、HANDOFF 等按任务需要读取；规则链并不意味着自动装入所有项目文档。修改规则语义时同时覆盖新增目录、规则删除、审批前更新及压缩后的恢复回归。

## 可遍历搜索与工具输出

`glob_files`、`search_files` 使用参数数组启动 ripgrep，不拼接 shell。路径限定当前工作区，遵守 rg ignore 规则；包含 hidden 文件不等于忽略 `.gitignore`。搜索默认 fixed string，只有显式 `regex` 才启用正则。

| 范围 | 当前上限/行为 |
|---|---|
| 搜索页 | 默认 100 项，最大 200 项 |
| 单次搜索收集 | 最多 5 秒、2 MiB，按流收集结果 |
| 后续页面 | `read_search_results` 使用 opaque continuation |
| 模型单项工具结果 | 默认最多 32 KiB，保持有效 JSON envelope |
| 大结果存储 | 进程内最多 16 项，每项保留前 2 MiB |
| 工具结果续读页 | `read_tool_output` 最多 24 KiB，按 UTF-8 边界切片 |

`has_more` 只表示还有已保留页面；`incomplete` 表示搜索达到时间/字节限制，需缩小 query 才能继续获得未收集结果。两者不能混为“下一页会涵盖所有匹配”。每个 continuation 消费后生成下一引用，未知/过期引用要求重新搜索，Session 恢复不保留引用内容。

搜索结果行列来自 ripgrep，其中 column 是字节偏移加一；LSP column 则是 UTF-16 位置，中文行中不能直接等同。

大输出返回 `status: truncated`、`output_id`、首尾预览、原始/保留字节数和续读入口，不能直接截断原 JSON。超过保留上限的内容明确 `retention_truncated`，此时也不能宣称续读可取回全部正文。引用内容只在进程内保存，不新增磁盘敏感输出日志。

终端展示与模型上下文限制分离；模型结果压缩不能悄悄缩小已有 `/outputs` 或 scrollback 的保留语义。命令输出实现还需查看 [command-record](../../src/tools/command-record.ts) 和 [bash-output-preview](../../src/tools/bash-output-preview.ts)。

## 模型 shell 与后台任务

模型 `bash` 使用固定原生后端，不能在 sandbox 启动失败后回退宿主执行。shell 网络和公共 web 开关分别管理，审批与命令规则必须在每次执行时检查。用户主动输入的 `!` 是另一条 PTY 路径，不代表模型 shell 也有宿主权限。

`start_background`、`poll_background`、`stop_background` 复用模型 shell 的权限及执行器：最多两个运行任务，每项默认十分钟，没有交互 stdin。启动立即绑定 coding task 的 AbortSignal，poll 返回运行首尾预览和终态结果。

完成任务保留受数量和输出字节约束，最多 20 项、总终态输出 4 MiB；旧任务可被淘汰。job ID 是进程内状态，恢复 Session 不能假装恢复旧进程。

取消、预算停止、异常、权限收紧和退出应用都需要终止并等待进程树。最终验证前 runner 等待所有后台命令收束，清理未结束不能开始新的编码任务。进程树停止实现位于 [process-cancel](../../src/tools/process-cancel.ts)，Windows 和 Unix 路径分别覆盖。

等待和取消不是只改 UI 标签：测试必须验证实际任务结束，特别是采样中取消后不能残留写文件进程。原生 Windows Terminal 的端到端证据与 hosted CI 的跳过范围单独记录在 HANDOFF。

## 可选 TypeScript 导航

显式配置 `EVERPEACE_TYPESCRIPT_LSP` 才暴露 `code_navigation`；`EVERPEACE_TYPESCRIPT_LSP_ARGS` 为 JSON 字符串数组，默认 `--stdio`。不下载或自动安装服务器；可用性由 `/doctor` 展示，缺失时仍可使用 lexical search。

支持 definition、references、implementation、hover。输入位置为一基 UTF-16 行列；查询按工作区串行，每次读取当前目标文档、启动服务器并 `didOpen`，请求结束后 `didClose` 和关闭进程。因此文件修改后下次查询读取新内容，不依赖旧编辑器缓冲。

单次请求上限 30 秒，文档上限 16 MiB，位置最多 100 项，hover 文本最多 64 KiB。目标路径校验工作区真实路径；返回位置只保留工作区内的 file URI。

宿主拒绝所有 server 发起的请求，包括 applyEdit 和 executeCommand。导航结果不写入文件观察记录，不授权随后 patch；修改前仍需 `read_file`。

**执行边界：当前 LSP executable 由 `child_process.spawn` 以 `shell: false` 直接启动，不经过模型 Bash 的 native sandbox。** “只读”指已实现的 LSP 协议能力和查询路径检查，不是对任意配置程序的 OS 隔离保证。只配置可信的本地程序；若后续接入原生执行接口，必须同步修改此处与对应集成测试。

## 外部工具与修改检查表

公共 `web_search` / `web_fetch` 为普通 function calls；请求失败返回工具结果。fetch 每次重定向都检查公共 HTTP/HTTPS 边界，禁止 localhost、内网和链路本地；返回正文始终是不可信数据。

MCP 和 Skills 已实现，不在本文重复配置细节；参见 [CODEX_CAPABILITIES](CODEX_CAPABILITIES.md)。MCP annotations 不能自动授予本地并发资格，Skill 名称冲突必须从目录和按名读取中排除。

完成工具改动前，检查四个方向：参数/路径边界、取消和审批后的权限复查、结果配对与持久化失败、最终变更追踪与验证。对应单测通过后按根 guide 执行交付门禁，并在 HANDOFF 区分自动化已验证与真实模型/终端尚未验收的范围。
