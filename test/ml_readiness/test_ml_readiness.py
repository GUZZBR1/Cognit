import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import ml_readiness  # noqa: E402

FIXTURES = ROOT / "fixtures" / "ml-readiness"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class ReadinessTests(unittest.TestCase):
    def test_eligible_is_deterministic_and_keeps_unknown_out_of_trainable_classes(self):
        manifest = fixture("eligible.json")
        report = ml_readiness.evaluate(manifest)
        self.assertEqual(report, ml_readiness.evaluate(copy.deepcopy(manifest)))
        self.assertEqual("YES", report["ml_ready"])
        self.assertEqual(1, report["counts"]["classes_by_split"]["train"]["UNKNOWN"])
        self.assertNotIn("UNKNOWN", manifest["protocol"]["trainable_labels"])
        self.assertEqual(0.9, report["protocol"]["precision_target"])
        self.assertFalse(report["training_invoked"])

    def test_unknown_cannot_replace_a_required_trainable_class(self):
        report = ml_readiness.evaluate(fixture("unknown-label.json"))
        self.assertEqual(2, report["counts"]["classes_by_split"]["train"]["UNKNOWN"])
        self.assertIn("CLASS_COVERAGE_INSUFFICIENT", {reason["code"] for reason in report["reasons"]})

    def test_group_leakage_is_reported_without_exposing_group_ids(self):
        report = ml_readiness.evaluate(fixture("group-leakage.json"))
        self.assertEqual("NO", report["ml_ready"])
        self.assertIn("GROUP_LEAKAGE", {reason["code"] for reason in report["reasons"]})
        self.assertEqual(1, report["group_overlap_counts"]["session"]["train:validation"])
        self.assertNotIn("session-train-HUMAN", json.dumps(report))

    def test_each_protocol_group_dimension_is_checked_for_leakage(self):
        for dimension in ("participant", "session", "agent_config"):
            with self.subTest(dimension=dimension):
                manifest = fixture("eligible.json")
                manifest["records"][2]["groups"][dimension] = manifest["records"][0]["groups"][dimension]
                report = ml_readiness.evaluate(manifest)
                self.assertIn("GROUP_LEAKAGE", {reason["code"] for reason in report["reasons"]})
                self.assertEqual(1, report["group_overlap_counts"][dimension]["train:validation"])

    def test_missing_and_unsealed_holdout_fail(self):
        missing = ml_readiness.evaluate(fixture("holdout-missing.json"))
        unsealed = ml_readiness.evaluate(fixture("holdout-unsealed.json"))
        self.assertIn("HOLDOUT_MISSING", {reason["code"] for reason in missing["reasons"]})
        self.assertIn("HOLDOUT_NOT_SEALED", {reason["code"] for reason in missing["reasons"]})
        self.assertIn("HOLDOUT_NOT_SEALED", {reason["code"] for reason in unsealed["reasons"]})

    def test_invalid_label_provenance_fails(self):
        report = ml_readiness.evaluate(fixture("invalid-provenance.json"))
        self.assertIn("LABEL_PROVENANCE_INVALID", {reason["code"] for reason in report["reasons"]})

    def test_malformed_provenance_fails_closed(self):
        manifest = fixture("eligible.json")
        manifest["records"][0]["ground_truth"]["provenance"] = []
        report = ml_readiness.evaluate(manifest)
        self.assertIn("LABEL_PROVENANCE_INVALID", {reason["code"] for reason in report["reasons"]})

    def test_label_source_reference_and_supported_protocol_version_are_required(self):
        manifest = fixture("eligible.json")
        del manifest["records"][0]["ground_truth"]["reference"]
        manifest["protocol"]["version"] = "unknown"
        report = ml_readiness.evaluate(manifest)
        codes = {reason["code"] for reason in report["reasons"]}
        self.assertIn("LABEL_PROVENANCE_INVALID", codes)
        self.assertIn("PROTOCOL_VERSION_INVALID", codes)

    def test_missing_required_group_fails(self):
        manifest = fixture("eligible.json")
        del manifest["records"][0]["groups"]["participant"]
        report = ml_readiness.evaluate(manifest)
        self.assertIn("GROUP_ID_MISSING", {reason["code"] for reason in report["reasons"]})

    def test_duplicate_record_id_fails(self):
        manifest = fixture("eligible.json")
        manifest["records"][1]["record_id"] = manifest["records"][0]["record_id"]
        report = ml_readiness.evaluate(manifest)
        self.assertIn("INVALID_INPUT", {reason["code"] for reason in report["reasons"]})

    def test_missing_predeclared_precision_criteria_fails_closed(self):
        manifest = fixture("eligible.json")
        del manifest["protocol"]["criteria"]["precision_target"]
        report = ml_readiness.evaluate(manifest)
        self.assertEqual("NO", report["ml_ready"])
        self.assertIn("PROTOCOL_CRITERIA_MISSING", {reason["code"] for reason in report["reasons"]})

    def test_required_group_dimensions_cannot_be_omitted_or_replaced(self):
        for dimensions in (["agent_config"], ["session", "arbitrary"]):
            with self.subTest(dimensions=dimensions):
                manifest = fixture("eligible.json")
                manifest["protocol"]["group_dimensions"] = dimensions
                report = ml_readiness.evaluate(manifest)
                self.assertEqual("NO", report["ml_ready"])
                self.assertIn("PROTOCOL_CRITERIA_MISSING", {reason["code"] for reason in report["reasons"]})

    def test_boolean_coverage_thresholds_are_rejected(self):
        manifest = fixture("eligible.json")
        for key, limits in manifest["protocol"]["criteria"].items():
            if key == "minimum_class_records_per_split":
                for label in limits:
                    limits[label] = True
            elif key == "minimum_independent_groups_per_split":
                for per_split in limits.values():
                    for split in per_split:
                        per_split[split] = True
        report = ml_readiness.evaluate(manifest)
        self.assertIn("PROTOCOL_CRITERIA_MISSING", {reason["code"] for reason in report["reasons"]})

    def test_cli_outputs_versioned_report_and_exit_code(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "ml_readiness.py"),
             str(FIXTURES / "eligible.json")], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual("ml-readiness-v1", report["report_version"])
        self.assertEqual("SIMULATED", report["evidence_mode"])

    def test_evaluator_has_no_model_training_imports(self):
        source = (ROOT / "scripts" / "ml_readiness.py").read_text(encoding="utf-8").lower()
        for module in ("sklearn", "lightgbm", "xgboost", "torch", "tensorflow"):
            self.assertNotIn(f"import {module}", source)
            self.assertNotIn(f"from {module}", source)


if __name__ == "__main__":
    unittest.main()
