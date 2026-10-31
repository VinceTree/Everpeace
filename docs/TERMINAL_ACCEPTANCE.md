# Terminal acceptance / 终端验收

Record **pass, fail, not executed, unsupported** separately. Automated input injection establishes runtime behavior, not real IME candidate windows or screen-reader usability. Capture package/commit, OS, terminal build, shell, width, locale, capability flags, steps and observed result in an owned fixture; publish redacted summaries only.

分别记录 **通过、失败、未执行、不支持**。自动输入注入只能证明运行时行为，不能证明真实输入法候选窗或屏幕阅读器体验。使用隔离样例记录准确候选、系统、终端、Shell、宽度、语言、能力标志、步骤和观察结果，仅公开脱敏摘要。

| Manual environment | Columns | Scenarios | Current result |
| --- | --- | --- | --- |
| Windows Terminal + PowerShell 5.1 | 40 / 80 / 120 / 200 | Chinese/English login, help, task, approval, cancel, recovery | Not executed |
| Windows Terminal + PowerShell 7 | 40 / 80 / 120 / 200 | Same flows, resize while draft/approval is pending | Not executed |
| Traditional Windows console | 40 / 80 / 120 / 200 | Narrow-screen task, fallback, exit | Not executed |
| Chinese IME | 40 / 80 / 120 / 200 | Candidate window, composition, Enter, approval-key ownership | Not executed |
| Combining characters and emoji | 40 / 80 / 120 / 200 | Edit, delete, move, wrap, resize | Not executed |
| Long logs, `NO_COLOR=1` | 40 / 80 / 120 / 200 | Meaningful error, progress, review, safe cancel | Not executed |
| `--accessible`, `TERM=dumb` | 40 / 80 / 120 / 200 | Append-only status, numbered choices, reject by default, cleanup | Not executed |
| NVDA + Windows Terminal | 80 / 120 | Accessible login, task, approval, cancellation, summary | Not executed |
| Linux x64 terminal | 40 / 80 / 120 / 200 | Same flows, locale and redirects | Not executed |

Automated coverage is in `tests/unit/tui/`, `tests/unit/cli/accessible.test.ts`, `tests/unit/status/task-status.test.ts`, `tests/unit/runtime/application-coordinator.test.ts` and the frozen public CLI/SDK consumers. Final receipts in [current implementation status](core-experience/STATUS.md) bind results to the candidate. The manual rows above remain unexecuted even when those tests pass.

自动化覆盖见上述目录；最终收据以 [当前实施状态](core-experience/STATUS.md) 为准。自动测试通过不会将人工行升级为通过。

For each manual row: open a disposable Node project; login using the existing credential flow; type a Chinese draft including `é🙂`; switch language without losing it; start a task and verify phase, operation and elapsed time; exercise numbered/reject-default approval; cancel during model, tool and cleanup stages; ensure unresolved cleanup blocks new work; resize and inspect the preserved transcript; close the terminal and verify the resource receipt. Redirected invocations must never prompt; `exec --json` is the stable automation route, with incomplete settlement treated as incomplete.

每行依次验证隔离项目、登录、中文及组合字符草稿、语言切换、阶段与耗时、默认拒绝审批、模型/工具/清理期间取消、清理失败阻止新任务、重排、退出及资源收据。重定向不得进入审批；`exec --json` 是稳定自动化入口，不完整结算不能推断成功。
