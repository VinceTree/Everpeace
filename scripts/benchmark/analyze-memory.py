"""Offline Memory evidence analysis. Snapshot/replay never imports credentials or calls a model."""
import argparse
import collections
import concurrent.futures
import hashlib
import json
import pathlib
import statistics
import subprocess
import time
from datetime import datetime, timezone

ARMS = ("no-memory", "learned-memory", "bm25-history")
TYPES = ("single-session-user", "single-session-assistant", "single-session-preference", "temporal-reasoning", "knowledge-update", "multi-session")
REPO = pathlib.Path(__file__).resolve().parents[2]


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


class Evidence:
    def __init__(self, output, replay=None):
        self.output, self.replay, self.index = output, replay, {}
        self.frozen = json.loads((replay / "source-index.json").read_text(encoding="utf-8")) if replay else None

    def read(self, file, optional=False):
        file = pathlib.Path(file).resolve()
        key = str(file)
        if key in self.index:
            row = self.index[key]
            if row.get("missing"):
                return None
            return json.loads((self.output / row["blob"]).read_bytes())
        if self.frozen is not None:
            row = self.frozen.get(key)
            if row is None:
                raise ValueError(f"Replay input was not captured: {file}")
            if row.get("missing"):
                self.index[key] = row
                return None
            data = (self.replay / row["blob"]).read_bytes()
            if sha(data) != row["sha256"]:
                raise ValueError("Frozen evidence hash mismatch")
        else:
            try:
                data = file.read_bytes()
            except FileNotFoundError:
                if not optional:
                    raise
                self.index[key] = {"missing": True, "readAt": now()}
                return None
            row = {"sha256": sha(data), "bytes": len(data), "readAt": now(), "blob": f"blobs/{sha(data)}.json"}
        target = self.output / row["blob"]
        target.parent.mkdir(exist_ok=True)
        if not target.exists():
            with target.open("xb") as handle:
                handle.write(data)
        self.index[key] = row
        return json.loads(data)

    def request_files(self, root):
        directory = root / "requests"
        if self.frozen is not None:
            return sorted(pathlib.Path(p) for p, row in self.frozen.items() if pathlib.Path(p).parent == directory and not row.get("missing"))
        return sorted(directory.glob("*.json"))


def row_valid(row, item):
    return all(row.get(k) == item[k] for k in ("key", "questionId", "repetition", "arm", "historyHash")) and (
        row.get("status") == "completed" and type(row.get("correct")) is bool
        or row.get("status") == "failed" and row.get("correct") is None)


def quality(rows, planned=None):
    correct = sum(r.get("correct") is True for r in rows)
    completed = sum(r["status"] == "completed" for r in rows)
    return {"settled": len(rows), "completed": completed, "failed": len(rows)-completed, "correct": correct,
            "accuracyOverSettled": correct / len(rows) if rows else None,
            "accuracyOverCompleted": correct / completed if completed else None,
            "planned": planned, "notSettled": planned-len(rows) if planned is not None else None,
            "accuracyOverPlanned": correct / planned if planned else None}


def usage(records):
    attempts = [a for r in records for a in r["usage"]["attempts"]]
    pending = [r for r in records if r["state"] != "settled" or r["openRequests"] != 0]
    unknown = [r for r in records if r["state"] == "settled" and r["openRequests"] == 0 and not r["usage"]["complete"]]
    return {"records": len(records), "requests": sum(a["status"] != "rejected" for a in attempts),
            "rejectedRequests": sum(a["status"] == "rejected" for a in attempts),
            "inputTokens": sum(r["usage"]["inputTokens"] for r in records), "outputTokens": sum(r["usage"]["outputTokens"] for r in records),
            "reasoningTokensSubsetOfOutput": sum(r["usage"].get("reasoningTokens", 0) for r in records),
            "knownTokens": sum(r["usage"]["inputTokens"]+r["usage"]["outputTokens"] for r in records),
            "cachedInputTokens": sum(a.get("usage", {}).get("cached_input_tokens", 0) for a in attempts if a.get("usage")) if any(a.get("usage", {}).get("cached_input_tokens") is not None for a in attempts if a.get("usage")) else None,
            "closedUnknown": [r["key"] for r in unknown], "pending": [r["key"] for r in pending],
            "complete": not pending and not unknown and all(r["usage"]["complete"] for r in records)}


def paired(rows, baseline, successful_only=False):
    index = {(r["questionId"], r["repetition"], r["arm"]): r for r in rows}
    pairs = [(r, index[(r["questionId"], r["repetition"], baseline)]) for r in rows if r["arm"] == "learned-memory" and (r["questionId"], r["repetition"], baseline) in index]
    if successful_only:
        pairs = [(a, b) for a, b in pairs if a["status"] == b["status"] == "completed"]
    left, right = quality([a for a, _ in pairs]), quality([b for _, b in pairs])
    return {"pairs": len(pairs), "uniqueQuestions": len({a["questionId"] for a, _ in pairs}), "historyClusters": len({a["historyHash"] for a, _ in pairs}),
            "learned": left, "baseline": right, "differencePp": 100*(left["accuracyOverSettled"]-right["accuracyOverSettled"]) if pairs else None,
            "learnedOnlyCorrect": sum(a.get("correct") is True and b.get("correct") is not True for a, b in pairs),
            "baselineOnlyCorrect": sum(b.get("correct") is True and a.get("correct") is not True for a, b in pairs), "interval95": None}


def retrieval(rows, references):
    values = [r for r in rows if r.get("retrieval")]
    covered = sum(len(set(references[r["questionId"]]["evidence"]) & set(r["retrieval"]["sources"])) for r in values)
    total = sum(len(set(references[r["questionId"]]["evidence"])) for r in values)
    return {"available": len(values), "missing": len(rows)-len(values), "empty": sum(not r["retrieval"]["text"] for r in values),
            "meanChars": statistics.mean(len(r["retrieval"]["text"]) for r in values) if values else None,
            "sourceCovered": covered, "sourceTotal": total, "sourceRecall": covered/total if total else None,
            **{field: {"mean": statistics.mean(r["retrieval"][field] for r in values) if values else None, "max": max((r["retrieval"][field] for r in values), default=None)} for field in ("active", "review", "archived", "clippedChars")}}


def phases(records):
    return {phase: usage([r for r in records if r["phase"] in names]) for phase, names in {"build": ("extract", "merge"), "extract": ("extract",), "merge": ("merge",), "answer": ("answer",), "judge": ("judge",)}.items()}


def parse_entries(record):
    try:
        value = json.loads(record.get("response", {}).get("output_text", ""))
        entries = value.get("entries") if isinstance(value, dict) else None
        return entries if isinstance(entries, list) else None
    except (ValueError, TypeError):
        return None


def pct(value):
    return "—" if value is None else f"{value*100:.2f}%"


def distribution(values):
    values = sorted(values)
    return {"count": len(values), "p50": statistics.median(values) if values else None,
            "p95": values[min(len(values)-1, int(.95*len(values)))] if values else None}


def table(headers, rows):
    return "| " + " | ".join(headers) + " |\n| " + " | ".join("---" for _ in headers) + " |\n" + "\n".join("| " + " | ".join(str(x) for x in row) + " |" for row in rows) + "\n"


def analyze(campaign, output, sources_path, replay=None):
    output.mkdir(parents=True, exist_ok=False)
    evidence = Evidence(output, replay)
    started = now()
    for source in (pathlib.Path(__file__).resolve(), REPO / "scripts/benchmark/memory-analysis-projection.mjs", REPO / "src/memory/learned-memory.ts", REPO / "src/benchmark/memory-data.ts"):
        capture_text(evidence, source)
    manifest = evidence.read(campaign / "manifest.json")
    validated = evidence.read(campaign / "preflight.json")
    for name in ("manifest.sha256", "preflight.sha256"):
        capture_text(evidence, campaign / name)
    planned = {r["key"]: r for r in manifest["planned"]}
    if len(planned) != len(manifest["planned"]):
        raise ValueError("Duplicate plan key")
    rows = []
    # Fix the result set before reading mutable live ledgers. Missing results remain unrun in this snapshot.
    for item in manifest["planned"]:
        row = evidence.read(campaign / "samples" / item["key"] / "result.json", optional=True)
        if row is not None:
            if not row_valid(row, item):
                raise ValueError("Result and plan identity mismatch")
            rows.append(row)
    results_fixed_at = now()
    public_parent = evidence.read(campaign / "public-continuation.json", optional=True)
    continuation = evidence.read(campaign / "continuation.json", optional=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        own = list(pool.map(evidence.read, evidence.request_files(campaign)))
    combined = {}
    for r, default_origin in [(r, (public_parent or {}).get("parentRoot")) for r in (public_parent or {}).get("requests", [])] + [(r, str(campaign)) for r in own]:
        if r["key"].split(":")[0] not in planned:
            continue
        origin = r.get("originRoot", default_origin)
        key = (origin, r["key"])
        if key in combined:
            raise ValueError("Duplicate public request identity")
        combined[key] = r
    requests = list(combined.values())
    references = {r["id"]: r for r in evidence.read(campaign / "references.json")}
    questions = {r["id"]: r for r in evidence.read(campaign / "history.json")}
    state = evidence.read(campaign / "run-state.json", optional=True)
    coding = evidence.read(campaign / "coding/live-result.json")
    coding_plan = evidence.read(campaign / "coding/plan.json")
    coding_keys = [(r["sequence"], r["arm"], r["repetition"], r["stage"]) for r in coding["records"]]
    if len(coding_keys) != len(set(coding_keys)):
        raise ValueError("Duplicate coding result identity")
    for row in coding["records"]:
        r = row["result"]
        if r["status"] == "passed" and not (r.get("verification", {}).get("passed") is True and r.get("usage", {}).get("complete") is True and r.get("terminalOutcome") == "completed" and r.get("workflowOutcome") == "verified"):
            raise ValueError("Coding success lacks verification evidence")
    groups = {}
    for arm in ARMS:
        selected = [r for r in rows if r["arm"] == arm]
        reqs = [r for r in requests if planned[r["key"].split(":")[0]]["arm"] == arm]
        cost = usage(reqs)
        groups[arm] = {**quality(selected, sum(p["arm"] == arm for p in planned.values())), "cost": cost, "phases": phases(reqs), "retrieval": retrieval(selected, references),
                       "answerModelLatencyMs": distribution([r["durationMs"] for r in reqs if r["phase"] == "answer" and "durationMs" in r]),
                       "sampleLatencyWithBuildMs": distribution([r["durationMs"] for r in selected]),
                       "knownTokensPerPlanned": cost["knownTokens"]/sum(p["arm"] == arm for p in planned.values()),
                       "knownTokensPerCorrect": cost["knownTokens"]/sum(r.get("correct") is True for r in selected) if any(r.get("correct") is True for r in selected) else None,
                       "categories": {t: quality([r for r in selected if r["type"] == t], sum(p["arm"] == arm and questions[p["questionId"]]["type"] == t for p in planned.values())) for t in TYPES},
                       "abstention": quality([r for r in selected if r["questionId"].endswith("_abs")]),
                       "repetitions": {str(rep): quality([r for r in selected if r["repetition"] == rep]) for rep in (1, 2, 3)}}
    comparisons = {base: {"allSettled": paired(rows, base), "bothCompleted": paired(rows, base, True)} for base in ("bm25-history", "no-memory")}
    complete_keys = {(r["questionId"], r["repetition"]) for r in rows if r["arm"] == "learned-memory" and r["status"] == "completed"}
    common = [r for r in rows if (r["questionId"], r["repetition"]) in complete_keys and any(b["questionId"] == r["questionId"] and b["repetition"] == r["repetition"] and b["arm"] == "bm25-history" and b["status"] == "completed" for b in rows)]
    common_metrics = {a: {"quality": quality([r for r in common if r["arm"] == a]), "retrieval": retrieval([r for r in common if r["arm"] == a], references),
                          "cost": usage([q for q in requests if q["key"].split(":")[0] in {r["key"] for r in common if r["arm"] == a}])} for a in ("learned-memory", "bm25-history")}
    own_usage = usage(own)
    history = (continuation or {}).get("historical", {})
    diagnostic_one = evidence.read(REPO / ".cache/go-usage-repair/summary.json", optional=True)
    diagnostic_two = evidence.read(REPO / ".cache/go-usage-repair/diagnostic-002/result.json", optional=True)
    diagnostic_tokens = (diagnostic_one or {}).get("knownInputOutputTokens", 0)
    diagnostic_tokens += (diagnostic_two or {}).get("ledger", {}).get("inputTokens", 0) + (diagnostic_two or {}).get("ledger", {}).get("outputTokens", 0)
    coding_new = coding["records"][coding.get("retainedCells", 0):]
    coding_unknown = sum(r["result"].get("requestAccounting", {}).get("unknownRequests", 0) for r in coding_new) if all("requestAccounting" in r["result"] for r in coding_new) else None
    campaign_usage = {"newPublicAndSmoke": own_usage, "newCodingKnownTokens": coding["knownTokens"], "ancestorKnownTokens": history.get("knownInputOutputTokens", 0),
                      "knownTokens": own_usage["knownTokens"]+coding["knownTokens"]+history.get("knownInputOutputTokens", 0),
                      "ancestorClosedUnknown": history.get("unknownRequestCount"), "newClosedUnknown": len(own_usage["closedUnknown"]), "newPending": len(own_usage["pending"]),
                      "complete": False, "newCodingUnknown": coding_unknown, "diagnostics": {"knownTokens": diagnostic_tokens, "scope": "two independent diagnostics, separate from campaign; input receipts captured", "completeReceipts": diagnostic_one is not None and diagnostic_two is not None}}
    campaign_usage["closedUnknownIncludingAncestors"] = None if history.get("unknownRequestCount") is None or coding_unknown is None else history["unknownRequestCount"]+len(own_usage["closedUnknown"])+coding_unknown
    amortization = {}
    for arm, metrics in common_metrics.items():
        sample_keys = {r["key"] for r in common if r["arm"] == arm}
        sample_requests = [r for r in requests if r["key"].split(":")[0] in sample_keys]
        parts = phases(sample_requests)
        count = len(sample_keys)
        amortization[arm] = {str(queries): ((parts['build']['knownTokens']/queries + parts['answer']['knownTokens'])/count if count else None) for queries in (1, 10, 100)}
    cgroups = {}
    for arm in ("on", "off"):
        cells = [r for r in coding["records"] if r["arm"] == arm]
        cgroups[arm] = {"planned": sum(p["arm"] == arm for p in coding_plan["planned"]), "settled": len(cells), "passed": sum(r["result"]["status"] == "passed" for r in cells),
                        "knownTokens": sum(r["result"]["usage"]["inputTokens"]+r["result"]["usage"]["outputTokens"] for r in cells),
                        "durationMsSumSerial": sum(r["result"]["durationMs"] for r in cells),
                        "diagnosticRounds": dict(collections.Counter(str(r["result"].get("diagnosticRounds", "missing")) for r in cells)),
                        "firstVerification": dict(collections.Counter(r["result"].get("firstVerificationSuiteStatus", "missing") for r in cells)),
                        "verificationAttempts": sum(len(r["result"].get("verificationAttempts", [])) for r in cells),
                        "toolFailures": sum(r["result"]["metrics"].get("toolFailures", 0) for r in cells),
                        "repeatedToolFailures": sum(r["result"]["metrics"].get("repeatedToolFailures", 0) for r in cells)}
    selected_ids = []
    availability = {}
    by_question = collections.Counter(r["questionId"] for r in rows)
    for kind in TYPES:
        available = [q for q in by_question if questions[q]["type"] == kind and by_question[q] == 9]
        selected = sorted(available, key=lambda q: sha(f"16716:{q}"))[:10]
        selected_ids.extend(selected)
        availability[kind] = {"fullySettledUniqueQuestions": len(available), "selected": len(selected), "target": 10}
    audit = build_audit(evidence, campaign, output, questions, references, rows, requests, selected_ids, replay)
    sources = evidence.read(sources_path)
    for system in sources["systems"]:
        if system.get("outputReceipt"):
            evidence.read(REPO / system["outputReceipt"])
        if system.get("categoryCorrect"):
            totals = system["categoryTotal"]
            system["recomputedMicroPercent"] = 100*sum(system["categoryCorrect"].values())/sum(totals.values())
            system["recomputedMacroPercent"] = statistics.mean(100*system["categoryCorrect"][t]/n for t, n in totals.items())
    summary = {"schema": 1, "verificationStatus": "ANALYZED", "humanReviewed": False, "startedAt": started, "resultsFixedAt": results_fixed_at, "endedAt": now(),
               "sourceCampaign": str(campaign), "executionPolicy": manifest.get("executionPolicy", "strict"), "identity": validated["identity"], "preparedIdentity": manifest["identity"], "runState": state,
               "plannedPublic": len(planned), "settledPublic": len(rows), "unsettledPublic": len(planned)-len(rows), "uniqueQuestionsObserved": len(by_question),
               "executionComplete": len(rows) == len(planned) and len(coding_keys) == len(coding_plan["planned"]) == 72 and state is not None and not state.get("stopReason"), "formalIntervalsEnabled": False,
               "snapshotSemantics": "Result set fixed first; ledger reads span a recorded interval, not an atomic global instant. Replay uses captured bytes only.",
               "groups": groups, "comparisons": comparisons, "commonCompleted": common_metrics, "usage": campaign_usage,
               "amortizationScenarios": {"scope": "Hypothetical per-query tokens: same completed build reused for Q independent queries of unchanged mean answer cost; excludes judge; no new model experiment", "queries": amortization},
               "coding": {"planned": 72, "groups": cgroups, "interpretation": "mixed source identities; synthetic completion evidence only"},
               "failures": dict(collections.Counter(json.dumps({"failure": r.get("failure"), "service": r.get("serviceFailure")}, sort_keys=True) for r in rows if r["status"] == "failed")),
               "auditSelection": availability, "auditStageSignals": dict(collections.Counter(a["signal"] for c in audit["cases"] if c["randomlySelected"] for a in c["learnedRepetitions"])),
               "externalSources": sources}
    statuses = [{**p, "status": next((r["status"] for r in rows if r["key"] == p["key"]), "not_settled")} for p in planned.values()]
    save(output / "summary.json", summary)
    save(output / "public-statuses.json", statuses)
    save(output / "coding-statuses.json", [{**p, "status": next(("completed" if r["result"]["status"] == "passed" else "failed" for r in coding["records"] if all(r[k] == p[k] for k in ("sequence", "arm", "repetition", "stage"))), "skipped")} for p in coding_plan["planned"]])
    save(output / "cases.json", audit)
    save(output / "source-index.json", evidence.index)
    render(output, summary, audit)
    save(output / "analysis-receipt.json", {"schema": 1, "campaign": str(campaign), "sourceCatalog": str(sources_path), "snapshot": str(replay or output), "modelRequests": 0,
                                            "projectionsSha256": sha((output / "projections.json").read_bytes()),
                                            "analyzerSha256": sha(pathlib.Path(__file__).read_bytes()), "summarySha256": sha((output / "summary.json").read_bytes()), "createdAt": now()})
    print(json.dumps({"output": str(output), "settled": len(rows), "planned": len(planned), "executionComplete": summary["executionComplete"], "groups": {a: {k: groups[a][k] for k in ("completed", "failed", "correct")} for a in ARMS}, "knownCampaignTokens": campaign_usage["knownTokens"], "closedUnknown": campaign_usage["closedUnknownIncludingAncestors"], "pending": campaign_usage["newPending"], "auditQuestions": len(selected_ids), "modelRequests": 0}))
    return summary


def build_audit(evidence, campaign, output, questions, references, rows, requests, selected_ids, replay):
    anchors = {"0862e8bf": "Luna", "16c90bf4": "pilsner", "18dcd5a5": "mummies"}
    observed = {r["questionId"] for r in rows}
    ids = sorted(set(selected_ids) | (set(anchors) & observed))
    sessions = [{"questionId": qid, "index": i, "session": session} for qid in ids for i, session in enumerate(questions[qid]["history"]) if session["id"] in references[qid]["evidence"]]
    projection_file = output / "projections.json"
    if replay:
        projected_bytes = (replay / "projections.json").read_bytes()
        expected = json.loads((replay / "analysis-receipt.json").read_text(encoding="utf8"))["projectionsSha256"]
        if sha(projected_bytes) != expected:
            raise ValueError("Projection evidence hash mismatch")
        projection_file.write_bytes(projected_bytes)
        projected = json.loads(projected_bytes)
    else:
        # Same production text cleaning/clipping, executed offline with only benchmark sessions on stdin.
        command = ["node", "--import", "tsx", str(REPO / "scripts/benchmark/memory-analysis-projection.mjs")]
        validated = evidence.read(campaign / "preflight.json")
        process = subprocess.run(command, input=json.dumps({"sessions": sessions, "identity": validated["identity"]}, ensure_ascii=False).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=REPO, check=True)
        projected = json.loads(process.stdout)
        save(projection_file, projected)
    projections = {(p["questionId"], p["index"]): p for p in projected}
    request_index = {r["key"]: r for r in requests}
    cases = []
    for qid in ids:
        q, reference = questions[qid], references[qid]
        case = {"questionId": qid, "type": q["type"], "randomlySelected": qid in selected_ids, "diagnosticAnchor": qid in anchors,
                "question": q["question"], "questionDate": q["date"], "reference": reference["answer"], "evidenceSessionIds": reference["evidence"], "arms": {}, "learnedRepetitions": []}
        for arm in ARMS:
            case["arms"][arm] = [r for r in rows if r["questionId"] == qid and r["arm"] == arm]
        for row in case["arms"]["learned-memory"]:
            key = row["key"]
            # Retained sample stores stay at the original campaign. The reader copies their current bytes.
            origin = pathlib.Path(row.get("retainedFrom", campaign))
            directory = origin / "samples" / key / "store"
            if evidence.frozen is not None:
                store_paths = [pathlib.Path(p) for p, info in evidence.frozen.items() if not info.get("missing") and directory in pathlib.Path(p).parents]
            else:
                store_paths = sorted(p for p in directory.rglob("*") if p.is_file() and p.suffix in (".md", ".json") and not p.name.endswith(".tmp"))
            store_texts, active_texts = [], []
            for file in store_paths:
                # Markdown is captured as a JSON string; it is not parsed or executed as instructions.
                if file.suffix == ".md":
                    text = capture_text(evidence, file)
                    active_texts.extend(block for block in text.split("### ")[1:] if "- Status: active" in block)
                else:
                    text = json.dumps(evidence.read(file), ensure_ascii=False)
                store_texts.append(text)
            gold = []
            for session in sessions:
                if session["questionId"] != qid:
                    continue
                i, history = session["index"], session["session"]
                projection = projections[qid, i]
                extraction = [r for k, r in request_index.items() if k.startswith(f"{key}:{i}:extract:")]
                entries = [parse_entries(r) for r in extraction]
                merges = [r for k, r in request_index.items() if k.startswith(f"{key}:{i}:merge:")]
                needle = anchors.get(qid)
                raw = projection["untrimmedTranscript"]
                pos = raw.casefold().find(needle.casefold()) if needle else -1
                gold.append({"historyIndex": i, "sourceId": history["id"], "date": history["date"],
                             "projectionKey": [qid, i], "untrimmedChars": len(raw), "projectedChars": len(projection["transcript"]),
                             "clipped": raw != projection["transcript"], "extractRequests": [r["key"] for r in extraction], "extractEntries": entries,
                             "mergeRequests": [r["key"] for r in merges], "mergeEntries": [parse_entries(r) for r in merges],
                             "anchorProbe": None if not needle else {"needle": needle, "inProjectedInput": any(needle.casefold() in projection[f].casefold() for f in ("transcript", "user", "assistant")),
                                 "sourceExcerpt": raw[max(0, pos-160):pos+len(needle)+220] if pos >= 0 else None,
                                 "inExtractedEntries": any(needle.casefold() in json.dumps(e, ensure_ascii=False).casefold() for e in entries if e is not None)}})
            all_valid_empty = bool(gold) and all(g["extractEntries"] and all(e == [] for e in g["extractEntries"]) for g in gold)
            signal = "infrastructure_failure" if row["status"] == "failed" else "correct" if row["correct"] else "gold_session_extractor_empty" if all_valid_empty else "unresolved_requires_semantic_audit"
            needle = anchors.get(qid)
            probes = {"inCandidateOrStore": any(needle.casefold() in text.casefold() for text in store_texts), "inActiveMarkdown": any(needle.casefold() in text.casefold() for text in active_texts), "inRecall": needle.casefold() in row.get("retrieval", {}).get("text", "").casefold()} if needle else None
            if needle and row["status"] == "completed" and not row["correct"] and probes["inActiveMarkdown"] and not probes["inRecall"]:
                signal = "active_literal_missing_from_snapshot"
            if needle and row["status"] == "completed" and not row["correct"] and not probes["inActiveMarkdown"] and any(g['anchorProbe']['inExtractedEntries'] and g['mergeEntries'] and all(e is not None and needle.casefold() not in json.dumps(e, ensure_ascii=False).casefold() for e in g['mergeEntries']) for g in gold):
                signal = "anchor_literal_lost_in_consolidation"
            if needle and row["status"] == "completed" and not row["correct"] and any(g["anchorProbe"]["inProjectedInput"] for g in gold) and not probes["inCandidateOrStore"]:
                signal = "anchor_fact_not_retained" if not all_valid_empty else signal
            grade = request_index.get(f"{key}:judge")
            case["learnedRepetitions"].append({"repetition": row["repetition"], "key": key, "status": row["status"], "correct": row["correct"], "signal": signal,
                                               "interpretation": "Signal is an observed pipeline property, not a calibrated causal classification. Literal matching cannot detect paraphrases or numeric equivalence.",
                                               "goldHistory": gold, "storeFiles": [str(p) for p in store_paths], "anchorStoreProbe": probes,
                                               "gradeText": (grade or {}).get("response", {}).get("output_text"),
                                               "gradeCheckpointMismatch": grade is not None and row["status"] == "completed" and (grade.get("response", {}).get("output_text", "").strip().lower() == "yes") != row["correct"]})
        cases.append(case)
    return {"seed": 16716, "selection": "SHA-256 order within category; at most 10 unique questions with all 9 terminal rows, including failed rows. Anchors are separately labeled and excluded from sampled frequencies.",
            "humanReviewed": False, "cases": cases}


def capture_text(evidence, file):
    # Use the same content-addressed evidence mechanism for non-JSON text.
    key = str(file.resolve())
    if evidence.frozen is not None:
        info = evidence.frozen[key]
        data = (evidence.replay / info["blob"]).read_bytes()
        if sha(data) != info["sha256"]:
            raise ValueError("Frozen text hash mismatch")
    else:
        data = file.read_bytes()
        info = {"sha256": sha(data), "bytes": len(data), "readAt": now(), "blob": f"blobs/{sha(data)}.txt"}
    target = evidence.output / info["blob"]
    target.parent.mkdir(exist_ok=True)
    if not target.exists():
        target.write_bytes(data)
    evidence.index[key] = info
    return data.decode("utf-8")


def render(output, s, audit):
    groups, cmp = s["groups"], s["comparisons"]["bm25-history"]
    lines = ["# Memory 差距分析：" + ("完整执行记录" if s["executionComplete"] else "阶段快照"), "", "## Material Passport", "",
             f"Verification Status: ANALYZED；自动评分，AI 案例审计，未人工复核。结果集合冻结于 {s['resultsFixedAt']}。", "",
             f"公开计划 {s['plannedPublic']}，已结算 {s['settledPublic']}，未结算 {s['unsettledPublic']}；观察到 {s['uniqueQuestionsObserved']} 个独立问题。编码计划 72。正式置信区间禁用。", "",
             "结果先冻结，账本随后在记录区间读取，不代表原子全局时间点。来源、字节摘要和副本见 source-index.json；全部公开项见 public-statuses.json。", "",
             "## 质量与分母", "", table(["组别", "completed", "failed", "正确", "已结算准确率", "成功执行准确率", "计划项", "未结算"],
             [[a, groups[a]['completed'], groups[a]['failed'], groups[a]['correct'], pct(groups[a]['accuracyOverSettled']), pct(groups[a]['accuracyOverCompleted']), groups[a]['planned'], groups[a]['notSettled']] for a in ARMS]), "",
             "未结算不当作答错；计划分母的当前正确比例只是完成进度下界，不是全量质量估计。成功执行子集有幸存者偏差，只作诊断。", "",
             table(["与 BM25 配对口径", "配对数", "独立问题", "Memory 正确", "BM25 正确", "描述性差值 pp"], [[name, v['pairs'], v['uniqueQuestions'], v['learned']['correct'], v['baseline']['correct'], v['differencePp']] for name, v in cmp.items()]), "",
             "三次重复留在问题／历史 cluster 内；不报告显著性或正式区间，不按重复数扩大独立样本量。", "",
             "## 已观察事实、机制解释与待验证假设", "",
             "**已观察事实**：抽样链路信号与完整案例见 cases.json／cases.md。猫名、啤酒类型及木乃伊数量为预先标注的诊断锚点，另列，未混入随机样本频数。", "",
             json.dumps(s["auditStageSignals"], ensure_ascii=False), "",
             "**机制解释**：生产提示优先保存纠正、仓库约定、验证程序和显式长期偏好，并排除临时细节；这与 LongMemEval 的人物、事件、助手历史回答等事实回忆目标存在偏差。源码 src/memory/learned-memory.ts 的 EXTRACTOR_INSTRUCTIONS 可核对。该解释不能自动推广成所有错误的原因。", "",
             "**待验证假设**：事实／事件与经验规则分层、原文证据回退、时间实体索引可能改善本设置。当前实验没有测试这些变体，也没有测试完整工具式检索闭环。", "",
             "## 六类问题、abstention 与重复", ""]
    for kind in TYPES:
        lines += [f"### {kind}", "", table(["组别", "已结算", "正确", "失败", "已结算准确率"], [[a, groups[a]['categories'][kind]['settled'], groups[a]['categories'][kind]['correct'], groups[a]['categories'][kind]['failed'], pct(groups[a]['categories'][kind]['accuracyOverSettled'])] for a in ARMS]), ""]
    lines += [table(["组别", "abstention 正确/已结算", "重复1", "重复2", "重复3"], [[a, f"{groups[a]['abstention']['correct']}/{groups[a]['abstention']['settled']}", *[f"{v['correct']}/{v['settled']}" for v in groups[a]['repetitions'].values()]] for a in ARMS]), "", "## 召回", "",
              table(["同一双方完成子集", "来源覆盖", "空召回", "平均上下文字符", "active 平均/最大", "review 最大", "归档最大"], [[a, f"{v['retrieval']['sourceCovered']}/{v['retrieval']['sourceTotal']}", v['retrieval']['empty'], v['retrieval']['meanChars'], f"{v['retrieval']['active']['mean']}/{v['retrieval']['active']['max']}", v['retrieval']['review']['max'], v['retrieval']['archived']['max']] for a, v in s['commonCompleted'].items()]), "",
              "来源 ID 命中不等于事实存在于正文；包括正确来源但丢失数字的情况仍可能答错。裁剪、容量与冲突统计完整保存在 summary.json，不凭预设归因。", "", "## 已知成本与可靠性", "",
              table(["组别", "构建 tokens", "回答 tokens", "评分 tokens", "全部已知 tokens", "已关闭 unknown", "在途"], [[a, g['phases']['build']['knownTokens'], g['phases']['answer']['knownTokens'], g['phases']['judge']['knownTokens'], g['cost']['knownTokens'], len(g['cost']['closedUnknown']), len(g['cost']['pending'])] for a, g in groups.items()]), "",
              f"campaign 已知累计 {s['usage']['knownTokens']:,} tokens；祖先已知 {s['usage']['ancestorKnownTokens']:,} 只加一次。已关闭 unknown（含祖先）{s['usage']['closedUnknownIncludingAncestors']}；当前在途 {s['usage']['newPending']}。独立诊断另计 {s['usage']['diagnostics']['knownTokens']} tokens。reasoning 已含于 output，不重复相加；currency 未核验。", "",
              "各组成本包括已失败和未结算样本的实际已知消耗。每计划项／每正确答案成本在 summary.json 中；缺口存在时只表示已知下界。样本生命周期是建一次库回答一题；生产多次查询的摊销只能作情景计算，不能冒充实测。", "",
              table(["假设建库复用查询数 Q", "Memory 每查询已知 tokens", "BM25 每查询已知 tokens"], [[q, s['amortizationScenarios']['queries']['learned-memory'][q], s['amortizationScenarios']['queries']['bm25-history'][q]] for q in ('1', '10', '100')]), "",
              "上表仅为同一双方完成子集的算术摊销，排除评分，假设后续平均回答成本不变；没有测量后续回答质量、缓存或查询相关性。", "",
              table(["组别", "回答模型延迟 p50/p95 ms", "含构建样本延迟 p50/p95 ms"], [[a, f"{g['answerModelLatencyMs']['p50']}/{g['answerModelLatencyMs']['p95']}", f"{g['sampleLatencyWithBuildMs']['p50']}/{g['sampleLatencyWithBuildMs']['p95']}"] for a, g in groups.items()]), "",
              "缺少公开阶段独立开始／结束时间戳时，不从这些并发请求耗时之和伪造墙钟吞吐；编码 duration 总和仅作为串行 pilot 数据。", "",
              "失败分布：" + json.dumps(s["failures"], ensure_ascii=False), "", "## 编码 pilot", "",
              table(["组别", "通过/计划", "tokens", "首轮验证", "诊断轮次", "工具失败", "同任务重复工具失败"], [[a, f"{g['passed']}/{g['planned']}", g['knownTokens'], json.dumps(g['firstVerification']), json.dumps(g['diagnosticRounds']), g['toolFailures'], g['repeatedToolFailures']] for a, g in s['coding']['groups'].items()]), "",
              "跨源码身份、三个短合成序列。工具失败重复计数不等于跨 Session 重复犯同一语义错误；没有经过语义标注的字段应保持未测量。成功率相同不能证明质量提升，token 差异也不能独立归因于 Memory。", "", "## 外部比较", "",
              "开发者自报成绩与我们的同模型内部对照分开。缺失条件写为未核验；宏／微平均、原始／cleaned、模型、上下文预算和工具权限不一致时不计算排名差值。", "",
              table(["对象", "公开成绩或能力", "比较限制", "来源"], [[x['system'], x['headline'], x['limits'], f"[官方材料]({x['url']})"] for x in s['externalSources']['systems']]), "",
              "完整模型、数据、评分器、源码和逐题证据矩阵见 external-comparison.json／external-comparison.md。", "", "## 优先验证顺序", "",
              "1. P0 事实保留：用诊断锚点检查姓名、数量、助手原话；仅改提取目标的隔离变体，其他变量冻结。目标是检查信息是否留存，效果需另立实验。", "2. P0 原文恢复：用已有 memory_lookup 与 Session 搜索验证摘要缺失后能否找到原文，单独报告工具闭环；本次无工具 reader 不能回答此问题。", "3. P1 召回与时间：先按存储／召回证据区分漏存和漏召回，再测试实体、日期与重排，不预设需要向量库或图数据库。", "4. P1 成本／故障：统计构建请求暴露，再验证减少重复合并或延迟整理是否保留质量；不改当前批次、不重试旧失败。", "5. P2 编码长期收益：增加有记忆依赖且有隐藏验收的真实连续任务；当前 72 项完成证据不足。", "", "## 统计误读检查（11/11）", "",
              "分层方向检查见类别表（Simpson）；不从群体均值推断每题（ecological）；双方成功子集存在选择／collider 与 survivorship 风险，主表保留失败；提供 abstention 基数；无挑选极端问题重测（regression to mean）；全部预定类别与重复展示（look elsewhere）；固定种子、版本和协议变更披露（forking paths）；不将外部模型差异、跨版本成本或关联写成因果，保留时间顺序与反向因果限制。", "",
              "本轮没有新增模型请求、人工评分记录或优化实验。"]
    (output / "report.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    case_lines = ["# AI 案例审计（未人工复核）", "", audit['selection'], ""]
    for c in audit["cases"]:
        case_lines += [f"## {c['questionId']} · {c['type']}", "", f"随机抽样：{c['randomlySelected']}；诊断锚点：{c['diagnosticAnchor']}。", "", c['question'], "", "标准答案："+str(c['reference']), ""]
        for a, rs in c['arms'].items():
            for r in rs:
                source = pathlib.Path(r.get('retainedFrom', s['sourceCampaign'])) / 'samples' / r['key'] / 'result.json'
                case_lines += [f"- {a} / repetition {r['repetition']} / {r['status']} / correct={r['correct']}：[原始结果](<{source.as_posix()}>)；回答：{r.get('hypothesis', '未生成')}。"]
        for detail in c['learnedRepetitions']:
            case_lines += ["", f"重复 {detail['repetition']} 链路信号：{detail['signal']}；字面匹配不作语义判定。", "", "```json", json.dumps(detail, ensure_ascii=False, indent=2), "```", ""]
    (output / "cases.md").write_text("\n".join(case_lines)+"\n", encoding="utf-8")
    save(output / "external-comparison.json", s["externalSources"])
    external_lines = ["# 外部比较条件矩阵", "", "均为原作者材料核查；本轮未独立复现任何外部系统。公开成绩仅供背景，不与 Go／DeepSeek 排名。", ""]
    for x in s["externalSources"]["systems"]:
        external_lines += [f"## {x['system']}", "", f"[来源]({x['url']})", "", table(["字段", "记录"], [[k, json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v] for k, v in x.items() if k not in ('system', 'url')]), ""]
    (output / "external-comparison.md").write_text("\n".join(external_lines)+"\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True, help="New directory outside the campaign")
    parser.add_argument("--sources", type=pathlib.Path, default=REPO / "docs/benchmark/memory-comparison-sources.json")
    parser.add_argument("--replay", type=pathlib.Path)
    parser.add_argument("--wait-for-stop", action="store_true", help="Wait read-only for a persisted run-state, then generate one fresh snapshot")
    args = parser.parse_args()
    campaign, output = args.campaign.resolve(), args.output.resolve()
    if campaign == output or campaign in output.parents:
        raise ValueError("Analysis output must be outside the frozen campaign")
    if args.wait_for_stop:
        if args.replay:
            raise ValueError("Replay does not wait on live evidence")
        while not (campaign / "run-state.json").exists():
            time.sleep(30)
    analyze(campaign, output, args.sources.resolve(), args.replay.resolve() if args.replay else None)


if __name__ == "__main__":
    main()
