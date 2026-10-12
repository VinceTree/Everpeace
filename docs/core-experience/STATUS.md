# Current implementation status / 本轮实施状态

The baseline is published source commit `1e805410b713ab90ee09040fced7137416186d0c` (`v0.6.0-rc.1`). Candidate changes are maintained on `codex/public-contract-core-experience`. The package identifier and existing tags are unchanged. The user's real-model test deferral is effective: **no further paid probes or experiments** in this implementation stage.

基线为上述已发布源码提交，候选在独立分支实施，不修改包标识或移动旧标签。用户已暂停真实模型测试，本阶段不再执行付费探测或实验。

| Work | Status | Evidence / limit |
| --- | --- | --- |
| JSONL v1/v2, SDK, stable optional error codes | Implemented; targeted consumers passed | `581ccfe`; frozen consumer digests, built CLI and public SDK imports |
| Read-only task projection and cleanup admission | Implemented; targeted tests passed | Existing runtime facts; unresolved cleanup retains the coordinator task |
| Central en/zh-CN catalog, flags and saved preference | Implemented; targeted tests passed | Locale key/interpolation gate; pending approval/draft/revision regression |
| Append-only accessible host | Implemented; basic offline tests passed | Same workflow, permissions and execution runtime; real screen-reader test unexecuted |
| ProjectAdapter extraction | Implemented; targeted tests passed | Historical recognition, scripts and timeouts; non-Node support stays basic |
| Contribution and current-document hygiene | Implemented; scan passed | Current files/archives only; old history is retained |
| Complete Windows gates and install smoke | Passed on frozen source | [Windows receipt](windows-checks.json); 1274 tests, 1271 pass, 3 skipped; smoke 7/7; clean source installation passed |
| Hosted Windows/Linux CI | Not executed for this candidate | Earlier published-source CI does not validate new changes |
| Dedicated native/install delivery and npm channel | Blocked / unopened | Missing native platform receipts and publishing identity; no gate relaxed |
| Manual terminals, IME, NVDA | Not executed | See the separate matrix |
| Five-scenario real-model comparison | Deferred by user | Preserve all 150 planned runs; no efficacy conclusion |

Final source checks bind to commit `fce2321` and its recorded source digest: typecheck, lint, 900-key localization/interpolation checks, public document checks, 1274 tests (1271 pass, 3 skips), build, installation verification, seven native PTY/source smoke tests and workflow checks passed. Clean source installation also passed after its copy list was expanded. Documentation-only receipts follow this code commit. Raw execution records live only in ignored `.cache/private-evidence/` or other owned `.cache` directories.

最终源码检查绑定 `fce2321` 及收据中的源码摘要，1274 项测试、1271 通过、3 跳过；安装烟测 7/7，干净源码安装通过。新增文档收据不修改已检查的运行时代码。原始执行记录只保存于忽略的本地证据目录。


Implementation commits: `581ccfe` (public contracts), `264c066` (status/language), `f162a4e` (project adapters), `edfa463` (acceptance/contribution), `fce2321` (late cleanup ownership).

Windows development packing produced an older `edfa463` tarball, then failed while downloading the pinned SBOM scanner through the local proxy (`UND_ERR_SOCKET`). That partial package is private, unaccepted, and predates the final cleanup fix. Consumers, historical upgrades and formal portable delivery remain unexecuted. npm identity returned `ENEEDAUTH`; name lookup returned `E404`, which does not establish ownership.

Windows 开发打包在较早 `edfa463` 上生成了 tarball，但固定 SBOM 工具下载被本机代理中断；该包保持私有、未验收，且早于最终清理修复，不能用于当前交付结论。两平台同包消费者、真实跨版本升级及正式分发仍未执行。npm 身份未登录，包名查询不能代替发布权限核验。

The real-model [150-slot plan and five deferred reports](DEFERRED_EVALUATION.md) explicitly distinguish frozen definitions from executable fixture/harness material that still needs preparation. No efficacy, complete-cost or competitive claim follows from them.
