import json
import unittest
from pathlib import Path

from experimental_pipeline_report import build_pipeline_report


ROOT = Path(__file__).parent
FIXTURE = ROOT / "fixtures" / "trial-record-benchmark-v1"


class ExperimentalPipelineReportTests(unittest.TestCase):
    def test_combines_deterministic_simulated_benchmark_and_separate_readiness_gate(self):
        export = FIXTURE / "trial-record-export.jsonl"
        readiness = ROOT / "fixtures" / "ml-readiness" / "eligible.json"
        report = build_pipeline_report(export, readiness)

        self.assertEqual(report, build_pipeline_report(export, readiness))
        self.assertEqual(report["evidence_class"], "SIMULATED")
        self.assertEqual(report["components"]["benchmark"]["report"]["evidence_class"], "SIMULATED")
        self.assertEqual(report["components"]["benchmark"]["report"]["groups"]["playwright"]["trial_record_export"]["trial_manifest"]["manifest_id"], "manifest-fixture-benchmark-v1")
        readiness_report = report["components"]["dataset_readiness"]["report"]
        self.assertEqual(readiness_report["evidence_mode"], "SIMULATED")
        self.assertFalse(readiness_report["training_invoked"])
        self.assertTrue(report["components"]["dataset_readiness"]["independent_of_benchmark_records"])
        self.assertEqual(report, json.loads((FIXTURE / "experimental-pipeline-report.json").read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
