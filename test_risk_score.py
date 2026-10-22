import unittest

from risk_score import SIGNAL_GROUPS, score_risk


class ScoreRiskTests(unittest.TestCase):
    def test_empty_and_invalid_inputs_are_inconclusive(self):
        for result in (
            score_risk(),
            score_risk(perception={"risk": 2, "confidence": 1}, timing="bad"),
        ):
            self.assertEqual(result["risk_score"], 0)
            self.assertEqual(result["confidence"], 0)
            self.assertEqual(result["state"], "inconclusive")
            self.assertEqual(result["used_signals"], [])
            self.assertEqual(result["missing_signals"], list(SIGNAL_GROUPS))

    def test_one_group_is_insufficient_even_with_high_confidence(self):
        result = score_risk(perception={"risk": 1, "confidence": 1})
        self.assertEqual(result["risk_score"], 0)
        self.assertEqual(result["state"], "inconclusive")
        self.assertEqual(result["used_signals"], ["perception"])

    def test_fixture_combination_aggregates_independent_groups(self):
        result = score_risk(
            perception=[{"risk": 0.8, "confidence": 1}, {"risk": 0.4, "confidence": 1}],
            timing={"risk": 0.6, "confidence": 0.8},
            traps={"risk": 0.2, "confidence": 1},
        )
        self.assertEqual(result["state"], "scored")
        self.assertEqual(result["risk_score"], 46)
        self.assertEqual(result["confidence"], 0.9333)
        self.assertEqual(result["used_signals"], ["perception", "timing", "traps"])
        self.assertEqual(result["missing_signals"], ["mouse", "browser", "journey"])

    def test_low_risk_and_low_confidence_do_not_create_conclusive_result(self):
        low_risk = score_risk(perception={"risk": 0, "confidence": 1}, timing={"risk": 0.1, "confidence": 1})
        self.assertEqual(low_risk["state"], "scored")
        self.assertEqual(low_risk["risk_score"], 5)
        sparse = score_risk(perception={"risk": 1, "confidence": 0.2}, timing={"risk": 1, "confidence": 0.2})
        self.assertEqual(sparse["state"], "inconclusive")
        self.assertEqual(sparse["risk_score"], 0)
        self.assertLess(sparse["confidence"], 0.5)

    def test_score_and_confidence_are_bounded(self):
        result = score_risk(
            perception={"risk": 1, "confidence": 1},
            timing={"risk": 1, "confidence": 1},
            mouse={"risk": 1, "confidence": 1},
            browser={"risk": 1, "confidence": 1},
            journey={"risk": 1, "confidence": 1},
            traps={"risk": 1, "confidence": 1},
        )
        self.assertEqual(result["risk_score"], 100)
        self.assertEqual(result["confidence"], 1)
        self.assertTrue(0 <= result["risk_score"] <= 100)
        self.assertTrue(0 <= result["confidence"] <= 1)


if __name__ == "__main__":
    unittest.main()
