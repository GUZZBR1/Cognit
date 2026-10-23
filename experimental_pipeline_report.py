"""Combine deterministic benchmark and training-free readiness outputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from benchmark_report import build_report
from scripts.ml_readiness import evaluate as evaluate_ml_readiness


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_pipeline_report(trial_record_export: Path, readiness_manifest: Path) -> dict[str, Any]:
    benchmark = build_report({"playwright": trial_record_export})
    with readiness_manifest.open(encoding="utf-8") as stream:
        readiness_input = json.load(stream)
    readiness = evaluate_ml_readiness(readiness_input)
    return {
        "report_version": "experimental-pipeline-report-v1",
        "evidence_class": "SIMULATED" if benchmark["evidence_class"] == "SIMULATED" and readiness["evidence_mode"] == "SIMULATED" else "UNVERIFIED_INPUTS",
        "components": {
            "benchmark": {
                "input_sha256": _sha256(trial_record_export),
                "report": benchmark,
            },
            "dataset_readiness": {
                "input_sha256": _sha256(readiness_manifest),
                "independent_of_benchmark_records": True,
                "report": readiness,
            },
        },
        "limitations": [
            "Both component reports are fixture evidence and remain SIMULATED.",
            "Dataset readiness evaluates its own declared grouped-split manifest; it does not consume benchmark records.",
            "Readiness does not invoke training, establish effectiveness, or authorize production use.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trial-record-export", required=True, type=Path)
    parser.add_argument("--readiness-manifest", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        report = build_pipeline_report(args.trial_record_export, args.readiness_manifest)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"cannot build experimental pipeline report: {error}", file=sys.stderr)
        return 2
    encoded = json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
        print(f"Wrote {args.output}")
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
