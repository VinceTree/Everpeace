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
| Contribution and current-document hygiene | Implemented; final scan pending | Current files/archives only; old history is retained |
| Complete Windows gates and install smoke | Pending final candidate | Earlier results are not reused as final evidence |
| Hosted Windows/Linux CI | Not executed for this candidate | Earlier published-source CI does not validate new changes |
| Dedicated native/install delivery and npm channel | Blocked / unopened | Missing native platform receipts and publishing identity; no gate relaxed |
| Manual terminals, IME, NVDA | Not executed | See the separate matrix |
| Five-scenario real-model comparison | Deferred by user | Preserve all 150 planned runs; no efficacy conclusion |

The last broad targeted UI/CLI/public-consumer check ran 243 tests, all passing. Subsequent presentation additions still require final gates; the final receipt will replace this provisional statement with its exact checked source digest. Raw execution records live only in ignored `.cache/private-evidence/` or other owned `.cache` directories.

最近一次广泛定向检查为 243 项全部通过；之后的展示补充仍须最终门禁，不能把旧收据当作新候选证明。最终结果将绑定源码摘要。原始执行记录只保存于忽略的本地证据目录。
