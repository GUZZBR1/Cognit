#!/usr/bin/env python3
"""Print deterministic pairwise comparisons for the synthetic v0 fixture."""

import json
from pathlib import Path

from session_signature import (
    SESSION_SIGNATURE_SCHEMA_VERSION,
    build_session_signature,
    compare_session_signatures,
)


def main() -> None:
    fixture_path = Path(__file__).resolve().parents[1] / "test/fixtures/session-signatures-v0.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    if fixture.get("schemaVersion") != SESSION_SIGNATURE_SCHEMA_VERSION:
        raise TypeError("unsupported_session_signature_fixture_version")
    sessions = [
        {"name": item["name"], "signature": build_session_signature(item)}
        for item in fixture["sessions"]
    ]
    comparisons = []
    for index, left in enumerate(sessions):
        for right in sessions[index + 1 :]:
            compared = compare_session_signatures(left["signature"], right["signature"])
            comparisons.append({
                "left": left["name"],
                "right": right["name"],
                "leftAvailableFeatures": sorted(left["signature"]["features"]),
                "rightAvailableFeatures": sorted(right["signature"]["features"]),
                **compared,
            })
    print(json.dumps({
        "reportVersion": 0,
        "interpretation": "Experimental feature similarity only; no identity or class inference.",
        "comparisons": comparisons,
    }, indent=2))


if __name__ == "__main__":
    main()
