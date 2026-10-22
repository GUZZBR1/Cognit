"""Experimental, deterministic session feature signatures (schema version 0).

This module flattens caller-supplied aggregates only. It does not classify,
identify, persist, or infer missing values.
"""

from collections.abc import Mapping
from math import isfinite
from typing import Any

SESSION_SIGNATURE_SCHEMA_VERSION = 0
COMPARISON_METHOD = "mean-symmetric-relative-difference-v0"

GROUPS = {
    "perception": ("duration_ms", "correct"),
    "timing": ("durationMs", "reactionTimeMs"),
    "behavior": ("distancePx", "durationMs", "meanSpeedPxPerMs", "pauseCount", "directionChanges", "speedVariation", "trajectoryEntropyBits"),
    "journey": ("sessionCount", "succeededCount", "failedCount"),
    "browser": ("navigator_webdriver", "playwright_globals", "selenium_globals", "puppeteer_global", "headless_chromium_user_agent", "empty_plugin_list", "empty_languages_list"),
    "history": ("sessionCount", "succeededCount", "failedCount"),
}
_BOOLEAN_FEATURES = {
    "perception.correct", "browser.navigator_webdriver", "browser.playwright_globals",
    "browser.selenium_globals", "browser.puppeteer_global", "browser.headless_chromium_user_agent",
    "browser.empty_plugin_list", "browser.empty_languages_list",
}
_COUNT_FEATURES = {
    f"{group}.{field}"
    for group in ("behavior", "journey", "history")
    for field in (("pauseCount", "directionChanges") if group == "behavior" else ("sessionCount", "succeededCount", "failedCount"))
}
_FEATURE_KEYS = {f"{group}.{field}" for group, fields in GROUPS.items() for field in fields}
_MAX_SAFE_INTEGER = 2**53 - 1


def _valid_numeric(key: str, value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        finite = isfinite(value)
    except OverflowError:
        return False
    if not finite or value < 0:
        return False
    if key not in _COUNT_FEATURES:
        return True
    return value <= _MAX_SAFE_INTEGER and (not isinstance(value, float) or value.is_integer())


def _normalize(key: str, value: Any) -> int | float | None:
    if key in _BOOLEAN_FEATURES:
        return int(value) if isinstance(value, bool) else None
    return value if _valid_numeric(key, value) else None


def _source(group: str, session: Mapping[str, Any]) -> Any:
    return session.get("behavior", {}).get("features") if group == "behavior" and isinstance(session.get("behavior"), Mapping) else session.get(group)


def build_session_signature(session: Mapping[str, Any]) -> dict[str, Any]:
    """Flatten allowlisted minimized aggregates; absent or invalid values stay unavailable."""
    if not isinstance(session, Mapping):
        raise TypeError("session_must_be_an_object")
    features: dict[str, int | float] = {}
    unavailable: dict[str, list[str]] = {}
    for group, fields in GROUPS.items():
        source = _source(group, session)
        unavailable[group] = []
        for field in fields:
            key = f"{group}.{field}"
            value = source.get(field) if isinstance(source, Mapping) else None
            normalized = _normalize(key, value)
            if normalized is not None:
                features[key] = normalized
            else:
                unavailable[group].append(key)
    return {"schemaVersion": SESSION_SIGNATURE_SCHEMA_VERSION, "features": features, "unavailable": unavailable}


def _validate_feature_map(features: Any) -> None:
    if not isinstance(features, Mapping):
        raise TypeError("signature_features_required")
    for key, value in features.items():
        if key not in _FEATURE_KEYS:
            raise TypeError(f"unsupported_signature_feature: {key}")
        if key in _BOOLEAN_FEATURES:
            valid = type(value) is int and value in (0, 1)
        else:
            valid = _valid_numeric(key, value)
        if not valid:
            raise TypeError(f"invalid_signature_feature: {key}")


def compare_session_signatures(left: Mapping[str, Any], right: Mapping[str, Any]) -> dict[str, Any]:
    """Compare only jointly available feature values and report coverage."""
    if not isinstance(left, Mapping) or not isinstance(right, Mapping) or left.get("schemaVersion") != 0 or right.get("schemaVersion") != 0:
        raise TypeError("incompatible_signature_schema_version")
    a, b = left.get("features"), right.get("features")
    _validate_feature_map(a)
    _validate_feature_map(b)
    common = sorted(set(a).intersection(b))
    union_count = len(set(a).union(b))
    distance = (
        sum(abs(a[key] - b[key]) / max(1, abs(a[key]), abs(b[key])) for key in common) / len(common)
        if common else None
    )
    return {
        "method": COMPARISON_METHOD,
        "distance": distance,
        "commonFeatureCount": len(common),
        "unionFeatureCount": union_count,
        "coverage": len(common) / union_count if union_count else 0,
        "commonFeatures": common,
    }
