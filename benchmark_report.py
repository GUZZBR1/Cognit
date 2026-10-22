"""Build a reproducible, descriptive report from identified Cognit run exports."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
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
    if group == "human":
        records = document.get("records")
        if not isinstance(records, list):
            raise ValueError("human export must contain a records array")
        return [record for record in records if _confirmed_human(record)]

    attempts = document.get("attempts")
    if not isinstance(attempts, list):
        raise ValueError(f"{group} run must contain an attempts array")
    session_id = document.get("session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError(f"{group} run must identify its session_id")
    return [record for record in attempts if isinstance(record, dict)]


def _cluster_id(group: str, document: dict[str, Any], record: dict[str, Any]) -> str | None:
    if group == "human":
        value = record.get("pseudonym")
    else:
        value = record.get("session_id", document.get("session_id"))
    return value if isinstance(value, str) and value else None


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
        return {"count": 0, "cluster_count": 0, "mean": None, "median": None,
                "unavailable_reason": "no_eligible_observations"}
    cluster_means = [mean(cluster) for cluster in values_by_cluster.values() if cluster]
    return {
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
        return {"numerator": 0, "denominator": 0, "value": None,
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
        return {"status": "unavailable", "reason": "no_dataset_supplied", "runner": RUNNERS[group]}
    document, digest = _read_dataset(source)
    records = _records(group, document)
    if not records:
        reason = "no_independently_confirmed_human_records" if group == "human" else "no_attempt_records"
        return {
            "status": "unavailable", "reason": reason, "runner": RUNNERS[group],
            "dataset": str(source), "sha256": digest,
            "input_record_count": len(document.get("records", document.get("attempts", []))),
        }

    ids = [_cluster_id(group, document, row) for row in records]
    cluster_count = len({item for item in ids if item is not None})
    cluster_unit = "consent_pseudonym" if group == "human" else "session_id"
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
        metrics["human_false_positive_rate"] = _rate_summary(
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
        "status": "available",
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
        "mouse_features": mouse_features or {"status": "unavailable", "reason": "no_complete_mouse_feature_observations"},
        "challenge_performance": challenge_report or {"status": "unavailable", "reason": "no_challenge_labels"},
        "browser_signals": signal_report or {"status": "unavailable", "reason": "no_browser_signal_observations"},
    }


def build_report(datasets: dict[str, Path | None]) -> dict[str, Any]:
    challenge_path = Path(__file__).resolve().parent / "src" / "fixed-challenges.js"
    challenge_hash = hashlib.sha256(challenge_path.read_bytes()).hexdigest()
    return {
        "report_version": 1,
        "protocol": {
            "name": "Cognit Human vs Automation descriptive benchmark",
            "version": "1",
            "challenge_set": "fixed-challenges.js; compare identical challenge IDs only",
            "challenge_set_sha256": challenge_hash,
            "collection": "Use source exports as collected; do not infer missing labels, signals, or timings.",
            "human_inclusion": "HUMAN_CONFIRMED=true plus non-empty method, origin, and procedure from independent review.",
            "accuracy": "correct / attempts with a boolean correctness result; unknown or absent correctness excluded.",
            "human_false_positive_rate": "explicit predicted_automation=true / confirmed human attempts with a boolean prediction and non-empty prediction_provenance.method, origin, and version.",
            "uncertainty": "95% percentile cluster bootstrap resampling observed clusters; continuous summaries use unweighted per-cluster means and rates pool attempts. Automation clusters use session_id; human clusters use consent pseudonyms, which identify consent episodes rather than verified unique people. 2,000 replicates; deterministic per group and metric. Unavailable below two clusters.",
            "completion_time": "Only an explicit completion_time_ms observation is summarized; it is not inferred from attempt timestamps.",
        },
        "groups": {group: _group_report(group, datasets.get(group)) for group in GROUPS},
        "limitations": [
            "No group result implies universal separation of humans and automation.",
            "Browser indicators are experimental signals; missing indicators do not establish human operation.",
            "Within-cluster attempts are grouped before uncertainty is estimated.",
            "Human consent pseudonyms may change on repeat consent; they do not deduplicate people across consent episodes, so human uncertainty is not a person-level estimate.",
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
