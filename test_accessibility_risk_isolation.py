"""Accessibility condition metadata must not change risk or policy results."""

import unittest

from decision_policy import DecisionOutcome, DecisionPolicy, PolicyRule, decide
from risk_score import score_risk


class AccessibilityRiskIsolationTests(unittest.TestCase):
    def test_mode_alone_does_not_change_risk_score_confidence_or_policy(self):
        policy = DecisionPolicy(
            rules=(PolicyRule(DecisionOutcome.ALLOW, 0, 100),),
            minimum_confidence=0.5,
        )
        results = []
        for mode in ("VISUAL", "ACCESSIBLE"):
            assessment = score_risk(
                perception={"risk": 0.2, "confidence": 0.8, "accessibility_mode": mode},
                timing={"risk": 0.1, "confidence": 0.8},
            )
            decision = decide(
                assessment["risk_score"],
                assessment["confidence"],
                {"perception": True, "timing": True, "accessibility_mode": mode},
                policy,
            )
            results.append((assessment, decision))

        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0][0]["state"], "scored")
        self.assertEqual(results[0][1].outcome, DecisionOutcome.ALLOW)


if __name__ == "__main__":
    unittest.main()
