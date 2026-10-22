import json
import tempfile
import unittest
from pathlib import Path

from evaluation_runner import run_evaluation, write_report


class EvaluationRunnerTests(unittest.TestCase):
    def test_runs_predictor_times_calls_and_writes_reproducible_json(self):
        cases = [
            {"actual_positive": True, "input": "positive"},
            {"actual_positive": False, "human_ground_truth": True, "input": "human"},
        ]
        predictions = {
            "positive": {"predicted_positive": True, "score": 0.9},
            "human": {"predicted_positive": False, "score": 0.1},
        }
        ticks = iter((0, 2_000_000, 3_000_000, 7_000_000))
        report = run_evaluation(cases, predictions.__getitem__, timer_ns=lambda: next(ticks))

        self.assertEqual(report["run"], {"case_count": 2, "evaluated_count": 2})
        self.assertEqual(report["counts"], {"tp": 1, "fp": 0, "tn": 1, "fn": 0, "excluded_unknown": 0})
        self.assertEqual(report["latency"], {"count": 2, "unit": "ms", "mean": 3, "median": 3})
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            write_report(report, output)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), report)
            first_output = output.read_text(encoding="utf-8")
            write_report(report, output)
            self.assertEqual(output.read_text(encoding="utf-8"), first_output)
            self.assertNotIn("timestamp", output.read_text(encoding="utf-8"))

    def test_rejects_invalid_labels_and_predictions(self):
        with self.assertRaises(ValueError):
            run_evaluation([{"actual_positive": "yes", "input": 1}], lambda value: {})
        with self.assertRaises(ValueError):
            run_evaluation(
                [{"actual_positive": True, "input": 1}],
                lambda value: {"predicted_positive": "yes"},
            )


if __name__ == "__main__":
    unittest.main()
