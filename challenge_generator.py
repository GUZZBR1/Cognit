"""Deterministic, server-side challenge generation (algorithm v1).

The seed is a non-empty string. ``ChallengeConfig`` supplies a non-empty
stimulus and question, unique possible position labels, a sequence of unique
order labels (which may be empty), a positive duration in milliseconds, and
unique distractor labels that do not overlap the positions. Generation picks
one position, shuffles the configured order, and shuffles that position with
the distractors as answer choices. The selected position is the correct
answer. Public challenges contain presentation data and choices; the answer
key stays in the ``ChallengeService`` instance and is used for validation.

SHA-256 input encoding, config JSON encoding, and Fisher-Yates shuffle are
fixed by algorithm version 1, so the same seed/config pair is reproducible
across Python versions.

The service is in-memory and intended to be owned by server code. Persisting
challenge state across processes or restarts is an application concern.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Iterable


def _non_empty_string(value: object, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")


def _unique_strings(
    values: Iterable[str], field: str, *, minimum: int = 1
) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise ValueError(f"{field} must be a sequence of strings")
    items = tuple(values)
    if len(items) < minimum:
        raise ValueError(f"{field} must contain at least {minimum} item(s)")
    for item in items:
        _non_empty_string(item, field)
    if len(items) != len(set(items)):
        raise ValueError(f"{field} must not contain duplicates")
    return items


@dataclass(frozen=True)
class ChallengeConfig:
    stimulus: str
    positions: tuple[str, ...]
    order: tuple[str, ...]
    duration_ms: int
    question: str
    distractors: tuple[str, ...]

    def __post_init__(self) -> None:
        _non_empty_string(self.stimulus, "stimulus")
        _non_empty_string(self.question, "question")
        object.__setattr__(self, "positions", _unique_strings(self.positions, "positions"))
        object.__setattr__(self, "order", _unique_strings(self.order, "order", minimum=0))
        object.__setattr__(self, "distractors", _unique_strings(self.distractors, "distractors"))
        if isinstance(self.duration_ms, bool) or not isinstance(self.duration_ms, int) or self.duration_ms <= 0:
            raise ValueError("duration_ms must be a positive integer")
        if set(self.positions).intersection(self.distractors):
            raise ValueError("distractors must not overlap possible positions")


@dataclass(frozen=True)
class Challenge:
    challenge_id: str
    stimulus: str
    position: str
    order: tuple[str, ...]
    duration_ms: int
    question: str
    choices: tuple[str, ...]


class _SeededShuffle:
    """Small version-pinned SHA-256 stream used for Fisher-Yates shuffles."""

    def __init__(self, seed: str, config_json: bytes) -> None:
        self._key = hashlib.sha256(
            b"cognit-challenge-v1\0" + seed.encode("utf-8") + b"\0" + config_json
        ).digest()
        self._counter = 0

    def _uint64(self) -> int:
        block = hashlib.sha256(self._key + self._counter.to_bytes(8, "big")).digest()
        self._counter += 1
        return int.from_bytes(block[:8], "big")

    def randbelow(self, upper: int) -> int:
        limit = (1 << 64) - ((1 << 64) % upper)
        while True:
            value = self._uint64()
            if value < limit:
                return value % upper

    def shuffle(self, values: Iterable[str]) -> tuple[str, ...]:
        items = list(values)
        for index in range(len(items) - 1, 0, -1):
            swap = self.randbelow(index + 1)
            items[index], items[swap] = items[swap], items[index]
        return tuple(items)


class ChallengeService:
    """Generate reproducible challenges and validate answers server-side."""

    def __init__(self) -> None:
        self._answers: dict[str, str] = {}

    def generate(self, seed: str, config: ChallengeConfig) -> Challenge:
        _non_empty_string(seed, "seed")
        if not isinstance(config, ChallengeConfig):
            raise ValueError("config must be a ChallengeConfig")

        config_json = json.dumps(
            {
                "stimulus": config.stimulus,
                "positions": config.positions,
                "order": config.order,
                "duration_ms": config.duration_ms,
                "question": config.question,
                "distractors": config.distractors,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        digest = hashlib.sha256(
            b"cognit-challenge-id-v1\0" + seed.encode("utf-8") + b"\0" + config_json
        ).hexdigest()
        rng = _SeededShuffle(seed, config_json)
        position = config.positions[rng.randbelow(len(config.positions))]
        choices = rng.shuffle((position, *config.distractors))
        challenge = Challenge(
            challenge_id=digest[:24],
            stimulus=config.stimulus,
            position=position,
            order=rng.shuffle(config.order),
            duration_ms=config.duration_ms,
            question=config.question,
            choices=choices,
        )
        self._answers[challenge.challenge_id] = position
        return challenge

    def validate_answer(self, challenge_id: str, submitted_answer: str) -> bool:
        """Return whether the answer matches the server-held generated answer."""
        if not isinstance(challenge_id, str) or not isinstance(submitted_answer, str):
            return False
        expected = self._answers.get(challenge_id)
        return expected is not None and submitted_answer == expected
