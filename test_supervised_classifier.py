import unittest
import sys
from types import ModuleType
from unittest.mock import patch

from supervised_classifier import prepare_dataset, stratified_split, train_and_report


def record(label, value):
    return {
        "label": label,
        "label_provenance": {"reviewer_type": "independent_human", "method": "independent review", "origin": "facilitated observation", "procedure": "protocol-v1"},
        "feature_pipeline_version": 1,
        "features": {"distancePx": value, "pauseCount": None},
    }


class SupervisedClassifierTests(unittest.TestCase):
    def test_preparation_requires_label_provenance_and_keeps_unknown_out_of_training(self):
        prepared = prepare_dataset([record("HUMAN", 1), {"label": "UNKNOWN"}])
        self.assertEqual(prepared["class_counts"], {"HUMAN": 1})
        self.assertEqual(prepared["excluded"], {"unknown_label": 1})
        self.assertTrue(prepared["rows"][0]["features"][1] != prepared["rows"][0]["features"][1])
        invalid = record("AI_AGENT", 2)
        invalid["label_provenance"] = {"method": "model prediction", "origin": "model", "procedure": "v1"}
        with self.assertRaisesRegex(ValueError, "independent_label_provenance"):
            prepare_dataset([invalid])

    def test_feature_versions_and_schema_must_match(self):
        invalid_version = record("HUMAN", 1)
        invalid_version["feature_pipeline_version"] = 2
        with self.assertRaisesRegex(ValueError, "unsupported_feature_version"):
            prepare_dataset([invalid_version])
        with self.assertRaisesRegex(ValueError, "feature_schema_mismatch"):
            prepare_dataset([record("HUMAN", 1), {**record("AI_AGENT", 2), "features": {"different": 2}}])

    def test_split_is_reproducible_and_marks_single_example_class_unavailable(self):
        rows = [{"label": "HUMAN"} for _ in range(4)] + [{"label": "AI_AGENT"} for _ in range(3)] + [{"label": "BROWSER_AUTOMATION"}]
        first = stratified_split(rows, seed=7)
        self.assertEqual(first, stratified_split(rows, seed=7))
        train, test, unavailable = first
        self.assertIn("BROWSER_AUTOMATION", unavailable)
        self.assertEqual(len(train) + len(test), 7)
        self.assertTrue(train)
        self.assertTrue(test)

    def test_report_records_source_versions_split_and_absent_classes(self):
        records = [record("HUMAN", value) for value in range(3)] + [record("AI_AGENT", value + 5) for value in range(3)]
        report = train_and_report(records, dataset_source="independent-review-export-v1", seed=13)
        self.assertEqual(report["dataset_source"], "independent-review-export-v1")
        self.assertEqual(report["feature_pipeline_version"], 1)
        self.assertEqual(report["data"]["split"]["seed"], 13)
        self.assertIn("BROWSER_AUTOMATION", report["unavailable_classes"])
        self.assertEqual(report["training_status"], "unavailable")
        self.assertEqual(report["training_unavailable_reason"], "no_boosting_dependency_installed")
        self.assertIn("UNKNOWN records are excluded", report["limitations"][-2])

    def test_source_is_required(self):
        with self.assertRaisesRegex(ValueError, "dataset_source_is_required"):
            train_and_report([], dataset_source=" ")

    def test_trains_each_available_boosting_implementation(self):
        class FakeLightGBM:
            def __init__(self, **_kwargs):
                pass

            def fit(self, _features, labels):
                self.label = labels[0]

            def predict(self, features):
                return [self.label] * len(features)

        class FakeXGBoost:
            def __init__(self, **_kwargs):
                pass

            def fit(self, _features, labels):
                self.label = labels[0]

            def predict(self, features):
                return [self.label] * len(features)

        lightgbm = ModuleType("lightgbm")
        lightgbm.LGBMClassifier = FakeLightGBM
        xgboost = ModuleType("xgboost")
        xgboost.XGBClassifier = FakeXGBoost
        records = [record("HUMAN", value) for value in range(3)] + [record("AI_AGENT", value + 5) for value in range(3)]
        with patch.dict(sys.modules, {"lightgbm": lightgbm, "xgboost": xgboost}):
            report = train_and_report(records, dataset_source="test-fixture", seed=13)
        self.assertEqual(set(report["models"]), {"LightGBM", "XGBoost"})
        self.assertEqual(report["training_status"], "trained")
        self.assertEqual(report["training_unavailable_reason"], None)


if __name__ == "__main__":
    unittest.main()
