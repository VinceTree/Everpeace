"""Read-only pilot analysis; writes a new analysis directory and makes zero model calls."""
import argparse
import collections
import hashlib
import json
import pathlib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    root, output = args.campaign.resolve(), args.output.resolve()
    if output.is_relative_to(root):
        raise ValueError("Keep analysis outside the experiment")
    output.mkdir(parents=True, exist_ok=False)
    hashes = {}

    def read(file):
        data = file.read_bytes()
        hashes[str(file)] = hashlib.sha256(data).hexdigest()
        return json.loads(data)

    report = read(root / "report.json")
    manifest = read(root / "manifest.json")
    questions = {q["id"]: q for q in read(root / "history.json")}
    references = {r["id"]: r for r in read(root / "references.json")}
    requests = [read(p) for p in sorted((root / "requests").glob("*.json"))]
    if len({r["key"] for r in requests}) != len(requests):
        raise ValueError("Duplicate request keys")
    known = sum(r["usage"]["inputTokens"] + r["usage"]["outputTokens"] for r in requests)
    if known != report["knownTokens"]:
        raise ValueError("Request and campaign accounting differ")
    unknown = [r["key"] for r in requests if r["state"] == "settled" and not r["usage"]["complete"]]
    pending = [r["key"] for r in requests if r["state"] != "settled" or r["openRequests"]]
    phases = {}
    for phase in ("extract", "answer", "judge"):
        rows = [r for r in requests if r["phase"] == phase]
        phases[phase] = {"requests": len(rows), "input": sum(r["usage"]["inputTokens"] for r in rows),
                         "output": sum(r["usage"]["outputTokens"] for r in rows),
                         "modelRequestMsSum": sum(r.get("durationMs", 0) for r in rows)}
    by_key = {r["key"]: r for r in report["rows"]}
    if set(by_key) != {r["key"] for r in manifest["planned"]}:
        raise ValueError("Report does not cover every planned item")
    cases = []
    for item in manifest["planned"]:
        row = by_key[item["key"]]
        if row["questionId"] != item["questionId"] or row["arm"] != item["arm"]:
            raise ValueError("Result identity differs")
        q, ref = questions[row["questionId"]], references[row["questionId"]]
        retrieval = row.get("retrieval", {})
        gold, retrieved = set(ref["evidence"]), set(retrieval.get("sources", []))
        sample = pathlib.Path(row.get("retainedFrom", str(root))) / "samples" / hashlib.sha256(item["key"].encode()).hexdigest()
        facts = [f for p in sample.glob("store/projects/*/facts.json") for f in read(p)]
        cases.append({**item, "type": q["type"], "status": row["status"], "correct": row["correct"],
                      "question": q["question"], "reference": ref["answer"], "hypothesis": row.get("hypothesis"),
                      "goldSourcesCovered": len(gold & retrieved), "goldSources": len(gold),
                      "retrievedChars": len(retrieval.get("text", "")), "storedFacts": len(facts),
                      "failure": row.get("failure"), "source": str(sample),
                      "chainSignal": "execution_failure" if row["status"] == "failed" else "not_run" if row["status"] == "skipped"
                          else "correct" if row["correct"] else "needs_semantic_audit",
                      "facts": [{"id": f["id"], "statement": f["lesson"], "evidence": f["fact"]} for f in facts]})
    groups_usage = {}
    for arm in report["groups"]:
        group = [r for r in requests if f":1:{arm}:" in r["key"]]
        failed_prefixes = [r["key"] + ":" for r in report["rows"] if r["arm"] == arm and r["status"] == "failed"]
        groups_usage[arm] = {"requests": len(group),
            "knownTokens": sum(r["usage"]["inputTokens"] + r["usage"]["outputTokens"] for r in group),
            "knownFailureTokens": sum(r["usage"]["inputTokens"] + r["usage"]["outputTokens"] for r in group if any(r["key"].startswith(p) for p in failed_prefixes)),
            "phases": {phase: sum(r["usage"]["inputTokens"] + r["usage"]["outputTokens"] for r in group if r["phase"] == phase) for phase in phases}}
    summary = {"verificationStatus": "ANALYZED", "humanReviewed": False, "modelRequests": 0,
               "knownTokens": known, "unknown": unknown, "pending": pending, "phases": phases,
               "ancestry": report.get("continuation"), "accountingScope": "child_only" if report.get("continuation") else "campaign",
               "groupUsage": groups_usage,
               "groups": report["groups"], "bothCompleted": report["bothCompleted"], "stopReason": report["stopReason"],
               "formalIntervals": None, "sourceHashes": hashes,
               "categories": {t: {arm: dict(collections.Counter(r["status"] for r in cases if r["type"] == t and r["arm"] == arm))
                   for arm in report["groups"]} for t in sorted({r["type"] for r in cases})}}
    for name, value in (("summary.json", summary), ("cases.json", cases)):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Memory 12 题诊断报告", "", "小样本开发集；自动评分，未人工复核。未使用保留集，不报告正式置信区间。", "",
             "| 组别 | 完成 | 失败 | 跳过 | 正确／计划 |", "| --- | ---: | ---: | ---: | ---: |"]
    for arm, g in report["groups"].items():
        lines.append(f"| {arm} | {g['completed']} | {g['failed']} | {g['skipped']} | {g['correct']}/12 |")
    common = report["bothCompleted"]
    lines += ["", f"双方成功配对 {common['pairs']}：事实 Memory 正确 {common['factCorrect']}，BM25 正确 {common['bm25Correct']}。",
              f"六项 smoke：{sum(r['status']=='completed' and r['correct'] for r in report['smoke'])}/6。",
              f"已知 tokens：{known:,}；已关闭 unknown：{len(unknown)}；pending：{len(pending)}；停止原因：{report['stopReason']}。", "",
              "| 阶段 | 请求数 | input | output |", "| --- | ---: | ---: | ---: |"]
    for phase, p in phases.items():
        lines.append(f"| {phase} | {p['requests']} | {p['input']} | {p['output']} |")
    if report.get("continuation"):
        parent = report["continuation"]
        lines += ["", f"接续说明：状态与 smoke 包含继承记录；以上用量仅为本批。父已知 {parent['parentKnownTokens']:,} tokens，父 unknown {parent['parentUnknown']}，累计已知 {parent['cumulativeKnownTokens']:,} tokens；父未知未清零。"]
    lines += ["", "| 公开组别 | 构建 tokens | 回答 tokens | 评分 tokens | 已知失败 tokens |", "| --- | ---: | ---: | ---: | ---: |"]
    for arm, g in groups_usage.items():
        lines.append(f"| {arm} | {g['phases']['extract']} | {g['phases']['answer']} | {g['phases']['judge']} | {g['knownFailureTokens']} |")
    lines += ["", "构建费用是每题独立建库的实验成本，不能直接外推长期查询成本。reasoning 已包含在 output。失败消耗保留；unknown 存在时以上仅为已知下界。",
              "", "cases.json 保存每个计划项、存储事实、来源和召回覆盖；来源命中不等同答案细节覆盖，答错链路未做语义裁决。",
              "", "本轮为无工具 reader，共享生产事实提取与存储。memory_lookup／历史工具能力不由此评分。完整跑完不代表质量提升，工程门槛和保留集结论仍未验证。"]
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("knownTokens", "groups", "stopReason", "bothCompleted")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
