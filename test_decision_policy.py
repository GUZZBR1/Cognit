import unittest

from decision_policy import (
    DecisionOutcome,
    DecisionPolicy,
    PolicyRule,
    decide,
)


def example_policy() -> DecisionPolicy:
    return DecisionPolicy(
        rules=(
            PolicyRule(DecisionOutcome.ALLOW, 0, 19),
            PolicyRule(DecisionOutcome.CHALLENGE, 20, 39),
            PolicyRule(DecisionOutcome.RESTRICT, 40, 59),
            PolicyRule(DecisionOutcome.BLOCK, 60, 79),
            PolicyRule(DecisionOutcome.UNKNOWN, 80, 100),
        ),
        minimum_confidence=0.7,
        required_signals=("device",),
    )


class DecisionPolicyTests(unittest.TestCase):
    def test_all_outcomes_are_configurable(self) -> None:
        policy = example_policy()
        results = [
            decide(score, 0.7, {"device": "present"}, policy).outcome
            for score in (0, 20, 40, 60, 80)
        ]
        self.assertEqual(
            results,
            [
                DecisionOutcome.ALLOW,
                DecisionOutcome.CHALLENGE,
                DecisionOutcome.RESTRICT,
                DecisionOutcome.BLOCK,
                DecisionOutcome.UNKNOWN,
            ],
        )

    def test_missing_and_insufficient_evidence_returns_unknown(self) -> None:
        policy = example_policy()
        for args, reason in (
            ((None, 0.9, {"device": "present"}, policy), "missing_or_invalid_score"),
            ((10, None, {"device": "present"}, policy), "missing_or_invalid_confidence"),
            ((10, 0.69, {"device": "present"}, policy), "insufficient_confidence"),
            ((10, 0.9, {}, policy), "insufficient_signals"),
            ((10, 0.9, {"device": None}, policy), "insufficient_signals"),
            ((10, 0.9, None, policy), "missing_signals"),
            ((101, 0.9, {"device": "present"}, policy), "missing_or_invalid_score"),
        ):
            with self.subTest(reason=reason):
                result = decide(*args)
                self.assertEqual(result.outcome, DecisionOutcome.UNKNOWN)
                self.assertEqual(result.reason, reason)

    def test_score_domain_limits_are_inclusive(self) -> None:
        policy = DecisionPolicy(
            rules=(PolicyRule(DecisionOutcome.ALLOW, 0, 100),),
            minimum_confidence=0,
        )
        for score in (0, 100):
            with self.subTest(score=score):
                self.assertEqual(
                    decide(score, 0, {}, policy).outcome,
                    DecisionOutcome.ALLOW,
                )

    def test_invalid_scores_return_unknown(self) -> None:
        policy = example_policy()
        for score in (-0.01, 100.01, float("nan"), float("inf"), True, "50"):
            with self.subTest(score=score):
                self.assertEqual(
                    decide(score, 0.9, {"device": "present"}, policy).outcome,
                    DecisionOutcome.UNKNOWN,
                )

    def test_invalid_configuration_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            PolicyRule("ALLOW", 0, 10)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            PolicyRule(DecisionOutcome.ALLOW, 10, 0)
        with self.assertRaises(ValueError):
            PolicyRule(DecisionOutcome.ALLOW, -1, 10)
        with self.assertRaises(ValueError):
            DecisionPolicy((), 1.01)
        with self.assertRaises(ValueError):
            DecisionPolicy((), 0.5, ("device", "device"))
        with self.assertRaises(ValueError):
            DecisionPolicy([PolicyRule(DecisionOutcome.ALLOW, 0, 100)], 0.5)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
