"""Offline preparation contracts; no model or production capture is exercised."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("memory_facts", REPO / "scripts/benchmark/prepare-memory-facts.py")
facts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(facts)


def question(qid, category, cluster):
    history = [{"id": cluster, "date": "2026-10-01", "messages": [{"role": "user", "content": "Cat: Luna"}]}]
    history_hash = facts.digest(json.dumps(history, ensure_ascii=False, separators=(",", ":")))
    return {"id": qid, "type": category, "question": "Name?", "date": "2026-10-04",
            "historyHash": history_hash, "history": history}


def candidate(lesson="Luna is the cat", origin="s1", apply="Discussing the cat"):
    return {"scope": "project", "kind": "summary", "confidence": "medium", "lesson": lesson,
            "applyWhen": apply, "origin": {"sessionId": origin}}


class PreparationTests(unittest.TestCase):
    def test_projection_excludes_question_answer_and_message_labels_from_build(self):
        q = question("q", facts.TYPES[0], "s")
        q.update(answer="SECRET_GOLD", has_answer=True)
        q["history"][0]["messages"][0]["has_answer"] = True
        projected = facts.project_question(q)
        self.assertNotIn("SECRET_GOLD", json.dumps(projected))
        self.assertNotIn("has_answer", json.dumps(projected))
        self.assertEqual(projected["history"][0]["messages"][0], {"role": "user", "content": "Cat: Luna"})

    def test_projection_rejects_changed_history(self):
        q = question("q", facts.TYPES[0], "s")
        q["history"][0]["messages"][0]["content"] = "Cat: Pip"
        with self.assertRaisesRegex(ValueError, "identity"):
            facts.project_question(q)

    def test_whole_clusters_and_audited_ids_never_enter_holdout(self):
        questions = [question(f"q{i}", t, f"s{i}") for i, t in enumerate(facts.TYPES * 5)]
        questions.append({**questions[0], "id": "same-history"})
        split = facts.split_questions(questions, {"q0"}, 2, 2)
        self.assertTrue({"q0", "same-history"} <= {q["id"] for q in split["development"]})
        clusters = [{q["historyHash"] for q in split[name]} for name in ("development", "holdout", "unused")]
        self.assertFalse(clusters[0] & clusters[1] or clusters[0] & clusters[2] or clusters[1] & clusters[2])
        again = facts.split_questions(list(reversed(questions)), {"q0"}, 2, 2)
        self.assertEqual(split, again)

    def test_cross_category_cluster_does_not_get_split(self):
        one = question("q1", facts.TYPES[0], "shared")
        two = {**one, "id": "q2", "type": facts.TYPES[1]}
        split = facts.split_questions([one, two], {"q1"}, 1, 1)
        self.assertEqual({q["id"] for q in split["development"]}, {"q1", "q2"})
        self.assertEqual(split["holdout"], [])

    def test_audited_overflow_is_disclosed_not_dropped(self):
        rows = [question(f"q{i}", facts.TYPES[0], f"s{i}") for i in range(3)]
        split = facts.split_questions(rows, {"q0", "q1"}, 1, 1)
        self.assertEqual(len(split["development"]), 2)
        self.assertIn({"split": "development", "type": facts.TYPES[0], "target": 1, "actual": 2}, split["deviations"])
        self.assertEqual(len(split["holdout"]), 1)

    def test_duplicate_and_unknown_ids_are_rejected(self):
        q = question("q", facts.TYPES[0], "s")
        for rows, audited in (([q, q], set()), ([q], {"missing"})):
            with self.assertRaises(ValueError):
                facts.split_questions(rows, audited)

    def test_empty_invalid_schema_and_truncation_are_distinct(self):
        def classify(text, status="completed"):
            return facts.classify_extraction({"status": status, "output_text": text})["state"]
        self.assertEqual(classify('{"entries":[]}'), "empty")
        self.assertEqual(classify('{"entries":['), "invalid_json")
        self.assertEqual(classify('{"entries":[' , "incomplete"), "truncated")
        self.assertEqual(classify('{"entries":{}}'), "invalid_schema")
        self.assertEqual(classify('{"entries":[{}]}'), "invalid_schema")
        self.assertEqual(classify('{"entries":[]}', "failed"), "invalid_terminal")
        self.assertEqual(classify('```json\n{"entries":[]}\n```'), "empty")

    def test_exact_duplicates_keep_all_provenance(self):
        merged = facts.preserve_candidates([candidate(), candidate(origin="s2"), candidate()])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["origins"], [{"sessionId": "s1"}, {"sessionId": "s2"}])

    def test_independent_facts_survive_without_a_model(self):
        items = [candidate("Pilsner/lager recommended", "beer", "Cooking stew"),
                 candidate("Provide regional recipes", "recipe", "Regional requests")]
        output = facts.preserve_candidates(items)
        self.assertEqual(len(output), 2)
        self.assertTrue(any("Pilsner/lager" in r["lesson"] for r in output))
        self.assertTrue(all(not r["review"] for r in output))

    def test_conflicts_remain_available_for_review(self):
        output = facts.preserve_candidates([candidate("Cat is Luna"), candidate("Cat is Pip", "s2")])
        self.assertEqual(len(output), 2)
        self.assertTrue(all(r["review"] for r in output))

    def test_metadata_differences_are_not_silently_merged(self):
        first = candidate()
        second = {**candidate(origin="s2"), "scope": "user"}
        self.assertEqual(len(facts.preserve_candidates([first, second])), 2)

    def test_safe_paths_and_hashes_reject_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            file = root / "a.json"
            file.write_text('{"ok":true}')
            checksum = hashlib.sha256(file.read_bytes()).hexdigest()
            self.assertEqual(facts.checked(file, checksum), {"ok": True})
            file.write_text('{"ok":false}')
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                facts.checked(file, checksum)
            with self.assertRaisesRegex(ValueError, "escapes"):
                facts.safe_child(root, "../outside.json")

    def test_plan_keeps_repetition_and_balanced_arm_rotation(self):
        rows = [question(f"q{i}", facts.TYPES[0], f"s{i}") for i in range(5)]
        planned = facts.plan_rows(rows, list(facts.VARIANTS), "development")
        self.assertEqual(len(planned), 25)
        self.assertEqual(len({r["key"] for r in planned}), 25)
        self.assertEqual([planned[i * 5]["arm"] for i in range(5)], list(facts.VARIANTS))
        self.assertTrue(all(r["status"] == "not_started" and r["repetition"] == 1 for r in planned))

    def test_24_synthetic_cases_have_traceable_expected_sources(self):
        fixture = facts.checked(REPO / "tests/fixtures/memory-fact-preservation.json")
        tasks = fixture["tasks"]
        self.assertEqual(len(tasks), 24)
        self.assertEqual(len({t["id"] for t in tasks}), 24)
        self.assertEqual({c: sum(t["category"] == c for t in tasks) for c in {t["category"] for t in tasks}},
                         {"detail": 6, "update": 6, "cross-session": 6, "insufficient": 6})
        for task in tasks:
            events = [m["eventId"] for s in task["history"] for m in s["messages"]]
            self.assertEqual(len(events), len(set(events)))
            self.assertTrue(set(task["expected"]["evidenceEventIds"]) <= set(events))
            runtime = {k: v for k, v in task.items() if k != "expected"}
            self.assertNotIn("expected", runtime)
            self.assertEqual(task["expected"]["abstain"], task["category"] == "insufficient")


if __name__ == "__main__":
    unittest.main()
