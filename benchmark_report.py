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
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise ValueError(f"{path}: expected an object with schema_version 1")
    return document, hashlib.sha256(raw).hexdigest()


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
    return record.get("oracle_access") is True or record.get("perception_metric_eligible") is False


def _outcome(record: dict[str, Any]) -> str:
    result = record.get("observed_result")
    raw = result.get("policy_outcome") if isinstance(result, dict) else None
    raw = raw or record.get("policy_outcome")
    value = raw if isinstance(raw, str) else "UNKNOWN"
    return value.upper() if value.upper() in {"ALLOW", "PASS", "CHALLENGE", "RESTRICT", "BLOCK", "UNKNOWN"} else "UNKNOWN"


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
    for group, path in datasets.items():
        if path is None:
            continue
        document, _ = _read_dataset(path)
        for row in _records(group, document):
            if _oracle_assisted(row):
                continue
            result = row.get("observed_result") if isinstance(row.get("observed_result"), dict) else {}
            challenge_id = row.get("challenge_id", result.get("challenge_id"))
            applied = row.get("challenge_applied") is True or bool(challenge_id)
            outcome = _outcome(row)
            outcomes.append(outcome)
            if applied:
                challenge_rows.append({"outcome": outcome, "correct": result.get("correct", row.get("correct")), "completed": result.get("completed", row.get("challenge_completed"))})
            actor = row.get("actor_class", row.get("actor", {}).get("type") if isinstance(row.get("actor"), dict) else None)
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
            elif actor in {"AUTOMATION_CONTROLLED", "SCRIPTED_AUTOMATION", "AI_AGENT"} or group != "human":
                session_id = row.get("session_id", document.get("session_id"))
                if isinstance(session_id, str) and session_id:
                    automated_rows.append({"group": group, "session_id": session_id, "outcome": outcome, "reached": row.get("protected_action_reached") is True or result.get("protected_action_reached") is True})

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
        session = automation_sessions.setdefault(key, {"outcomes": [], "reached": False})
        session["outcomes"].append(row["outcome"])
        session["reached"] = session["reached"] or row["reached"]
    escape_eligible = [session for session in automation_sessions.values() if any(outcome != "UNKNOWN" for outcome in session["outcomes"])]
    escaped = sum(session["reached"] for session in escape_eligible)
    completed_challenges = [row for row in challenge_rows if row["completed"] is True]
    known_challenges = [row for row in completed_challenges if isinstance(row["correct"], bool)]

    def rate(events: int, total: int) -> dict[str, Any]:
        if total == 0:
            return {"status": "UNAVAILABLE", "numerator": None, "denominator": None, "value": None, "interval_95": None, "reason": "no_eligible_observations"}
        return {"status": "AVAILABLE", "numerator": events, "denominator": total, "value": events / total, "interval_95": _exact_binomial_interval(events, total)}

    outcome_counts = {name: sum(outcome == name for outcome in outcomes) for name in ("CHALLENGE", "RESTRICT", "BLOCK", "UNKNOWN")}
    return {
        "human_false_positive_rate": {**rate(false_positives, len(eligible_human)), "unit": "independent_participant", "participants": len(primary), "sessions_considered": len(sessions), "numerator_definition": "primary session received RESTRICT or BLOCK on any nested attempt", "denominator_definition": "participants with independently confirmed primary session and at least one known outcome"},
        "automation_escape_to_protected_action": {**rate(escaped, len(escape_eligible)), "unit": "session", "numerator_definition": "protected action reached", "denominator_definition": "non-oracle automation sessions with known policy outcome"},
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
            "dataset": str(source), "sha256": digest,
            "input_record_count": input_record_count,
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
        "dataset": str(source),
        "sha256": digest,
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
        "evidence_class": (
            "UNAVAILABLE" if not any(datasets.values())
            else "SIMULATED" if all(path is None or {"fixture", "fixtures"}.intersection(path.parts) for path in datasets.values())
            else "UNVERIFIED_INPUTS"
        ),
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
