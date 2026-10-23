import json
import unittest

from evaluation_harness import evaluate_records


class EvaluationHarnessTests(unittest.TestCase):
    def test_metrics_include_counts_denominators_auc_and_latency(self):
        report = evaluate_records([
            {"actual_positive": True, "predicted_positive": True, "score": 0.9, "latency_ms": 10},
            {"actual_positive": True, "predicted_positive": False, "score": 0.4, "latency_ms": 30},
            {"actual_positive": False, "predicted_positive": True, "score": 0.8, "human_ground_truth": True},
            {"actual_positive": False, "predicted_positive": False, "score": 0.1, "human_ground_truth": True},
            {"actual_positive": True, "predicted_positive": None, "score": 0.7},
        ])
        self.assertIs(report["positive_class"], True)
        self.assertEqual(report["counts"], {"tp": 1, "fp": 1, "tn": 1, "fn": 1, "excluded_unknown": 1})
        metrics = report["metrics"]
        for name in ("precision", "recall", "fpr", "fnr"):
            self.assertEqual(metrics[name], {"numerator": 1, "denominator": 2, "value": 0.5})
        human_fpr = metrics["human_fpr"]
        self.assertEqual((human_fpr["numerator"], human_fpr["denominator"], human_fpr["value"]), (1, 2, 0.5))
        self.assertIn("human_ground_truth_true_actual_negatives", human_fpr["scope"])
        self.assertAlmostEqual(metrics["auc"]["value"], 2 / 3)
        self.assertEqual((metrics["auc"]["numerator"], metrics["auc"]["denominator"]), (4, 6))
        self.assertEqual(metrics["auc"]["positive_direction"], "higher_score")
        self.assertEqual(report["latency"], {"count": 2, "unit": "ms", "mean": 20, "median": 20})
        json.dumps(report)

    def test_zero_denominators_and_absent_optional_values_are_unavailable(self):
        report = evaluate_records([
            {"actual_positive": True, "predicted_positive": None},
            {"actual_positive": True, "predicted_positive": None, "score": 1.0},
        ])
        self.assertEqual(report["counts"]["excluded_unknown"], 2)
        for name in ("precision", "recall", "fpr", "fnr", "human_fpr"):
            metric = report["metrics"][name]
            self.assertEqual(metric["numerator"], 0)
            self.assertEqual(metric["denominator"], 0)
            self.assertIsNone(metric["value"])
            self.assertTrue(metric["unavailable_reason"])
        self.assertIsNone(report["metrics"]["auc"]["value"])
        self.assertEqual(report["metrics"]["auc"]["unavailable_reason"], "scored_rows_require_both_classes")
        self.assertEqual(report["latency"]["count"], 0)
        self.assertIsNone(report["latency"]["mean"])
        self.assertIsNone(report["latency"]["median"])
        self.assertEqual(report["latency"]["unavailable_reason"], "no_valid_latency_values")

    def test_human_fpr_only_uses_human_actual_negatives_with_known_predictions(self):
        report = evaluate_records([
            {"actual_positive": False, "predicted_positive": True, "human_ground_truth": False},
            {"actual_positive": True, "predicted_positive": True, "human_ground_truth": True},
            {"actual_positive": False, "predicted_positive": None, "human_ground_truth": True},
            {"actual_positive": False, "predicted_positive": False, "human_ground_truth": True},
        ])
        human_fpr = report["metrics"]["human_fpr"]
        self.assertEqual((human_fpr["numerator"], human_fpr["denominator"], human_fpr["value"]), (0, 1, 0))


if __name__ == "__main__":
    unittest.main()
