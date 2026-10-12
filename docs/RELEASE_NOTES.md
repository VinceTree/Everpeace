# User-facing changes / 用户变更记录

## Unreleased candidate

- Host display supports English and simplified Chinese through `--lang`, `EVERPEACE_LANG` and `/language`, with command/permission identities preserved.
- Task display separates active stage, blocking reason, elapsed time, unknown usage and recovery facts. Cancellation waits for cleanup; unresolved cleanup blocks a new task.
- `--accessible` provides append-only interaction and numbered approval on a TTY; redirected automation continues to use `exec --json`.
- JSONL v1/v2 and public SDK consumers are frozen and tested. Optional stable error identifiers do not change existing exit-code meanings. [Compatibility and migration](COMPATIBILITY.md).
- Conventional project checks now use independent read-only adapters; complete support remains Node single-package projects.
- Bilingual contribution entry points, FAQ, issue/PR templates and current-document path checks are available.

宿主支持自动选择、切换中英文；状态区分阶段、阻塞、未知用量和恢复事实；取消后等待清理，清理失败阻止新任务。辅助终端模式提供追加文本和编号审批；JSONL/SDK 兼容通过冻结消费者验收。项目检查移入只读适配层，完整支持范围保持 Node 单包。新增双语贡献入口和公共文档卫生检查。

Native consumer delivery, npm registry access, real IME/NVDA coverage and five-scenario real-model results are separate acceptance items. Real model tests are paused at the user's request; these changes make no new efficiency or superiority claim. [Current status](core-experience/STATUS.md), [terminal matrix](TERMINAL_ACCEPTANCE.md), [installation](INSTALLATION.md).

原生包、npm 渠道、真实输入法/NVDA 及五类实测分别验收。真实模型测试按用户要求暂停，本候选不新增效率或优越性宣称。

Public path cleanup changes current documents and archives. Historical commits, tags and old source archives may still contain previously published machine paths; history and existing assets were not rewritten.

公共路径清理仅影响当前文档与归档，旧提交、标签及源码归档仍可能包含旧路径；没有重写历史或替换已有资产。
