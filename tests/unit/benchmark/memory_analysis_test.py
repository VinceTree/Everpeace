import importlib.util
import json
import pathlib
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("memory_analysis", REPO / "scripts/benchmark/analyze-memory.py")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


def row(arm, repetition, correct, status="completed"):
    return {"key": f"q-{repetition}-{arm}", "questionId": "q", "repetition": repetition, "arm": arm, "historyHash": "same-history", "status": status, "correct": correct}


def request(key, state, complete, open_requests=0, tokens=6):
    return {"key": key, "state": state, "openRequests": open_requests, "usage": {"complete": complete, "inputTokens": tokens-2, "outputTokens": 2, "reasoningTokens": 1,
            "attempts": [{"status": "completed" if complete else "transport_failure", "usage": {"input_tokens": tokens-2, "output_tokens": 2}}]}}


class MemoryAnalysisTests(unittest.TestCase):
    def test_failed_and_unrun_have_distinct_denominators(self):
        stats = analysis.quality([row("learned-memory", 1, True), row("learned-memory", 2, None, "failed")], 3)
        self.assertEqual((stats["accuracyOverSettled"], stats["accuracyOverCompleted"], stats["accuracyOverPlanned"]), (.5, 1, 1/3))
        self.assertEqual(stats["notSettled"], 1)

    def test_three_repeats_are_one_question_and_cluster(self):
        rows = [row(a, rep, a == "bm25-history") for rep in (1, 2, 3) for a in ("learned-memory", "bm25-history")]
        result = analysis.paired(rows, "bm25-history")
        self.assertEqual((result["pairs"], result["uniqueQuestions"], result["historyClusters"]), (3, 1, 1))
        self.assertEqual(result["differencePp"], -100)
        self.assertIsNone(result["interval95"])

    def test_complete_pair_diagnostic_does_not_silently_drop_failed_main_pair(self):
        rows = [row("learned-memory", 1, None, "failed"), row("bm25-history", 1, True), row("learned-memory", 2, True), row("bm25-history", 2, True)]
        self.assertEqual(analysis.paired(rows, "bm25-history")["pairs"], 2)
        self.assertEqual(analysis.paired(rows, "bm25-history", True)["pairs"], 1)

    def test_closed_unknown_and_pending_are_not_conflated_or_reasoning_added_twice(self):
        stats = analysis.usage([request("closed", "settled", False), request("pending", "pending", False, 1), request("known", "settled", True)])
        self.assertEqual(stats["closedUnknown"], ["closed"])
        self.assertEqual(stats["pending"], ["pending"])
        self.assertEqual(stats["knownTokens"], 18)
        self.assertEqual(stats["reasoningTokensSubsetOfOutput"], 3)
        self.assertFalse(stats["complete"])

    def test_result_identity_and_missing_score_are_rejected(self):
        item = row("learned-memory", 1, True)
        self.assertTrue(analysis.row_valid(item, item))
        self.assertFalse(analysis.row_valid({**item, "correct": None}, item))
        self.assertFalse(analysis.row_valid({**item, "historyHash": "other"}, item))

    def test_replay_uses_original_bytes_after_live_file_changes_and_checks_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            original = root / "live.json"
            original.write_text('{"value":1}', encoding="utf8")
            frozen, replayed = root / "frozen", root / "replayed"
            frozen.mkdir(); replayed.mkdir()
            snapshot = analysis.Evidence(frozen)
            self.assertEqual(snapshot.read(original), {"value": 1})
            analysis.save(frozen / "source-index.json", snapshot.index)
            original.write_text('{"value":2}', encoding="utf8")
            self.assertEqual(analysis.Evidence(replayed, frozen).read(original), {"value": 1})
            info = snapshot.index[str(original.resolve())]
            (frozen / info["blob"]).write_text('{"value":99}', encoding="utf8")
            other = root / "other"; other.mkdir()
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                analysis.Evidence(other, frozen).read(original)

    def test_gold_source_hit_is_not_claimed_to_be_answer_presence(self):
        r = {**row("learned-memory", 1, False), "retrieval": {"text": "generic procedure", "sources": ["s"], "active": 1, "review": 0, "archived": 0, "clippedChars": 0}}
        result = analysis.retrieval([r], {"q": {"evidence": ["s"]}})
        self.assertEqual(result["sourceRecall"], 1)
        self.assertNotIn("answerPresent", result)


if __name__ == "__main__":
    unittest.main()
