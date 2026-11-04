"""Prepare the fact-preservation experiment offline; never launches a provider or edits production.

The current campaign may still be running. Only immutable, hash-checked inputs and the
previously captured analysis are read. Generated plans are deliberately not live-ready.
"""
import argparse
import collections
import hashlib
import json
import pathlib
import subprocess
from datetime import datetime, timezone

REPO = pathlib.Path(__file__).resolve().parents[2]
TYPES = ("single-session-user", "single-session-assistant", "single-session-preference",
         "temporal-reasoning", "knowledge-update", "multi-session")
VARIANTS = ("A", "B", "C", "D", "E")
DATA_REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f"
SCORER_REVISION = "9e0b455f4ef0e2ab8f2e582289761153549043fc"
SEED = 16716


def digest(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def save(root, name, value):
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("xb") as handle:
        handle.write(encoded(value))


def checked(file, expected=None):
    data = file.read_bytes()
    if expected is not None and digest(data) != expected:
        raise ValueError(f"Input hash mismatch: {file.name}")
    return json.loads(data)


def project_question(row):
    """Allowlist history fields, excluding labels even if an upstream projection regresses."""
    history = [{"id": s["id"], "date": s["date"], "messages": [
        {"role": m["role"], "content": m["content"]} for m in s["messages"]]} for s in row["history"]]
    if not history or any(not s["messages"] or any(m["role"] not in ("user", "assistant")
        or not isinstance(m["content"], str) for m in s["messages"]) for s in history):
        raise ValueError("Invalid history messages")
    # Matches JSON.stringify used by the frozen TypeScript data projection.
    history_hash = digest(json.dumps(history, ensure_ascii=False, separators=(",", ":")))
    if history_hash != row["historyHash"] or row["type"] not in TYPES:
        raise ValueError("History identity or category differs")
    return {"id": row["id"], "type": row["type"], "question": row["question"],
            "date": row["date"], "historyHash": history_hash, "history": history}


def split_questions(questions, audited_ids, dev_per_type=10, holdout_per_type=20):
    """Assign whole history clusters. Audited clusters can never enter the holdout.

    All audited questions stay in development, even when a category would exceed its
    target. Other additions are capped at the target; any shortage is reported.
    """
    index = {q["id"]: q for q in questions}
    if len(index) != len(questions) or not set(audited_ids) <= index.keys():
        raise ValueError("Duplicate question or unknown audited ID")
    clusters = collections.defaultdict(list)
    for q in questions:
        clusters[q["historyHash"]].append(q)
    assignment = {}
    counts = {name: collections.Counter() for name in ("development", "holdout")}

    def assign(cluster, name):
        assignment[cluster] = name
        counts[name].update(q["type"] for q in clusters[cluster])

    for cluster in sorted({index[qid]["historyHash"] for qid in audited_ids}):
        assign(cluster, "development")
    ordered = sorted(clusters, key=lambda c: (digest(f"{SEED}:{c}"), c))
    for name, target in (("development", dev_per_type), ("holdout", holdout_per_type)):
        for cluster in ordered:
            if cluster in assignment:
                continue
            additions = collections.Counter(q["type"] for q in clusters[cluster])
            if all(counts[name][t] + n <= target for t, n in additions.items()):
                assign(cluster, name)
    result = {name: sorted([q for q in questions if assignment.get(q["historyHash"], "unused") == name],
                          key=lambda q: (digest(f"{SEED}:{q['id']}"), q["id"]))
              for name in ("development", "holdout", "unused")}
    result["counts"] = {name: {t: counts[name][t] for t in TYPES} for name in counts}
    result["deviations"] = [{"split": name, "type": t, "target": target, "actual": counts[name][t]}
        for name, target in (("development", dev_per_type), ("holdout", holdout_per_type))
        for t in TYPES if counts[name][t] != target]
    return result


def classify_extraction(response):
    """Offline classification: malformed/incomplete responses never masquerade as empty."""
    if response.get("status") == "incomplete" or response.get("incomplete_details"):
        return {"state": "truncated", "entries": []}
    if response.get("status") != "completed":
        return {"state": "invalid_terminal", "entries": []}
    text = response.get("output_text", "").strip()
    if text.startswith("```") and text.endswith("```"):
        text = text.split("\n", 1)[-1][:-3].strip()
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        return {"state": "invalid_json", "entries": []}
    if not isinstance(value, dict) or not isinstance(value.get("entries"), list):
        return {"state": "invalid_schema", "entries": []}
    entries = value["entries"]
    if any(not isinstance(e, dict) or not isinstance(e.get("lesson"), str) or not e["lesson"].strip()
           or not isinstance(e.get("applyWhen"), str) or not e["applyWhen"].strip() for e in entries):
        return {"state": "invalid_schema", "entries": []}
    return {"state": "nonempty" if entries else "empty", "entries": entries}


def preserve_candidates(candidates):
    """Offline policy B: exact content duplicates only; no model paraphrase or truncation.

    Provenance unions retain every occurrence. Matching applicability with different
    lessons is flagged for review using the current production conflict predicate.
    This is a replay specification, not a replacement for production commit admission.
    """
    grouped = {}
    for item in candidates:
        content = {k: item.get(k) for k in ("scope", "kind", "confidence", "lesson", "applyWhen")}
        key = json.dumps(content, ensure_ascii=False, sort_keys=True)
        if key not in grouped:
            grouped[key] = {**content, "origins": [], "review": False}
        origin = item["origin"]
        if origin not in grouped[key]["origins"]:
            grouped[key]["origins"].append(origin)
    values = list(grouped.values())
    for item in values:
        item["review"] = any(other is not item and other["scope"] == item["scope"]
            and other["applyWhen"].lower() == item["applyWhen"].lower()
            and other["lesson"].lower() != item["lesson"].lower() for other in values)
    return values


def frozen_extract_replay(snapshot):
    """Replay only captured extraction/merge receipts, never changing the live campaign."""
    source_index = checked(snapshot / "source-index.json")
    parsed = collections.Counter()
    outputs, merge_records = [], []
    for source, receipt in source_index.items():
        if receipt.get("missing") or pathlib.Path(source).parent.name != "requests":
            continue
        record = checked(safe_child(snapshot, receipt["blob"]), receipt["sha256"])
        if record.get("phase") not in ("extract", "merge") or not record.get("response"):
            continue
        result = classify_extraction(record["response"])
        if record["phase"] == "merge":
            merge_records.append({"key": record["key"], "receiptSha256": receipt["sha256"],
                                  "source": source, **result})
            continue
        parsed[result["state"]] += 1
        # Each scope consolidation sees only this extraction's candidates. No
        # cross-session consolidation and no synthetic source-event claims.
        candidates = [{**entry, "origin": {"requestKey": record["key"], "source": source,
                       "receiptSha256": receipt["sha256"], "candidateIndex": i}}
                      for i, entry in enumerate(result["entries"])]
        preserved = preserve_candidates(candidates)
        outputs.append({"key": record["key"], "state": result["state"], "inputCount": len(candidates),
                        "preserved": preserved, "allOccurrencesPreserved":
                        sum(len(e["origins"]) for e in preserved) == len(candidates)})
    beer = [r for r in outputs if r["key"].startswith("9d42c181dd5916af5b02-2-learned-memory:41:extract:")]
    beer_merged = [r for r in merge_records if r["key"].startswith("9d42c181dd5916af5b02-2-learned-memory:41:merge:")]
    def has_beer(entries):
        return any("pilsner" in e["lesson"].lower() or "lager" in e["lesson"].lower() for e in entries)
    anchors = {"questionId": "16c90bf4", "repetition": 2, "historyIndex": 41,
               "extractReceipts": [r["key"] for r in beer], "mergeReceipts": beer_merged,
               "retainedByReplay": any(has_beer(r["preserved"]) for r in beer),
               "retainedByOriginalMerge": any(has_beer(r["entries"]) for r in beer_merged)}
    return {"modelRequests": 0, "productionIntegrated": False, "states": dict(parsed),
            "scope": "captured extraction outputs only; no store/capacity/reader simulation",
            "allOccurrencesPreserved": all(r["allOccurrencesPreserved"] for r in outputs),
            "records": outputs, "beerAnchor": anchors}


def safe_child(root, name):
    target = (root / name).resolve()
    if not target.is_relative_to(root.resolve()) or pathlib.Path(name).is_absolute():
        raise ValueError("Artifact path escapes root")
    return target


def plan_rows(questions, arms, split):
    return [{"key": f"{split}:{q['id']}:1:{arm}", "questionId": q["id"], "type": q["type"],
             "historyHash": q["historyHash"], "repetition": 1, "arm": arm, "status": "not_started"}
            for qi, q in enumerate(questions) for arm in arms[qi % len(arms):] + arms[:qi % len(arms)]]


def prepare(campaign, snapshot, output):
    if output.is_relative_to(campaign) or output.is_relative_to(snapshot):
        raise ValueError("Output must be outside original evidence directories")
    if output.exists():
        raise FileExistsError("Use a new output directory; previous preparations are immutable")
    # Upstream seals JSON.stringify objects, not the pretty-printed file bytes.
    # Verify those seals with Node rather than approximating JS number encoding.
    actual = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e",
        "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; "
        "import {join} from 'node:path'; import {memoryIdentity} from './src/benchmark/memory-campaign.ts'; "
        "const hashes={}; for(const name of ['manifest','preflight']) { "
        "const bytes=readFileSync(join(process.argv[1],name+'.json')); "
        "const seal=createHash('sha256').update(JSON.stringify(JSON.parse(bytes))).digest('hex'); "
        "if(seal!==readFileSync(join(process.argv[1],name+'.sha256'),'utf8').trim()) throw Error('Frozen seal mismatch: '+name); "
        "hashes[name]=createHash('sha256').update(bytes).digest('hex'); } "
        "process.stdout.write(JSON.stringify({identity:await memoryIdentity(),hashes}));", str(campaign)],
        cwd=REPO, capture_output=True, text=True, check=True)
    attestation = json.loads(actual.stdout)
    manifest_bytes = (campaign / "manifest.json").read_bytes()
    if digest(manifest_bytes) != attestation["hashes"]["manifest"]:
        raise ValueError("Campaign manifest changed while reading")
    manifest = json.loads(manifest_bytes)
    config = manifest["config"]
    if config["datasetRevision"] != DATA_REVISION or config["scorerRevision"] != SCORER_REVISION:
        raise ValueError("Frozen data/scorer revision differs")
    identity = checked(campaign / "preflight.json", attestation["hashes"]["preflight"])["identity"]
    if attestation["identity"] != identity:
        raise ValueError("Active baseline source/build identity differs")
    questions = [project_question(q) for q in checked(campaign / "history.json", manifest["files"]["history.json"])]
    if len(questions) != 500 or len({q["id"] for q in questions}) != 500:
        raise ValueError("Expected 500 unique frozen questions")
    references = checked(campaign / "references.json", manifest["files"]["references.json"])
    reference_index = {r["id"]: {"id": r["id"], "answer": r["answer"], "evidence": r["evidence"]} for r in references}
    if set(reference_index) != {q["id"] for q in questions}:
        raise ValueError("Reference/question identity mismatch")
    analysis_receipt = checked(snapshot / "analysis-receipt.json")
    if pathlib.Path(analysis_receipt["campaign"]).resolve() != campaign:
        raise ValueError("Analysis belongs to another campaign")
    checked(snapshot / "summary.json", analysis_receipt["summarySha256"])
    cases_path = snapshot / "cases.json"
    # The audit package itself is hashed into this preparation; source blobs used
    # for replay are independently verified against the analysis index.
    cases = checked(cases_path)["cases"]
    audited = {r["questionId"] for r in cases}
    split = split_questions(questions, audited)
    replay = frozen_extract_replay(snapshot)
    if not replay["allOccurrencesPreserved"] or not replay["beerAnchor"]["retainedByReplay"]:
        raise ValueError("Frozen candidate replay did not preserve the beer anchor")
    fixture_path = REPO / "tests/fixtures/memory-fact-preservation.json"
    fixtures = checked(fixture_path)
    if len(fixtures["tasks"]) != 24 or len({t["id"] for t in fixtures["tasks"]}) != 24:
        raise ValueError("Expected 24 unique synthetic tasks")
    output.mkdir(parents=True)
    summary = {"schema": 1, "strategy": "memory-fact-preservation", "seed": SEED,
        "status": "prepared_offline_only", "modelRequests": 0, "productionIntegrated": False,
        "sourceCampaign": str(campaign), "analysisSnapshot": str(snapshot), "baselineIdentity": identity,
        "sourceHashes": {"manifest": digest(manifest_bytes), "sourceIndex": digest((snapshot / "source-index.json").read_bytes()),
            "audit": digest(cases_path.read_bytes()), "history": manifest["files"]["history.json"],
            "references": manifest["files"]["references.json"], "synthetic": digest(fixture_path.read_bytes()),
            "preparer": digest(pathlib.Path(__file__).read_bytes())},
        "counts": split["counts"], "deviations": split["deviations"], "auditedQuestionIds": sorted(audited),
        "holdoutDescription": "not individually audited at split time; public benchmark, not an external independent test set",
        "model": {k: config[k] for k in ("modelId", "rawModelId", "endpoint", "responsesProfile", "datasetRevision", "scorerRevision")},
        "reader": {"reasoning": "high", "maxOutputTokens": 32768, "bodyBudgetChars": 8000, "tools": False},
        "judge": {"reasoning": "none", "maxOutputTokens": 16, "labels": ["yes", "no"]},
        "budgets": {"status": "requires_new_authorization", "taskTokenBudget": "UNSET", "campaignTokenBudget": "UNSET"},
        "variants": {"A": "frozen old behavior", "B": "A with exact dedup and preserved independent candidates",
            "C": "B with attributed facts", "D": "C with raw history retrieval in the same 8000-character budget", "E": "frozen BM25"},
        "readinessBlockers": ["production implementation and compatibility gates pending", "new live budget not authorized",
            "holdout candidate must be selected and sealed after development"],
        "baselineRunningAtPreparation": not (campaign / "run-state.json").exists(),
        "createdAt": datetime.now(timezone.utc).isoformat()}
    for name in ("development", "holdout", "unused"):
        save(output, f"{name}/questions.json", [{k: q[k] for k in ("id", "type", "question", "date", "historyHash")} for q in split[name]])
        save(output, f"{name}/build-inputs.json", [{"historyHash": q["historyHash"], "history": q["history"]} for q in split[name]])
        save(output, f"grader/{name}-references.json", [reference_index[q["id"]] for q in split[name]])
    save(output, "development/plan.json", plan_rows(split["development"], list(VARIANTS), "development"))
    save(output, "holdout/plan-template.json", plan_rows(split["holdout"], ["A", "SELECTED", "E"], "holdout"))
    save(output, "synthetic/tasks.json", [{k: v for k, v in t.items() if k != "expected"} for t in fixtures["tasks"]])
    save(output, "grader/synthetic-expected.json", [{"id": t["id"], **t["expected"]} for t in fixtures["tasks"]])
    save(output, "synthetic/plan.json", [{"key": f"synthetic:{t['id']}:{arm}", "taskId": t["id"], "arm": arm,
        "status": "not_started", "tools": ["memory_lookup", "session_search", "session_event_search", "session_event_read"],
        "maxToolCalls": 6, "retrievedBodyBudgetChars": 8000} for t in fixtures["tasks"] for arm in ("old", "candidate")])
    save(output, "candidate-replay.json", replay)
    save(output, "manifest.json", summary)
    files = {str(p.relative_to(output)).replace("\\", "/"): digest(p.read_bytes()) for p in sorted(output.rglob("*.json"))}
    save(output, "receipt.json", {"schema": 1, "modelRequests": 0, "files": files})
    return verify(output)


def verify(root):
    receipt = checked(root / "receipt.json")
    for name, expected in receipt["files"].items():
        checked(safe_child(root, name), expected)
    manifest = checked(root / "manifest.json")
    clusters, ids = {}, set()
    counts = {}
    for split in ("development", "holdout", "unused"):
        questions = checked(root / split / "questions.json")
        builds = checked(root / split / "build-inputs.json")
        if len(questions) != len(builds):
            raise ValueError("Missing build projection")
        counts[split] = len(questions)
        for q, build in zip(questions, builds):
            if q["id"] in ids or clusters.get(q["historyHash"], split) != split:
                raise ValueError("Question or history cluster leaks across splits")
            ids.add(q["id"])
            clusters[q["historyHash"]] = split
            if set(build) != {"historyHash", "history"} or build["historyHash"] != q["historyHash"]:
                raise ValueError("Build sees metadata or different history")
            project_question({**q, "history": build["history"]})
        if split != "unused" and dict(collections.Counter(q["type"] for q in questions)) != manifest["counts"][split]:
            # Zero-count types are allowed in intentionally smaller fixture tests.
            if any(sum(q["type"] == t for q in questions) != manifest["counts"][split][t] for t in TYPES):
                raise ValueError("Category counts differ")
    development = checked(root / "development/questions.json")
    if not set(manifest["auditedQuestionIds"]) <= {q["id"] for q in development}:
        raise ValueError("Audited question entered holdout")
    replay = checked(root / "candidate-replay.json")
    if not replay["allOccurrencesPreserved"] or not replay["beerAnchor"]["retainedByReplay"]:
        raise ValueError("Candidate replay failed")
    holdout = checked(root / "holdout/questions.json")
    dev_plan = checked(root / "development/plan.json")
    holdout_plan = checked(root / "holdout/plan-template.json")
    if dev_plan != plan_rows(development, list(VARIANTS), "development") or holdout_plan != plan_rows(holdout, ["A", "SELECTED", "E"], "holdout"):
        raise ValueError("Execution plan differs from frozen split")
    tasks = checked(root / "synthetic/tasks.json")
    synthetic_plan = checked(root / "synthetic/plan.json")
    expected = checked(root / "grader/synthetic-expected.json")
    task_ids = {t["id"] for t in tasks}
    if len(tasks) != 24 or len(task_ids) != 24 or any("expected" in t for t in tasks):
        raise ValueError("Invalid or label-contaminated synthetic tasks")
    if len(expected) != 24 or {r["id"] for r in expected} != task_ids:
        raise ValueError("Synthetic references differ")
    if len(synthetic_plan) != 48 or {(r["taskId"], r["arm"]) for r in synthetic_plan} != {(t, a) for t in task_ids for a in ("old", "candidate")}:
        raise ValueError("Synthetic plan is incomplete")
    return {"status": "verified_offline_preparation", "modelRequests": 0, "questions": counts,
            "developmentAnswerItems": len(dev_plan), "holdoutTemplateItems": len(holdout_plan),
            "syntheticTaskItems": len(synthetic_plan), "productionIntegrated": False, "liveReady": False,
            "filesVerified": len(receipt["files"]), "beerPreservedInReplay": True,
            "deviations": manifest["deviations"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare_args = sub.add_parser("prepare")
    for name in ("campaign", "snapshot", "output"):
        prepare_args.add_argument(f"--{name}", required=True, type=pathlib.Path)
    verify_args = sub.add_parser("verify")
    verify_args.add_argument("--root", required=True, type=pathlib.Path)
    args = parser.parse_args()
    result = prepare(args.campaign.resolve(), args.snapshot.resolve(), args.output.resolve()) if args.command == "prepare" else verify(args.root.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
