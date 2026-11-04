"""Compare sealed diagnostic pilots without model calls or changes to either campaign."""
import argparse
import collections
import datetime
import hashlib
import json
import pathlib
import statistics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=pathlib.Path, required=True)
    parser.add_argument("--after", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    before, after, output = args.before.resolve(), args.after.resolve(), args.output.resolve()
    if any(output.is_relative_to(root) for root in (before, after)):
        raise ValueError("Keep comparison outside campaigns")
    hashes = {}

    def read(file):
        data = file.read_bytes()
        hashes[str(file)] = hashlib.sha256(data).hexdigest()
        return json.loads(data)

    old, new = read(before / "report.json"), read(after / "report.json")
    read(before / "run-state.json")
    finished = read(after / "run-state.json")
    started = read(after / "started.json")
    old_plan, new_plan = read(before / "manifest.json"), read(after / "manifest.json")
    if old_plan["planned"] != new_plan["planned"] or old_plan["smokeIds"] != new_plan["smokeIds"]:
        raise ValueError("Pilot membership differs")
    planned = new_plan["planned"]
    if len(planned) != 24 or {r["key"] for r in new["rows"]} != {r["key"] for r in planned}:
        raise ValueError("Expected all 24 planned terminal rows")
    questions = {q["id"]: q for q in read(after / "history.json")}
    requests = [read(file) for file in sorted((after / "requests").glob("*.json"))]
    if len({r["key"] for r in requests}) != len(requests):
        raise ValueError("Duplicate request accounting")
    tokens = lambda rs: sum(r["usage"]["inputTokens"] + r["usage"]["outputTokens"] for r in rs)
    if tokens(requests) != new["knownTokens"]:
        raise ValueError("Ledger and summary differ")
    rows = {r["key"]: r for r in new["rows"]}
    previous = {r["key"]: r for r in old["rows"]}
    arms = ["fact-memory", "bm25-history"]
    costs, details = {}, []
    for arm in arms:
        records = [r for r in requests if f":1:{arm}:" in r["key"]]
        costs[arm] = {"requests": len(records), "tokens": tokens(records),
                      "phases": {p: tokens([r for r in records if r["phase"] == p]) for p in ("extract", "answer", "judge")},
                      "answerLatencyMsMedian": statistics.median([r["durationMs"] for r in records if r["phase"] == "answer" and "durationMs" in r]) if any(r["phase"] == "answer" for r in records) else None}
    for item in planned:
        row = rows[item["key"]]
        sample = after / "samples" / hashlib.sha256(item["key"].encode()).hexdigest()
        facts = [f for file in sample.glob("store/projects/*/facts.json") for f in read(file)]
        checkpoint = read(sample / "fact-build.json") if (sample / "fact-build.json").exists() else None
        selected = set(row.get("retrieval", {}).get("entryIds", []))
        details.append({**item, "type": questions[item["questionId"]]["type"], "beforeStatus": previous[item["key"]]["status"],
                        "status": row["status"], "correct": row["correct"], "failure": row.get("failure"),
                        "storedFacts": len(facts), "retrievedFacts": len(selected), "rejectedFacts": (checkpoint or {}).get("rejectedFacts", 0),
                        "builtSessions": (checkpoint or {}).get("next", 0), "plannedSessions": len(questions[item["questionId"]]["history"]),
                        "retrievedChars": len(row.get("retrieval", {}).get("text", "")),
                        "selectedEvidence": [f for f in facts if f["id"] in selected], "sample": str(sample)})
    category = {}
    for kind in sorted({q["type"] for q in questions.values() if not q["id"].startswith("smoke-")}):
        category[kind] = {arm: {"planned": len([d for d in details if d["type"] == kind and d["arm"] == arm]),
                               "correct": sum(d["correct"] is True for d in details if d["type"] == kind and d["arm"] == arm),
                               "states": dict(collections.Counter(d["status"] for d in details if d["type"] == kind and d["arm"] == arm))} for arm in arms}
    paired = []
    for qid in dict.fromkeys(i["questionId"] for i in planned):
        a, b = (rows[f"{qid}:1:{arm}"] for arm in arms)
        paired.append({"id": qid, "type": questions[qid]["type"], "fact": a["status"], "factCorrect": a["correct"],
                       "bm25": b["status"], "bm25Correct": b["correct"]})
    completed = [p for p in paired if p["fact"] == p["bm25"] == "completed"]
    matched_costs = {}
    for arm in arms:
        prefixes = tuple(f"{p['id']}:1:{arm}:" for p in completed)
        records = [r for r in requests if prefixes and r["key"].startswith(prefixes)]
        matched_costs[arm] = {"tokens": tokens(records), "usageComplete": all(r["usage"]["complete"] for r in records),
                              "phases": {p: tokens([r for r in records if r["phase"] == p]) for p in ("extract", "answer", "judge")}}
    fmt = lambda value: datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    summary = {"before": str(before), "after": str(after), "identity": new_plan["identity"], "groups": new["groups"],
               "beforeGroups": old["groups"], "smokePassed": sum(r["status"] == "completed" and r["correct"] is True for r in new["smoke"]),
               "categories": category, "paired": paired, "bothCompleted": new["bothCompleted"],
               "factOnlyCorrect": sum(p["factCorrect"] is True and p["bm25Correct"] is False for p in completed),
               "bm25OnlyCorrect": sum(p["factCorrect"] is False and p["bm25Correct"] is True for p in completed),
               "knownTokens": tokens(requests), "unknownSettled": sum(r["state"] == "settled" and not r["usage"]["complete"] for r in requests),
               "pending": sum(r["state"] != "settled" or r["openRequests"] != 0 for r in requests), "costs": costs, "matchedCosts": matched_costs,
               "elapsedSeconds": (fmt(finished["stoppedAt"]) - fmt(started["at"])).total_seconds(),
               "stopReason": new["stopReason"], "formalIntervals": None, "humanReviewed": False, "modelRequestsDuringAnalysis": 0,
               "sourceHashes": hashes}
    output.mkdir(parents=True, exist_ok=False)
    for name, value in (("comparison.json", summary), ("selected-evidence.json", details)):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# 修复后 Memory／BM25 小样本对照", "", "开发诊断集，自动评分，未人工复核；无正式置信区间。", "",
             "| 组别 | 完成 | 失败 | 跳过 | 正确／计划 |", "| --- | ---: | ---: | ---: | ---: |"]
    for arm in arms:
        g = new["groups"][arm]
        lines.append(f"| {arm} | {g['completed']} | {g['failed']} | {g['skipped']} | {g['correct']}/12 |")
    lines += ["", f"六项 smoke：{summary['smokePassed']}/6。双方成功配对：{len(completed)}/12；Memory 独对 {summary['factOnlyCorrect']}，BM25 独对 {summary['bm25OnlyCorrect']}。",
              f"总已知消耗 {summary['knownTokens']:,} tokens，unknown {summary['unknownSettled']}，pending {summary['pending']}；停止原因 {summary['stopReason']}。整批墙钟耗时 {summary['elapsedSeconds'] / 60:.1f} 分钟。", "",
              "| 类别 | Memory 正确／计划 | BM25 正确／计划 |", "| --- | ---: | ---: |"]
    for kind, groups in category.items():
        a, b = (groups[arm] for arm in arms)
        lines.append(f"| {kind} | {a['correct']}/{a['planned']} | {b['correct']}/{b['planned']} |")
    lines += ["", "| 题目 | Memory 状态／正确 | BM25 状态／正确 |", "| --- | --- | --- |"]
    for p in paired:
        lines.append(f"| {p['id']} | {p['fact']}／{p['factCorrect']} | {p['bm25']}／{p['bm25Correct']} |")
    lines += ["", "| 组别 | 构建 tokens | 回答 tokens | 评分 tokens | 回答请求中位耗时 ms |", "| --- | ---: | ---: | ---: | ---: |"]
    for arm, c in costs.items():
        lines.append(f"| {arm} | {c['phases']['extract']} | {c['phases']['answer']} | {c['phases']['judge']} | {c['answerLatencyMsMedian']} |")
    lines += ["", "上轮事实组 12 项全部在建库阶段失败。本轮应先判断建库恢复了多少，再讨论已完成回答的质量；不能将上轮执行失败当作同等条件下的错误回答。BM25 为本轮重新回答、独立评分，并未复用上轮答案。",
              "", "本轮共享生产事实提取与 snapshot，reader 无工具；实际 Session 原文回读工具的增益没有在此评测。每题独立建库费用不等于长期生产单次查询成本。三组历史基准、保留集和全量未启动。",
              "", "selected-evidence.json 保留各题建库进度、拒绝事实数、召回事实及来源。事实数量和来源覆盖不是事实支持率，也不能替代语义审计。"]
    (output / "comparison.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("groups", "knownTokens", "pending", "unknownSettled", "stopReason")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
