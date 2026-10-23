import json
import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from benchmark_report import build_report


def rehash_export_header(export):
    payload = {key: value for key, value in export.items() if key != "envelope_hash"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    export["envelope_hash"] = hashlib.sha256(canonical.encode()).hexdigest()


class BenchmarkReportTests(unittest.TestCase):
    def write_json(self, directory, name, document):
        path = Path(directory) / name
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def test_missing_groups_are_unavailable_without_inferred_metrics(self):
        report = build_report({})
        self.assertEqual(report, build_report({}))
        self.assertEqual(report["evidence_class"], "UNAVAILABLE")
        self.assertEqual(set(report["groups"]), {"human", "playwright", "selenium", "puppeteer"})
        for group in report["groups"].values():
            self.assertEqual(group["status"], "UNAVAILABLE")
            self.assertEqual(group["reason"], "no_dataset_supplied")
        self.assertIn("95% Clopper-Pearson exact binomial", report["protocol"]["uncertainty"])
        self.assertEqual(len(report["protocol"]["challenge_set_sha256"]), 64)

    def test_automation_aggregates_rates_features_versions_and_session_uncertainty(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "selenium.json", {
                "schema_version": 1,
                "session_id": "session-1",
                "attempts": [
                    {
                        "session_id": "session-1",
                        "tool": "selenium-webdriver",
                        "tool_version": "4.0",
                        "browser": "Chrome",
                        "browser_version": "130",
                        "challenge_id": "c1",
                        "mouse_telemetry": {"status": "complete", "features": {"pauseCount": 2}},
                        "features": {"signals": [{"id": "navigator_webdriver", "observed": True}]},
                        "observed_result": {"correct": True, "reaction_time_ms": 100, "duration_ms": 50},
                    },
                    {
                        "session_id": "session-2",
                        "tool": "selenium-webdriver",
                        "tool_version": "4.0",
                        "browser": "Chrome",
                        "browser_version": "130",
                        "challenge_id": "c1",
                        "mouse_telemetry": {"status": "incomplete", "features": None},
                        "observed_result": {"correct": False, "reaction_time_ms": 300, "duration_ms": 50},
                    },
                ],
            })
            group = build_report({"selenium": path})["groups"]["selenium"]

        self.assertEqual(group["status"], "AVAILABLE")
        self.assertEqual(group["sample"], {
            "clusters": 2, "cluster_unit": "session_id", "attempts": 2, "accuracy_eligible_attempts": 2,
            "independently_confirmed_human_attempts": 0,
        })
        self.assertEqual(group["metrics"]["accuracy"]["numerator"], 1)
        self.assertEqual(group["metrics"]["accuracy"]["denominator"], 2)
        self.assertEqual(group["metrics"]["reaction_time_ms"]["mean"], 200)
        self.assertEqual(group["metrics"]["reaction_time_ms"]["uncertainty_95"]["method"],
                         "percentile bootstrap resampling cluster summaries")
        self.assertEqual(group["metrics"]["accuracy"]["value"], 0.5)
        self.assertEqual(group["mouse_features"]["pauseCount"]["count"], 1)
        self.assertEqual(group["browser_signals"]["navigator_webdriver"]["denominator"], 1)
        self.assertEqual(group["versions"]["browser_version"], ["130"])
        self.assertEqual(group["challenge_performance"]["c1"]["denominator"], 2)
        self.assertIsNone(group["metrics"]["completion_time_ms"]["mean"])
        self.assertEqual(group["metrics"]["completion_time_ms"]["unavailable_reason"], "no_eligible_observations")

    def test_human_metrics_require_confirmation_and_prediction_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [
                    {
                        "pseudonym": f"p-{index}", "HUMAN_CONFIRMED": True,
                        "human_confirmation": {"method": "review", "origin": "observed", "procedure": "v1"},
                        "correct": index == 0, "reaction_time_ms": 100 + index,
                        "duration_ms": 50, "predicted_automation": index == 0,
                        "prediction_provenance": {"method": "detector", "origin": "offline-eval", "version": "v1"},
                    }
                    for index in range(2)
                ] + [{"pseudonym": "unreviewed", "correct": True, "reaction_time_ms": 1}],
            })
            report = build_report({"human": path})
            group = report["groups"]["human"]

        self.assertEqual(group["sample"]["attempts"], 2)
        self.assertEqual(group["metrics"]["accuracy"]["denominator"], 2)
        self.assertEqual(group["metrics"]["legacy_predicted_automation_rate_secondary"]["numerator"], 1)
        self.assertEqual(group["metrics"]["legacy_predicted_automation_rate_secondary"]["denominator"], 2)
        self.assertEqual(group["metrics"]["reaction_time_ms"]["uncertainty_95"]["confidence_level"], 0.95)
        self.assertEqual(group["sample"]["cluster_unit"], "consent_pseudonym")

    def test_repeated_human_attempts_share_a_consent_cluster_not_independent_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [
                    {
                        "pseudonym": "same-consent", "HUMAN_CONFIRMED": True,
                        "human_confirmation": {"method": "review", "origin": "observed", "procedure": "v1"},
                        "correct": index == 0, "reaction_time_ms": 100 + index,
                        "duration_ms": 50,
                    }
                    for index in range(3)
                ],
            })
            group = build_report({"human": path})["groups"]["human"]

        self.assertEqual(group["sample"]["clusters"], 1)
        self.assertEqual(group["sample"]["cluster_unit"], "consent_pseudonym")
        self.assertEqual(group["sample"]["attempts"], 3)
        self.assertEqual(group["metrics"]["accuracy"]["cluster_count"], 1)
        self.assertEqual(
            group["metrics"]["accuracy"]["uncertainty_95"]["unavailable_reason"],
            "requires_at_least_two_clusters",
        )

    def test_human_without_operator_confirmation_stays_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [{"pseudonym": "p-1", "correct": True}],
            })
            group = build_report({"human": path})["groups"]["human"]
        self.assertEqual(group["status"], "UNAVAILABLE")
        self.assertEqual(group["reason"], "no_independently_confirmed_human_records")

    def test_human_null_timing_and_missing_prediction_are_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "human.json", {
                "schema_version": 1,
                "records": [{
                    "pseudonym": f"p-{index}", "HUMAN_CONFIRMED": True,
                    "human_confirmation": {"method": "review", "origin": "observed", "procedure": "v1"},
                    "correct": True, "reaction_time_ms": None, "duration_ms": None,
                } for index in range(2)],
            })
            metrics = build_report({"human": path})["groups"]["human"]["metrics"]
        self.assertIsNone(metrics["reaction_time_ms"]["mean"])
        self.assertEqual(metrics["reaction_time_ms"]["unavailable_reason"], "no_eligible_observations")
        self.assertEqual(metrics["legacy_predicted_automation_rate_secondary"]["denominator"], 0)
        self.assertIsNone(metrics["legacy_predicted_automation_rate_secondary"]["value"])


    def test_primary_human_endpoint_uses_one_earliest_session_per_participant(self):
        fixture = Path(__file__).parent / "fixtures/benchmark-v1/human-zero.json"
        endpoint = build_report({"human": fixture})["endpoints"]["human_false_positive_rate"]
        self.assertEqual(endpoint["status"], "AVAILABLE")
        self.assertEqual(endpoint["participants"], 2)
        self.assertEqual(endpoint["sessions_considered"], 3)
        self.assertEqual(endpoint["numerator"], 0)
        self.assertEqual(endpoint["denominator"], 2)
        self.assertEqual(endpoint["interval_95"]["method"], "two-sided Clopper-Pearson exact binomial interval")
        self.assertGreater(endpoint["interval_95"]["upper"], 0)

    def test_primary_endpoint_counts_outcomes_and_excludes_oracle_records(self):
        fixture = Path(__file__).parent / "fixtures/benchmark-v1/automation.json"
        report = build_report({"selenium": fixture})
        endpoint = report["endpoints"]
        self.assertEqual(endpoint["challenge_applied"]["outcomes"]["CHALLENGE"], 1)
        self.assertEqual(endpoint["automation_escape_to_protected_action"]["denominator"], 1)
        self.assertEqual(endpoint["automation_escape_to_protected_action"]["numerator"], 1)
        self.assertEqual(report["groups"]["selenium"]["sample"]["attempts"], 1)

    def test_primary_human_endpoint_is_unavailable_for_unknown_or_missing_group(self):
        unknown = Path(__file__).parent / "fixtures/benchmark-v1/unknown-outcome.json"
        report = build_report({"human": unknown})
        endpoint = report["endpoints"]["human_false_positive_rate"]
        self.assertEqual(endpoint["status"], "UNAVAILABLE")
        self.assertIsNone(endpoint["denominator"])
        empty = Path(__file__).parent / "fixtures/benchmark-v1/empty-group.json"
        group = build_report({"human": empty})["groups"]["human"]
        self.assertEqual(group["status"], "UNAVAILABLE")
        self.assertFalse("metrics" in group)

    def test_positive_exact_interval_is_bounded_and_trial_record_adapter_is_accepted(self):
        positive = Path(__file__).parent / "fixtures/benchmark-v1/human-positive.json"
        endpoint = build_report({"human": positive})["endpoints"]["human_false_positive_rate"]
        self.assertEqual((endpoint["numerator"], endpoint["denominator"]), (2, 2))
        self.assertLess(endpoint["interval_95"]["lower"], 1)
        trial = Path(__file__).parent / "fixtures/benchmark-v1/trial-record-v1.json"
        report = build_report({"selenium": trial})
        self.assertNotIn("metrics", report["groups"]["selenium"])
        self.assertEqual(report["groups"]["selenium"]["reason"], "no_non_oracle_eligible_records")

    def test_invalid_trial_record_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "trial.json", {"schema_version": 1, "trial_records": [{"session_id": "s1"}]})
            with self.assertRaisesRegex(ValueError, "incomplete TrialRecord v1"):
                build_report({"selenium": path})

    def test_automation_session_ids_are_scoped_to_runner_group(self):
        with tempfile.TemporaryDirectory() as directory:
            playwright = self.write_json(directory, "playwright.json", {"schema_version": 1, "session_id": "same", "attempts": [{"session_id": "same", "policy_outcome": "CHALLENGE", "protected_action_reached": True}]})
            selenium = self.write_json(directory, "selenium.json", {"schema_version": 1, "session_id": "same", "attempts": [{"session_id": "same", "policy_outcome": "CHALLENGE", "protected_action_reached": False}]})
            rate = build_report({"playwright": playwright, "selenium": selenium})["endpoints"]["automation_escape_to_protected_action"]
        self.assertEqual(rate["denominator"], 2)
        self.assertEqual(rate["numerator"], 1)

    def test_escape_endpoint_uses_tri_state_session_aggregation_and_audits_exclusions(self):
        with tempfile.TemporaryDirectory() as directory:
            attempts = [
                {"session_id": "true", "policy_outcome": "CHALLENGE", "protected_action_reached": True},
                {"session_id": "false", "policy_outcome": "CHALLENGE", "protected_action_reached": False},
                {"session_id": "mixed", "policy_outcome": "CHALLENGE", "protected_action_reached": False},
                {"session_id": "mixed", "policy_outcome": "CHALLENGE"},
                {"session_id": "true-wins", "policy_outcome": "CHALLENGE", "protected_action_reached": True},
                {"session_id": "true-wins", "policy_outcome": "CHALLENGE", "protected_action_reached": None},
                {"session_id": "policy-unknown", "policy_outcome": "UNKNOWN", "protected_action_reached": False},
                {"session_id": "reach-unknown", "policy_outcome": "CHALLENGE", "protected_action_reached": None},
                {"session_id": "reach-absent", "policy_outcome": "CHALLENGE"},
                {"session_id": "oracle", "policy_outcome": "CHALLENGE", "protected_action_reached": False},
                {"session_id": "oracle", "oracle_access": True, "policy_outcome": "CHALLENGE", "protected_action_reached": True},
            ]
            path = self.write_json(directory, "automation.json", {"schema_version": 1, "session_id": "run", "attempts": attempts})
            endpoint = build_report({"selenium": path})["endpoints"]["automation_escape_to_protected_action"]

        self.assertEqual((endpoint["numerator"], endpoint["denominator"]), (2, 4))
        self.assertEqual(endpoint["reach_observations_by_attempt"], {"true": 2, "false": 4, "unknown": 4})
        self.assertEqual(endpoint["reach_states_by_session"], {"true": 2, "false": 2, "unknown": 3})
        self.assertEqual(endpoint["paired_reach_states_by_session"], {"true": 2, "false": 2, "unknown": 3})
        self.assertEqual(endpoint["unknown_policy_sessions"], 1)
        self.assertEqual(endpoint["excluded_sessions"], {
            "oracle": 1,
            "unknown_policy_only": 1,
            "unknown_reach_only": 2,
            "unknown_policy_and_reach": 0,
            "known_policy_and_reach_without_same_attempt_pair": 0,
        })

    def test_escape_rate_requires_policy_and_reach_on_the_same_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            split_evidence = self.write_json(directory, "split.json", {
                "schema_version": 1,
                "session_id": "run",
                "evidence_class": "SIMULATED",
                "attempts": [
                    {"session_id": "split", "policy_outcome": "UNKNOWN", "protected_action_reached": True},
                    {"session_id": "split", "policy_outcome": "CHALLENGE"},
                    {"session_id": "unknown-only", "policy_outcome": "UNKNOWN"},
                ],
            })
            endpoint = build_report({"selenium": split_evidence})["endpoints"]["automation_escape_to_protected_action"]

        self.assertEqual(endpoint["status"], "UNAVAILABLE")
        self.assertIsNone(endpoint["numerator"])
        self.assertIsNone(endpoint["denominator"])
        self.assertEqual(endpoint["excluded_sessions"]["known_policy_and_reach_without_same_attempt_pair"], 1)
        self.assertEqual(endpoint["reach_states_by_session"]["unknown"], 1)

    def test_unpaired_positive_does_not_override_a_known_paired_negative(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "paired.json", {
                "schema_version": 1,
                "session_id": "run",
                "attempts": [
                    {"session_id": "s1", "policy_outcome": "CHALLENGE", "protected_action_reached": False},
                    {"session_id": "s1", "policy_outcome": "UNKNOWN", "protected_action_reached": True},
                ],
            })
            endpoint = build_report({"selenium": path})["endpoints"]["automation_escape_to_protected_action"]
        self.assertEqual((endpoint["numerator"], endpoint["denominator"]), (0, 1))
        self.assertEqual(endpoint["paired_reach_states_by_session"], {"true": 0, "false": 1, "unknown": 0})

    def test_escape_endpoint_rejects_malformed_reach_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "automation.json", {
                "schema_version": 1,
                "session_id": "run",
                "attempts": [{"session_id": "s1", "policy_outcome": "CHALLENGE", "protected_action_reached": "false"}],
            })
            with self.assertRaisesRegex(ValueError, "protected_action_reached"):
                build_report({"selenium": path})

    def test_jsonl_adapter_revalidates_oracle_and_cross_field_types(self):
        fixture = Path(__file__).parent / "fixtures/trial-record-benchmark-v1/trial-record-export.jsonl"
        header, *encoded_rows = fixture.read_text(encoding="utf-8").splitlines()
        export = json.loads(header)
        rows = [json.loads(line) for line in encoded_rows]
        automated = next(row for row in rows if row["actor"] == "AUTOMATION_CONTROL" and not row["oracle_access"])
        automated["oracle_access"] = "true"
        canonical_rows = "\n".join(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False) for row in rows)
        export["artifact_hash"] = hashlib.sha256(canonical_rows.encode()).hexdigest()
        rehash_export_header(export)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tampered.jsonl"
            path.write_text(json.dumps(export, sort_keys=True, separators=(",", ":")) + "\n" + canonical_rows + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "actor/evidence/oracle"):
                build_report({"playwright": path})

    def test_jsonl_adapter_rejects_duplicate_attempt_ids_across_sessions(self):
        fixture = Path(__file__).parent / "fixtures/trial-record-benchmark-v1/trial-record-export.jsonl"
        header, *encoded_rows = fixture.read_text(encoding="utf-8").splitlines()
        export = json.loads(header)
        rows = [json.loads(line) for line in encoded_rows]
        duplicate = json.loads(json.dumps(rows[0]))
        duplicate["session_id"] = "session-" + "f" * 64
        rows.append(duplicate)
        canonical_rows = "\n".join(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False) for row in rows)
        export["artifact_hash"] = hashlib.sha256(canonical_rows.encode()).hexdigest()
        export["qc_report"]["accepted_count"] = len(rows)
        export["qc_report"]["total_count"] = len(rows)
        rehash_export_header(export)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicate-trial.jsonl"
            path.write_text(json.dumps(export, sort_keys=True, separators=(",", ":")) + "\n" + canonical_rows + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicates trial_id"):
                build_report({"playwright": path})

    def test_jsonl_adapter_rejects_canonical_manifest_header_tampering(self):
        fixture = Path(__file__).parent / "fixtures/trial-record-benchmark-v1/trial-record-export.jsonl"
        header, *rows = fixture.read_text(encoding="utf-8").splitlines()
        export = json.loads(header)
        export["trial_manifest"]["manifest_id"] = "unrelated-manifest"
        export["trial_manifest"]["sha256"] = "f" * 64
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tampered-header.jsonl"
            path.write_text(json.dumps(export, sort_keys=True, separators=(",", ":")) + "\n" + "\n".join(rows) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "envelope_hash mismatch"):
                build_report({"playwright": path})

    def test_trial_record_jsonl_qc_to_report_is_deterministic_and_simulated(self):
        repo = Path(__file__).parent
        fixture = repo / "fixtures/trial-record-benchmark-v1"
        records = json.loads((fixture / "records.json").read_text(encoding="utf-8"))
        manifest = json.loads((fixture / "manifest.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            fixture_dir = Path(directory) / "fixtures" / "trial-record-benchmark-v1"
            fixture_dir.mkdir(parents=True)
            records_path = self.write_json(fixture_dir, "records.json", records)
            manifest_path = self.write_json(fixture_dir, "manifest.json", manifest)
            export_path = fixture_dir / "trial-record-export.jsonl"
            env = dict(os.environ, TRIAL_RECORD_PSEUDONYM_KEY="simulated-fixture-pseudonym-key-32-bytes")
            subprocess.run([
                "node", str(repo / "scripts/trial-record.mjs"), "--input", str(records_path),
                "--manifest", str(manifest_path), "--trial-manifest", str(fixture / "trial-manifest.json"), "--output", str(export_path),
            ], check=True, cwd=repo, env=env, capture_output=True, text=True)
            report = build_report({"playwright": export_path})
            self.assertEqual(report, build_report({"playwright": export_path}))
            self.assertEqual(export_path.read_bytes(), (fixture / "trial-record-export.jsonl").read_bytes())
            relocated = Path(directory) / "relocated-export.jsonl"
            relocated.write_bytes(export_path.read_bytes())
            relocated_report = build_report({"playwright": relocated})
            self.assertEqual(relocated_report["evidence_class"], "SIMULATED")

        endpoint = report["endpoints"]["automation_escape_to_protected_action"]
        self.assertEqual(report["evidence_class"], "SIMULATED")
        self.assertEqual((endpoint["numerator"], endpoint["denominator"]), (1, 3))
        self.assertEqual(endpoint["reach_states_by_session"], {"true": 1, "false": 2, "unknown": 3})
        self.assertEqual(endpoint["unknown_policy_sessions"], 1)
        self.assertEqual(endpoint["excluded_sessions"], {
            "oracle": 1,
            "unknown_policy_only": 1,
            "unknown_reach_only": 2,
            "unknown_policy_and_reach": 0,
            "known_policy_and_reach_without_same_attempt_pair": 0,
        })
        self.assertEqual(report["groups"]["playwright"]["sample"]["attempts"], 10)
        self.assertEqual(report["groups"]["playwright"]["trial_record_export"]["qc_report"]["accepted_count"], 11)
        self.assertEqual(report["groups"]["playwright"]["trial_record_export"]["trial_manifest"]["manifest_id"], "manifest-fixture-benchmark-v1")
        self.assertEqual(report, json.loads((fixture / "benchmark-report.json").read_text(encoding="utf-8")))

    def test_invalid_schema_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_json(directory, "run.json", {"schema_version": 2, "attempts": []})
            with self.assertRaisesRegex(ValueError, "schema_version 1"):
                build_report({"playwright": path})


if __name__ == "__main__":
    unittest.main()
