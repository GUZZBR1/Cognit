"""Build a reproducible, descriptive report from identified Cognit run exports."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
from datetime import datetime
from collections import defaultdict
from pathlib import Path
from statistics import mean, median
from typing import Any


GROUPS = ("human", "playwright", "selenium", "puppeteer")
BOOTSTRAP_REPLICATES = 2000
BOOTSTRAP_SEED = 1601
RUNNERS = {
    "human": "Cognit HumanDataset pilot; independent operator confirmation required",
    "playwright": "scripts/run-playwright.mjs",
    "selenium": "attack-lab/selenium.js",
    "puppeteer": "attack-lab/puppeteer.js",
}
CHALLENGE_SET_SHA256 = "bb4ca50830eed3ece2684eed4393d5b48c569106b017f056260ae86209a74a87"


def _read_dataset(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    if path.suffix == ".jsonl":
        return _read_trial_record_export(path, raw)
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise ValueError(f"{path}: expected an object with schema_version 1")
    if "evidence_class" not in document and {"fixture", "fixtures"}.intersection(path.parts):
        document = {**document, "evidence_class": "SIMULATED"}
    return document, hashlib.sha256(raw).hexdigest()


def _read_trial_record_export(path: Path, raw: bytes) -> tuple[dict[str, Any], str]:
    """Read the validated TrialRecord v1 JSONL export without filling gaps."""
    try:
        encoded_lines = raw.split(b"\n")
        if encoded_lines[-1] == b"":
            encoded_lines.pop()
        if not encoded_lines:
            raise ValueError("missing export header")
        header_line = encoded_lines[0].removesuffix(b"\r")
        row_lines = [line.removesuffix(b"\r") for line in encoded_lines[1:]]
        if any(not line for line in row_lines):
            raise ValueError("blank TrialRecord row")
        export = json.loads(header_line.decode("utf-8"))
        rows = [json.loads(line.decode("utf-8")) for line in row_lines]
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError(f"{path}: invalid TrialRecord v1 JSONL export: {error}") from error
    if (not isinstance(export, dict) or export.get("type") != "trial-record-export"
            or export.get("contract_version") != "trial-record-v1"):
        raise ValueError(f"{path}: expected a TrialRecord v1 export header")
    if set(export) != {"type", "contract_version", "source_evidence_class", "trial_manifest", "artifact_hash", "qc_report", "envelope_hash"}:
        raise ValueError(f"{path}: TrialRecord export header has missing or unsupported fields")
    if not isinstance(export.get("envelope_hash"), str) or not re.fullmatch(r"[a-f0-9]{64}", export["envelope_hash"]):
        raise ValueError(f"{path}: invalid TrialRecord export envelope_hash")
    header_payload = {key: value for key, value in export.items() if key != "envelope_hash"}
    canonical_header = json.dumps(header_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if hashlib.sha256(canonical_header.encode("utf-8")).hexdigest() != export["envelope_hash"]:
        raise ValueError(f"{path}: TrialRecord export envelope_hash mismatch")
    source_evidence = export.get("source_evidence_class")
    if source_evidence is not None and not (isinstance(source_evidence, str) and source_evidence in {"SIMULATED", "OBSERVED", "REPLAYED"}):
        raise ValueError(f"{path}: invalid source_evidence_class")
    trial_manifest = export.get("trial_manifest")
    if trial_manifest is None:
        raise ValueError(f"{path}: TrialRecord benchmark export must reference a validated canonical Trial Manifest")
    if trial_manifest is not None and (
            not isinstance(trial_manifest, dict)
            or set(trial_manifest) != {"manifest_id", "version", "sha256", "evidence_class"}
            or not isinstance(trial_manifest.get("manifest_id"), str) or not trial_manifest["manifest_id"]
            or not isinstance(trial_manifest.get("version"), str) or trial_manifest["version"] != "1.0.0"
            or not isinstance(trial_manifest.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", trial_manifest["sha256"])
            or trial_manifest.get("evidence_class") not in {"SIMULATED", "OBSERVED", "REPLAYED"}):
        raise ValueError(f"{path}: invalid canonical Trial Manifest reference")
    if trial_manifest is not None and source_evidence != trial_manifest["evidence_class"]:
        raise ValueError(f"{path}: source evidence class differs from the canonical Trial Manifest")
    qc = export.get("qc_report")
    if (not isinstance(qc, dict) or qc.get("valid") is not True
            or qc.get("rejected_count") != 0
            or qc.get("accepted_count") != len(rows)
            or qc.get("total_count") != len(rows)
            or qc.get("rejected_records") != []):
        raise ValueError(f"{path}: TrialRecord export must have a complete, valid QC report")
    # The exporter hashes its exact canonical JSON row bytes. Hash the row
    # lines as written instead of re-serializing parsed numbers: JavaScript and
    # Python can spell the same JSON number differently (for example 1e-7).
    row_artifact = b"\n".join(row_lines)
    if hashlib.sha256(row_artifact).hexdigest() != export.get("artifact_hash"):
        raise ValueError(f"{path}: TrialRecord export artifact_hash mismatch")

    attempts = []
    trial_ids = set()
    for index, row in enumerate(rows):
        _validate_exported_trial_record(path, index, row)
        if row["trial_id"] in trial_ids:
            raise ValueError(f"{path}: TrialRecord row {index} duplicates trial_id")
        trial_ids.add(row["trial_id"])
        outcome = row.get("outcome")
        observations = outcome.get("observations") if isinstance(outcome, dict) else None
        observations = observations if isinstance(observations, dict) else {}
        policy = observations.get("policy")
        if "policy" in observations and not (isinstance(policy, str) and policy in {"allow", "block", "challenge", "unknown"}):
            raise ValueError(f"{path}: TrialRecord row {index} has an invalid policy observation")
        policy_outcome = policy.upper() if isinstance(policy, str) else "UNKNOWN"
        actor = row.get("actor")
        actor_class = {
            "AUTOMATION_CONTROL": "AUTOMATION_CONTROLLED",
            "AI_AGENT": "AI_AGENT",
        }.get(actor, actor)
        attempt = {
            "session_id": row.get("session_id"),
            "attempt_id": row.get("trial_id"),
            "actor_class": actor_class,
            "oracle_access": row.get("oracle_access"),
            "evidence_class": row.get("evidence_class"),
            "observed_result": {"policy_outcome": policy_outcome},
        }
        if "protected_action_reached" in observations:
            reached = observations["protected_action_reached"]
            if reached is not None and not isinstance(reached, bool):
                raise ValueError(f"{path}: TrialRecord row {index} has invalid protected_action_reached")
            if isinstance(reached, bool):
                provenance = observations.get("protected_action_reached_provenance")
                if (not isinstance(provenance, dict) or provenance.get("trial_id") != row.get("trial_id")
                        or any(not isinstance(provenance.get(key), str) or not provenance[key].strip() for key in ("source", "method", "origin", "observed_at"))):
                    raise ValueError(f"{path}: TrialRecord row {index} has invalid protected-action provenance")
            attempt["protected_action_reached"] = reached
        if "protected_action_reached_provenance" in observations:
            attempt["protected_action_reached_provenance"] = observations["protected_action_reached_provenance"]
        attempts.append(attempt)
    document = {
        "schema_version": 1,
        "evidence_class": "SIMULATED" if source_evidence == "SIMULATED" or {"fixture", "fixtures"}.intersection(path.parts) else "UNVERIFIED_INPUTS",
        "trial_record_export": {
            "contract_version": export["contract_version"],
            "artifact_hash": export["artifact_hash"],
            "qc_report": qc,
            **({"trial_manifest": trial_manifest} if trial_manifest is not None else {}),
        },
        "attempts": attempts,
    }
    return document, hashlib.sha256(raw).hexdigest()


def _validate_exported_trial_record(path: Path, index: int, row: Any) -> None:
    prefix = f"{path}: TrialRecord row {index}"
    required = {"contract_version", "trial_id", "session_id", "actor", "label", "provenance", "manifest_ref", "challenge_ref", "outcome", "started_at", "ended_at", "evidence_class", "oracle_access"}
    allowed = required | {"participant_id"}
    if not isinstance(row, dict) or not required.issubset(row) or set(row) - allowed or row.get("contract_version") != "trial-record-v1":
        raise ValueError(f"{prefix} is incomplete or has an unsupported contract/field")
    opaque = re.compile(r"^(trial|session|participant|manifest|challenge|seed)-[a-f0-9]{16,64}$")
    for key, kind in (("trial_id", "trial"), ("session_id", "session")):
        if not isinstance(row.get(key), str) or not opaque.fullmatch(row[key]) or not row[key].startswith(f"{kind}-"):
            raise ValueError(f"{prefix} has an invalid {key}")
    if "participant_id" in row and (not isinstance(row["participant_id"], str) or not opaque.fullmatch(row["participant_id"]) or not row["participant_id"].startswith("participant-")):
        raise ValueError(f"{prefix} has an invalid participant_id")
    actor = row.get("actor")
    if not isinstance(actor, str) or actor not in {"HUMAN_CONFIRMED", "AUTOMATION_CONTROL", "AI_AGENT", "UNKNOWN"}:
        raise ValueError(f"{prefix} has an invalid actor")
    label = row.get("label")
    if label is not None and (not isinstance(label, str) or label not in {"human", "automation", "ai_agent"}):
        raise ValueError(f"{prefix} has an invalid label")
    provenance = row.get("provenance")
    provenance_sources = {"independent-human-review", "independent-agent-review", "controlled-automation", "accessibility-review", "oracle-control", "unknown"}
    if (not isinstance(provenance, dict) or set(provenance) != {"source", "independent", "valid"}
            or not isinstance(provenance.get("source"), str) or provenance.get("source") not in provenance_sources
            or not isinstance(provenance.get("independent"), bool)
            or not isinstance(provenance.get("valid"), bool)):
        raise ValueError(f"{prefix} has invalid actor provenance")
    expected_label = {"HUMAN_CONFIRMED": "human", "AUTOMATION_CONTROL": "automation", "AI_AGENT": "ai_agent"}.get(actor)
    if actor == "UNKNOWN" and label is not None or expected_label and label not in {None, expected_label}:
        raise ValueError(f"{prefix} has an actor/label mismatch")
    if label is not None and (not provenance["independent"] or not provenance["valid"] or provenance["source"] in {"unknown", "oracle-control"}):
        raise ValueError(f"{prefix} has a label without independent valid provenance")
    if label is not None and provenance["source"] != {"human": "independent-human-review", "automation": "controlled-automation", "ai_agent": "independent-agent-review"}.get(label) and not (label == "human" and provenance["source"] == "accessibility-review"):
        raise ValueError(f"{prefix} has actor-incompatible label provenance")
    evidence = row.get("evidence_class")
    valid_evidence = {"human_report", "automation", "agent", "unknown", "accessible", "oracle_assisted"}
    evidence_by_actor = {"HUMAN_CONFIRMED": {"human_report", "accessible"}, "AUTOMATION_CONTROL": {"automation", "oracle_assisted"}, "AI_AGENT": {"agent", "oracle_assisted"}, "UNKNOWN": {"unknown"}}
    oracle = row.get("oracle_access")
    if (not isinstance(evidence, str) or evidence not in valid_evidence or not isinstance(oracle, bool)
            or (evidence == "oracle_assisted") != oracle
            or evidence not in evidence_by_actor[actor]
            or oracle and (actor not in {"AUTOMATION_CONTROL", "AI_AGENT"} or label is not None)):
        raise ValueError(f"{prefix} has invalid actor/evidence/oracle metadata")
    manifest_ref = row.get("manifest_ref")
    challenge_ref = row.get("challenge_ref")
    if (not isinstance(manifest_ref, dict) or set(manifest_ref) != {"manifest_id", "sha256", "version"}
            or not isinstance(manifest_ref.get("manifest_id"), str) or not opaque.fullmatch(manifest_ref["manifest_id"])
            or not isinstance(manifest_ref.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", manifest_ref["sha256"])
            or not isinstance(manifest_ref.get("version"), str) or not re.fullmatch(r"\d+\.\d+\.\d+", manifest_ref["version"])):
        raise ValueError(f"{prefix} has invalid manifest_ref")
    if (not isinstance(challenge_ref, dict) or set(challenge_ref) != {"challenge_id", "seed_ref", "config_hash"}
            or not isinstance(challenge_ref.get("challenge_id"), str) or not opaque.fullmatch(challenge_ref["challenge_id"])
            or not isinstance(challenge_ref.get("seed_ref"), str) or not opaque.fullmatch(challenge_ref["seed_ref"])
            or not isinstance(challenge_ref.get("config_hash"), str) or not re.fullmatch(r"[a-f0-9]{64}", challenge_ref["config_hash"])):
        raise ValueError(f"{prefix} has invalid challenge_ref")
    start, end = _valid_timestamp(row.get("started_at")), _valid_timestamp(row.get("ended_at"))
    if start is None or end is None or end < start:
        raise ValueError(f"{prefix} has invalid timestamps")
    outcome = row.get("outcome")
    if (not isinstance(outcome, dict) or not {"status", "duration_ms"}.issubset(outcome)
            or set(outcome) - {"status", "duration_ms", "observations"}
            or not isinstance(outcome.get("status"), str) or outcome.get("status") not in {"completed", "failed", "abandoned", "unknown"}):
        raise ValueError(f"{prefix} has invalid outcome")
    duration = outcome.get("duration_ms")
    if duration is not None and (isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0):
        raise ValueError(f"{prefix} has invalid duration_ms")
    if duration is not None and abs(duration - (end - start).total_seconds() * 1000) > 1:
        raise ValueError(f"{prefix} has inconsistent duration_ms")
    observations = outcome.get("observations")
    if "observations" in outcome and not isinstance(observations, dict):
        raise ValueError(f"{prefix} observations must be an object")
    observations = observations or {}
    if set(observations) - {"risk_score", "prediction", "policy", "protected_action_reached", "protected_action_reached_provenance"}:
        raise ValueError(f"{prefix} has an unknown observation")
    risk = observations.get("risk_score")
    if "risk_score" in observations and (isinstance(risk, bool) or not isinstance(risk, (int, float)) or not math.isfinite(risk) or not 0 <= risk <= 1):
        raise ValueError(f"{prefix} has an invalid risk_score")
    if "prediction" in observations and (not isinstance(observations["prediction"], str) or observations["prediction"] not in {"human", "automation", "ai_agent", "unknown"}):
        raise ValueError(f"{prefix} has an invalid prediction")
    if "policy" in observations and (not isinstance(observations["policy"], str) or observations["policy"] not in {"allow", "block", "challenge", "unknown"}):
        raise ValueError(f"{prefix} has an invalid policy")
    if "protected_action_reached" in observations:
        reached = observations["protected_action_reached"]
        if reached is not None and not isinstance(reached, bool):
            raise ValueError(f"{prefix} has invalid protected_action_reached")
        action_provenance = observations.get("protected_action_reached_provenance")
        if isinstance(reached, bool) and (not isinstance(action_provenance, dict)
                or set(action_provenance) != {"trial_id", "source", "method", "origin", "observed_at"}
                or action_provenance.get("trial_id") != row["trial_id"]
                or any(not isinstance(action_provenance.get(key), str) or not action_provenance[key].strip() for key in ("source", "method", "origin"))
                or _valid_timestamp(action_provenance.get("observed_at")) is None):
            raise ValueError(f"{prefix} has invalid protected-action provenance")
    elif "protected_action_reached_provenance" in observations:
        action_provenance = observations["protected_action_reached_provenance"]
        if (not isinstance(action_provenance, dict)
                or set(action_provenance) != {"trial_id", "source", "method", "origin", "observed_at"}
                or action_provenance.get("trial_id") != row["trial_id"]
                or any(not isinstance(action_provenance.get(key), str) or not action_provenance[key].strip() for key in ("source", "method", "origin"))
                or _valid_timestamp(action_provenance.get("observed_at")) is None):
            raise ValueError(f"{prefix} has invalid protected-action provenance")


def _confirmed_human(record: Any) -> bool:
    if (not isinstance(record, dict) or record.get("HUMAN_CONFIRMED") is not True
            or not isinstance(record.get("pseudonym"), str) or not record["pseudonym"]):
        return False
    confirmation = record.get("human_confirmation")
    return isinstance(confirmation, dict) and all(
        isinstance(confirmation.get(key), str) and confirmation[key].strip()
        for key in ("method", "origin", "procedure")
    )


def _has_prediction_provenance(record: dict[str, Any]) -> bool:
    provenance = record.get("prediction_provenance")
    return isinstance(provenance, dict) and all(
        isinstance(provenance.get(key), str) and provenance[key].strip()
        for key in ("method", "origin", "version")
    )


def _records(group: str, document: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(document.get("trial_records"), list):
        records = document["trial_records"]
        required = {
            "record_version", "record_id", "manifest_id", "framework", "tool_version", "browser",
            "browser_version", "cognit_commit", "protocol_version", "config", "config_sha256", "seed",
            "session_id", "attempt_id", "challenge_id", "evidence_class", "actor_class", "oracle_access",
            "oracle_source", "observed_result", "perception_metric_eligible", "target_source", "target_origin",
        }
        for index, record in enumerate(records):
            if not isinstance(record, dict) or not required.issubset(record):
                raise ValueError(f"trial_records[{index}]: incomplete TrialRecord v1")
            if set(record) - required - {"human_ground_truth"}:
                raise ValueError(f"trial_records[{index}]: unknown TrialRecord v1 fields")
            if (record.get("record_version") != "1.0.0" or record.get("framework") != group
                    or record.get("evidence_class") != "SIMULATED"
                    or record.get("actor_class") != "AUTOMATION_CONTROLLED"
                    or record.get("oracle_access") is not True
                    or record.get("perception_metric_eligible") is not False
                    or record.get("target_source") != "cognit-fixed-demo"):
                raise ValueError(f"trial_records[{index}]: unsupported TrialRecord v1 provenance")
            if not re.fullmatch(r"[a-f0-9]{64}", str(record.get("config_sha256", ""))):
                raise ValueError(f"trial_records[{index}]: config_sha256 must be lowercase SHA-256")
            canonical_config = json.dumps(record["config"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            if not isinstance(record["config"], dict) or hashlib.sha256(canonical_config).hexdigest() != record["config_sha256"]:
                raise ValueError(f"trial_records[{index}]: config_sha256 does not match config")
            non_empty_strings = ("record_id", "manifest_id", "tool_version", "browser", "browser_version", "protocol_version", "session_id", "attempt_id", "challenge_id", "oracle_source")
            if any(not isinstance(record.get(key), str) or not record[key].strip() for key in non_empty_strings):
                raise ValueError(f"trial_records[{index}]: required identifiers and provenance must be non-empty strings")
            if isinstance(record.get("seed"), bool) or not isinstance(record.get("seed"), (str, int)):
                raise ValueError(f"trial_records[{index}]: seed must be a string or integer")
            if not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", str(record.get("cognit_commit", ""))):
                raise ValueError(f"trial_records[{index}]: invalid cognit_commit")
            if not re.match(r"^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:/.*)?$", str(record.get("target_origin", ""))):
                raise ValueError(f"trial_records[{index}]: target_origin must be a localhost URL")
        return records
    if group == "human":
        records = document.get("records")
        if not isinstance(records, list):
            raise ValueError("human export must contain a records array")
        return [record for record in records if _confirmed_human(record) or (
            isinstance(record, dict)
            and isinstance(record.get("ground_truth"), dict)
            and record["ground_truth"].get("label") == "HUMAN"
            and record["ground_truth"].get("provenance") == "independent_human_confirmation"
        )]

    attempts = document.get("attempts")
    if not isinstance(attempts, list):
        raise ValueError(f"{group} run must contain an attempts array")
    session_id = document.get("session_id")
    if isinstance(document.get("trial_record_export"), dict):
        return [record for record in attempts if isinstance(record, dict)]
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError(f"{group} run must identify its session_id")
    return [record for record in attempts if isinstance(record, dict)]


def _cluster_id(group: str, document: dict[str, Any], record: dict[str, Any]) -> str | None:
    if group == "human":
        value = record.get("participant_id", record.get("pseudonym"))
    else:
        value = record.get("session_id", document.get("session_id"))
    return value if isinstance(value, str) and value else None


def _oracle_assisted(record: dict[str, Any]) -> bool:
    ground_truth = record.get("ground_truth")
    disclosed_authored_answer = (
        isinstance(ground_truth, dict)
        and ground_truth.get("type") == "authored_answer"
        and any(
            key in ground_truth
            and ground_truth[key] is not None
            and not (isinstance(ground_truth[key], str) and not ground_truth[key].strip())
            for key in ("authored_answer", "expected_answer")
        )
    )
    return (
        record.get("oracle_access") is True
        or record.get("perception_metric_eligible") is False
        or disclosed_authored_answer
    )


def _outcome(record: dict[str, Any]) -> str:
    result = record.get("observed_result")
    raw = result.get("policy_outcome") if isinstance(result, dict) else None
    raw = raw or record.get("policy_outcome")
    value = raw if isinstance(raw, str) else "UNKNOWN"
    return value.upper() if value.upper() in {"ALLOW", "PASS", "CHALLENGE", "RESTRICT", "BLOCK", "UNKNOWN"} else "UNKNOWN"


def _protected_action_observation(record: dict[str, Any]) -> bool | None:
    result = record.get("observed_result")
    result = result if isinstance(result, dict) else {}
    if "protected_action_reached" in record:
        value = record["protected_action_reached"]
    elif "protected_action_reached" in result:
        value = result["protected_action_reached"]
    else:
        return None
    if value is not None and not isinstance(value, bool):
        raise ValueError("protected_action_reached must be true, false, null, or absent")
    return value


def _valid_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None


def _beta_continued_fraction(a: float, b: float, x: float) -> float:
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    if abs(d) < 1e-300:
        d = 1e-300
    d = 1.0 / d
    h = d
    for m in range(1, 201):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-300: d = 1e-300
        c = 1.0 + aa / c
        if abs(c) < 1e-300: c = 1e-300
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-300: d = 1e-300
        c = 1.0 + aa / c
        if abs(c) < 1e-300: c = 1e-300
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 3e-14:
            break
    return h


def _regularized_beta(x: float, a: float, b: float) -> float:
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    factor = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1) / (a + b + 2):
        return factor * _beta_continued_fraction(a, b, x) / a
    return 1 - factor * _beta_continued_fraction(b, a, 1 - x) / b


def _beta_quantile(probability: float, a: int, b: int) -> float:
    low, high = 0.0, 1.0
    for _ in range(80):
        middle = (low + high) / 2
        if _regularized_beta(middle, a, b) < probability:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def _exact_binomial_interval(events: int, total: int) -> dict[str, Any]:
    alpha = 0.05
    lower = 0.0 if events == 0 else _beta_quantile(alpha / 2, events, total - events + 1)
    upper = 1.0 if events == total else _beta_quantile(1 - alpha / 2, events + 1, total - events)
    return {"confidence_level": 0.95, "lower": lower, "upper": upper,
            "method": "two-sided Clopper-Pearson exact binomial interval"}


def _primary_endpoints(datasets: dict[str, Path | None]) -> dict[str, Any]:
    human_rows: list[dict[str, Any]] = []
    automated_rows: list[dict[str, Any]] = []
    challenge_rows: list[dict[str, Any]] = []
    outcomes: list[str] = []
    oracle_automation_sessions: set[tuple[str, str]] = set()
    for group, path in datasets.items():
        if path is None:
            continue
        document, _ = _read_dataset(path)
        for row in _records(group, document):
            actor = row.get("actor_class", row.get("actor", {}).get("type") if isinstance(row.get("actor"), dict) else None)
            session_id = row.get("session_id", document.get("session_id"))
            known_automation_actor = actor in {"AUTOMATION_CONTROL", "AUTOMATION_CONTROLLED", "SCRIPTED_AUTOMATION", "AI_AGENT"}
            is_automation = known_automation_actor if isinstance(document.get("trial_record_export"), dict) else known_automation_actor or group != "human"
            if is_automation and isinstance(session_id, str) and session_id and _oracle_assisted(row):
                oracle_automation_sessions.add((group, session_id))
            if _oracle_assisted(row):
                continue
            result = row.get("observed_result") if isinstance(row.get("observed_result"), dict) else {}
            challenge_id = row.get("challenge_id", result.get("challenge_id"))
            applied = row.get("challenge_applied") is True or bool(challenge_id)
            outcome = _outcome(row)
            outcomes.append(outcome)
            if applied:
                challenge_rows.append({"outcome": outcome, "correct": result.get("correct", row.get("correct")), "completed": result.get("completed", row.get("challenge_completed"))})
            if group == "human":
                confirmed = _confirmed_human(row) or (
                    isinstance(row.get("ground_truth"), dict)
                    and row["ground_truth"].get("label") == "HUMAN"
                    and row["ground_truth"].get("provenance") == "independent_human_confirmation"
                )
                timestamp = _valid_timestamp(row.get("session_started_at"))
                participant = row.get("participant_id")
                session = row.get("session_id")
                if confirmed and timestamp and isinstance(participant, str) and participant and isinstance(session, str) and session:
                    human_rows.append({"participant_id": participant, "session_id": session, "started": timestamp, "outcome": outcome, "restricted": outcome in {"RESTRICT", "BLOCK"}})
            elif known_automation_actor or (group != "human" and not isinstance(document.get("trial_record_export"), dict)):
                if isinstance(session_id, str) and session_id:
                    automated_rows.append({"group": group, "session_id": session_id, "outcome": outcome, "reached": _protected_action_observation(row)})

    primary: dict[str, dict[str, Any]] = {}
    sessions: dict[tuple[str, str], dict[str, Any]] = {}
    for row in human_rows:
        key = (row["participant_id"], row["session_id"])
        session = sessions.setdefault(key, {"participant_id": row["participant_id"], "session_id": row["session_id"], "started": row["started"], "outcomes": [], "restricted": False})
        session["started"] = min(session["started"], row["started"])
        session["outcomes"].append(row["outcome"])
        session["restricted"] = session["restricted"] or row["restricted"]
    for session in sessions.values():
        session["outcome"] = next((outcome for outcome in reversed(session["outcomes"]) if outcome != "UNKNOWN"), "UNKNOWN")
    for row in sorted(sessions.values(), key=lambda item: (item["participant_id"], item["started"], item["session_id"])):
        primary.setdefault(row["participant_id"], row)
    eligible_human = [row for row in primary.values() if row["outcome"] != "UNKNOWN"]
    false_positives = sum(row["restricted"] for row in eligible_human)
    automation_sessions: dict[tuple[str, str], dict[str, Any]] = {}
    for row in automated_rows:
        key = (row["group"], row["session_id"])
        session = automation_sessions.setdefault(key, {"outcomes": [], "reach_observations": [], "paired_observations": []})
        session["outcomes"].append(row["outcome"])
        session["reach_observations"].append(row["reached"])
        if row["outcome"] != "UNKNOWN" and row["reached"] is not None:
            session["paired_observations"].append((row["outcome"], row["reached"]))
    automation_sessions = {
        key: session for key, session in automation_sessions.items()
        if key not in oracle_automation_sessions
    }
    for session in automation_sessions.values():
        observations = session["reach_observations"]
        session["reached"] = True if any(value is True for value in observations) else False if observations and all(value is False for value in observations) else None
        session["policy_known"] = any(outcome != "UNKNOWN" for outcome in session["outcomes"])
        paired_reach = [reached for _, reached in session["paired_observations"]]
        session["paired_reached"] = True if any(value is True for value in paired_reach) else False if paired_reach and all(value is False for value in paired_reach) else None
    escape_eligible = [session for session in automation_sessions.values() if session["paired_reached"] is not None]
    escaped = sum(session["paired_reached"] is True for session in escape_eligible)
    unknown_policy_sessions = [session for session in automation_sessions.values() if not session["policy_known"]]
    unknown_reach_sessions = [session for session in automation_sessions.values() if session["reached"] is None]
    excluded_sessions = [session for session in automation_sessions.values() if session["paired_reached"] is None]
    policy_only_exclusions = sum(not session["policy_known"] and session["reached"] is not None for session in excluded_sessions)
    reach_only_exclusions = sum(session["policy_known"] and session["reached"] is None for session in excluded_sessions)
    both_unknown_exclusions = sum(not session["policy_known"] and session["reached"] is None for session in excluded_sessions)
    unpaired_policy_reach_exclusions = sum(session["policy_known"] and session["reached"] is not None for session in excluded_sessions)
    attempt_reach_counts = {
        "true": sum(row["reached"] is True for row in automated_rows),
        "false": sum(row["reached"] is False for row in automated_rows),
        "unknown": sum(row["reached"] is None for row in automated_rows),
    }
    session_reach_counts = {
        "true": sum(session["reached"] is True for session in automation_sessions.values()),
        "false": sum(session["reached"] is False for session in automation_sessions.values()),
        "unknown": len(unknown_reach_sessions),
    }
    paired_session_reach_counts = {
        "true": sum(session["paired_reached"] is True for session in automation_sessions.values()),
        "false": sum(session["paired_reached"] is False for session in automation_sessions.values()),
        "unknown": sum(session["paired_reached"] is None for session in automation_sessions.values()),
    }
    completed_challenges = [row for row in challenge_rows if row["completed"] is True]
    known_challenges = [row for row in completed_challenges if isinstance(row["correct"], bool)]

    def rate(events: int, total: int) -> dict[str, Any]:
        if total == 0:
            return {"status": "UNAVAILABLE", "numerator": None, "denominator": None, "value": None, "interval_95": None, "reason": "no_eligible_observations"}
        return {"status": "AVAILABLE", "numerator": events, "denominator": total, "value": events / total, "interval_95": _exact_binomial_interval(events, total)}

    outcome_counts = {name: sum(outcome == name for outcome in outcomes) for name in ("CHALLENGE", "RESTRICT", "BLOCK", "UNKNOWN")}
    return {
        "human_false_positive_rate": {**rate(false_positives, len(eligible_human)), "unit": "independent_participant", "participants": len(primary), "sessions_considered": len(sessions), "numerator_definition": "primary session received RESTRICT or BLOCK on any nested attempt", "denominator_definition": "participants with independently confirmed primary session and at least one known outcome"},
        "automation_escape_to_protected_action": {
            **rate(escaped, len(escape_eligible)),
            "unit": "session",
            "numerator_definition": "sessions with a protected action explicitly reached on an attempt whose policy outcome is also known",
            "denominator_definition": "non-oracle automation sessions with at least one same-attempt known policy/reach pair; only paired attempts contribute to the session escape state",
            "pairing_rule": "policy and protected-action reach must both be known on the same attempt; paired attempts alone determine the session reach state",
            "reach_observations_by_attempt": attempt_reach_counts,
            "reach_states_by_session": session_reach_counts,
            "paired_reach_states_by_session": paired_session_reach_counts,
            "unknown_policy_sessions": len(unknown_policy_sessions),
            "excluded_sessions": {
                "oracle": len(oracle_automation_sessions),
                "unknown_policy_only": policy_only_exclusions,
                "unknown_reach_only": reach_only_exclusions,
                "unknown_policy_and_reach": both_unknown_exclusions,
                "known_policy_and_reach_without_same_attempt_pair": unpaired_policy_reach_exclusions,
            },
        },
        "challenge_completed": {**rate(len(completed_challenges), len(challenge_rows)), "unit": "challenge attempt", "numerator_definition": "completed is explicitly true", "denominator_definition": "records with an explicitly applied challenge"},
        "challenge_completed_correctly": {**rate(sum(row["correct"] is True for row in known_challenges), len(known_challenges)), "unit": "challenge attempt", "numerator_definition": "completed challenge with correct result", "denominator_definition": "completed challenges with explicit correctness boolean"},
        "challenge_applied": {"status": "AVAILABLE" if outcomes else "UNAVAILABLE", "numerator": len(challenge_rows) if outcomes else None, "denominator": len(outcomes) if outcomes else None, "unit": "session/attempt", "outcomes": outcome_counts, **({} if outcomes else {"reason": "no_eligible_observations"})},
        "selection_rule": "Per participant, select earliest session_started_at among independently confirmed sessions; ties use lexicographically smallest session_id. Selection is outcome-blind. Retries are nested and excluded from primary participant denominator.",
    }


def _interval(cluster_values: list[float], *, seed: int) -> dict[str, Any]:
    if len(cluster_values) < 2:
        return {"confidence_level": 0.95, "lower": None, "upper": None,
                "unavailable_reason": "requires_at_least_two_clusters"}
    rng = random.Random(seed)
    estimates = sorted(
        mean(rng.choices(cluster_values, k=len(cluster_values)))
        for _ in range(BOOTSTRAP_REPLICATES)
    )
    return {
        "confidence_level": 0.95,
        "lower": estimates[int(0.025 * BOOTSTRAP_REPLICATES)],
        "upper": estimates[int(0.975 * BOOTSTRAP_REPLICATES) - 1],
        "method": "percentile bootstrap resampling cluster summaries",
        "replicates": BOOTSTRAP_REPLICATES,
        "seed": seed,
    }


def _numeric_summary(values_by_cluster: dict[str, list[float]], *, seed: int) -> dict[str, Any]:
    values = [value for cluster in values_by_cluster.values() for value in cluster]
    if not values:
        return {"status": "UNAVAILABLE", "count": 0, "cluster_count": 0, "mean": None, "median": None,
                "unavailable_reason": "no_eligible_observations"}
    cluster_means = [mean(cluster) for cluster in values_by_cluster.values() if cluster]
    return {
        "status": "AVAILABLE",
        "count": len(values),
        "cluster_count": len(cluster_means),
        "mean": mean(cluster_means),
        "median": median(values),
        "aggregation": "unweighted mean of per-cluster means",
        "unit": "ms",
        "uncertainty_95": _interval(cluster_means, seed=seed),
    }


def _rate_summary(values_by_cluster: dict[str, list[bool]], *, seed: int) -> dict[str, Any]:
    values = [value for cluster in values_by_cluster.values() for value in cluster]
    if not values:
        return {"status": "UNAVAILABLE", "numerator": 0, "denominator": 0, "value": None,
                "unavailable_reason": "no_eligible_observations"}
    clusters = [cluster for cluster in values_by_cluster.values() if cluster]
    rng = random.Random(seed)
    # Resample whole clusters and pool their observations so the interval matches
    # the attempt-weighted numerator/denominator reported below.
    bootstrap_rates = []
    for _ in range(BOOTSTRAP_REPLICATES):
        sampled_clusters = rng.choices(clusters, k=len(clusters))
        sampled_values = [value for cluster in sampled_clusters for value in cluster]
        bootstrap_rates.append(sum(sampled_values) / len(sampled_values))
    bootstrap_rates.sort()
    uncertainty = {
        "confidence_level": 0.95,
        "lower": bootstrap_rates[int(0.025 * BOOTSTRAP_REPLICATES)],
        "upper": bootstrap_rates[int(0.975 * BOOTSTRAP_REPLICATES) - 1],
        "method": "percentile cluster bootstrap resampling observed clusters",
        "replicates": BOOTSTRAP_REPLICATES,
        "seed": seed,
    } if len(clusters) >= 2 else {
        "confidence_level": 0.95,
        "lower": None,
        "upper": None,
        "unavailable_reason": "requires_at_least_two_clusters",
    }
    return {
        "status": "AVAILABLE",
        "numerator": sum(values),
        "denominator": len(values),
        "value": sum(values) / len(values),
        "aggregation": "pooled numerator / denominator; bootstrap resamples observed clusters",
        "cluster_count": len(clusters),
        "uncertainty_95": uncertainty,
    }


def _add_numeric(
    target: dict[str, list[float]], cluster: str | None, value: Any, *, allow_negative: bool = False
) -> None:
    if cluster is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return
    try:
        number = float(value)
    except OverflowError:
        return
    if math.isfinite(number) and (allow_negative or number >= 0):
        target[cluster].append(number)


def _metric_seed(group: str, name: str) -> int:
    digest = hashlib.sha256(f"{group}:{name}:{BOOTSTRAP_SEED}".encode()).digest()
    return int.from_bytes(digest[:4], "big")


def _group_report(group: str, source: Path | None) -> dict[str, Any]:
    if source is None:
        return {"status": "UNAVAILABLE", "reason": "no_dataset_supplied", "runner": RUNNERS[group]}
    document, digest = _read_dataset(source)
    records = _records(group, document)
    input_record_count = len(records)
    records = [record for record in records if not _oracle_assisted(record)]
    if not records:
        reason = "no_non_oracle_eligible_records" if input_record_count else ("no_independently_confirmed_human_records" if group == "human" else "no_attempt_records")
        return {
            "status": "UNAVAILABLE", "reason": reason, "runner": RUNNERS[group],
            "dataset": source.name, "sha256": digest,
            "input_record_count": input_record_count,
            **({"trial_record_export": document["trial_record_export"]} if isinstance(document.get("trial_record_export"), dict) else {}),
        }

    ids = [_cluster_id(group, document, row) for row in records]
    cluster_count = len({item for item in ids if item is not None})
    cluster_unit = ("participant_id" if any(row.get("participant_id") for row in records) else "consent_pseudonym") if group == "human" else "session_id"
    versions = {
        key: sorted({row[key] for row in records if isinstance(row.get(key), str) and row[key]})
        for key in ("tool", "tool_version", "browser", "browser_version")
    }
    versions = {key: value or ["not_recorded"] for key, value in versions.items()}
    if group == "playwright":
        versions["tool"] = ["playwright (runner identity)" ]

    metric_values: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    rates: dict[str, dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    signals: dict[str, dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    challenges: dict[str, dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    prediction_provenance: set[tuple[str, str, str]] = set()
    eligible_attempts = 0
    for row, cluster in zip(records, ids):
        result = row if group == "human" else row.get("observed_result", {})
        if not isinstance(result, dict):
            result = {}
        if cluster is not None:
            if isinstance(result.get("correct"), bool):
                rates["accuracy"][cluster].append(result["correct"])
                eligible_attempts += 1
                challenge_id = result.get("challenge_id", row.get("challenge_id"))
                if isinstance(challenge_id, str) and challenge_id:
                    challenges[challenge_id][cluster].append(result["correct"])
            _add_numeric(metric_values["reaction_time_ms"], cluster, result.get("reaction_time_ms"))
            _add_numeric(metric_values["completion_time_ms"], cluster, row.get("completion_time_ms"))
            _add_numeric(metric_values["duration_ms"], cluster, result.get("duration_ms", row.get("duration_ms")))
            telemetry = row.get("mouse_telemetry")
            features = telemetry.get("features") if isinstance(telemetry, dict) and telemetry.get("status") == "complete" else None
            if isinstance(features, dict):
                for name, value in features.items():
                    _add_numeric(metric_values[f"mouse.{name}"], cluster, value, allow_negative=True)
            browser_features = row.get("features")
            browser_signals = browser_features.get("signals") if isinstance(browser_features, dict) else None
            if isinstance(browser_signals, list):
                for signal in browser_signals:
                    if isinstance(signal, dict) and isinstance(signal.get("id"), str) and isinstance(signal.get("observed"), bool):
                        signals[signal["id"]][cluster].append(signal["observed"])
            prediction = row.get("predicted_automation")
            if group == "human" and isinstance(prediction, bool) and _has_prediction_provenance(row):
                rates["human_false_positive_rate"][cluster].append(prediction)
                provenance = row["prediction_provenance"]
                prediction_provenance.add((provenance["method"], provenance["origin"], provenance["version"]))

    metrics: dict[str, Any] = {
        name: _numeric_summary(metric_values[name], seed=_metric_seed(group, name))
        for name in ("reaction_time_ms", "duration_ms", "completion_time_ms")
    }
    mouse_features = {
        name.removeprefix("mouse."): _numeric_summary(by_cluster, seed=_metric_seed(group, name))
        for name, by_cluster in sorted(metric_values.items()) if name.startswith("mouse.")
    }
    metrics["accuracy"] = _rate_summary(rates["accuracy"], seed=_metric_seed(group, "accuracy"))
    if group == "human":
        metrics["legacy_predicted_automation_rate_secondary"] = _rate_summary(
            rates["human_false_positive_rate"], seed=_metric_seed(group, "human_false_positive_rate")
        )
    challenge_report = {
        challenge: _rate_summary(by_cluster, seed=_metric_seed(group, f"challenge:{challenge}"))
        for challenge, by_cluster in sorted(challenges.items())
    }
    signal_report = {
        signal: _rate_summary(by_cluster, seed=_metric_seed(group, f"signal:{signal}"))
        for signal, by_cluster in sorted(signals.items())
    }
    return {
        "status": "AVAILABLE",
        "runner": RUNNERS[group],
        "dataset": source.name,
        "sha256": digest,
        **({"trial_record_export": document["trial_record_export"]} if isinstance(document.get("trial_record_export"), dict) else {}),
        "versions": versions,
        "sample": {
            "clusters": cluster_count,
            "cluster_unit": cluster_unit,
            "attempts": len(records),
            "accuracy_eligible_attempts": eligible_attempts,
            "independently_confirmed_human_attempts": len(records) if group == "human" else 0,
        },
        "prediction_provenance": [
            {"method": method, "origin": origin, "version": version}
            for method, origin, version in sorted(prediction_provenance)
        ] if group == "human" else [],
        "metrics": metrics,
        "mouse_features": mouse_features or {"status": "UNAVAILABLE", "reason": "no_complete_mouse_feature_observations"},
        "challenge_performance": challenge_report or {"status": "UNAVAILABLE", "reason": "no_challenge_labels"},
        "browser_signals": signal_report or {"status": "UNAVAILABLE", "reason": "no_browser_signal_observations"},
    }


def _report_evidence_class(datasets: dict[str, Path | None]) -> str:
    supplied = [path for path in datasets.values() if path is not None]
    if not supplied:
        return "UNAVAILABLE"
    evidence_classes = []
    for path in supplied:
        document, _ = _read_dataset(path)
        evidence_classes.append(document.get("evidence_class"))
    return "SIMULATED" if all(value == "SIMULATED" for value in evidence_classes) else "UNVERIFIED_INPUTS"


def build_report(datasets: dict[str, Path | None]) -> dict[str, Any]:
    challenge_path = Path(__file__).resolve().parent / "src" / "fixed-challenges.js"
    challenge_hash = hashlib.sha256(challenge_path.read_bytes()).hexdigest() if challenge_path.is_file() else CHALLENGE_SET_SHA256
    return {
        "report_version": 2,
        "protocol": {
            "name": "Cognit Human vs Automation descriptive benchmark",
            "version": "1",
            "challenge_set": "fixed-challenges.js; compare identical challenge IDs only",
            "challenge_set_sha256": challenge_hash,
            "collection": "Use source exports as collected; do not infer missing labels, signals, or timings.",
            "human_inclusion": "Primary human endpoint requires independent human confirmation, participant_id, session_id, and valid session_started_at. Consent pseudonyms alone are not unique participant identifiers.",
            "accuracy": "correct / attempts with a boolean correctness result; unknown or absent correctness excluded.",
            "human_false_positive_rate": "Primary endpoint uses one earliest eligible session per independently confirmed participant; numerator is participants with any nested attempt receiving RESTRICT or BLOCK, denominator is participants with a known primary-session outcome. CHALLENGE is separate and does not prove humanity. Retries are nested and excluded from the primary denominator.",
            "uncertainty": "Primary binary participant-level rates use two-sided 95% Clopper-Pearson exact binomial intervals, including a non-zero upper bound for zero events. Secondary repeated-measure summaries use deterministic cluster bootstrap.",
            "completion_time": "Only an explicit completion_time_ms observation is summarized; it is not inferred from attempt timestamps.",
        },
        "groups": {group: _group_report(group, datasets.get(group)) for group in GROUPS},
        "endpoints": _primary_endpoints(datasets),
        "evidence_class": _report_evidence_class(datasets),
        "limitations": [
            "No group result implies universal separation of humans and automation.",
            "Browser indicators are experimental signals; missing indicators do not establish human operation.",
            "Within-cluster attempts are grouped before uncertainty is estimated.",
            "Oracle-assisted records are excluded from perception endpoints.",
            "CAPTCHA success does not establish that an actor is human.",
            "A report with unavailable groups or metrics makes no inference about them.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for group in GROUPS:
        parser.add_argument(f"--{group}", type=Path, help=f"{group} dataset JSON export")
    parser.add_argument("--output", type=Path, default=Path("benchmark-report.json"))
    args = parser.parse_args()
    datasets = {group: getattr(args, group) for group in GROUPS}
    report = build_report(datasets)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
