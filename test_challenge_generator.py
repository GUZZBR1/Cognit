import unittest

from challenge_generator import ChallengeConfig, ChallengeService


class ChallengeServiceTests(unittest.TestCase):
    def setUp(self):
        self.config = ChallengeConfig(
            stimulus="blue-circle",
            positions=("left", "center", "right"),
            order=("fixation", "stimulus", "mask"),
            duration_ms=750,
            question="Where did the stimulus appear?",
            distractors=("upper", "lower"),
        )

    def test_same_seed_and_config_produce_same_challenge(self):
        first = ChallengeService().generate("participant-seed-42", self.config)
        second = ChallengeService().generate("participant-seed-42", self.config)

        self.assertEqual(first, second)
        self.assertEqual(first.position, next(choice for choice in first.choices if choice in self.config.positions))

    def test_different_seeds_can_produce_different_challenges(self):
        first = ChallengeService().generate("seed-a", self.config)
        second = ChallengeService().generate("seed-b", self.config)

        self.assertNotEqual(first, second)
        self.assertNotEqual(
            (first.position, first.order, first.choices),
            (second.position, second.order, second.choices),
        )

    def test_server_validates_against_its_generated_answer(self):
        service = ChallengeService()
        challenge = service.generate("validation-seed", self.config)

        self.assertTrue(service.validate_answer(challenge.challenge_id, challenge.position))
        wrong_choice = next(choice for choice in challenge.choices if choice != challenge.position)
        self.assertFalse(service.validate_answer(challenge.challenge_id, wrong_choice))
        self.assertFalse(service.validate_answer("unknown-challenge", challenge.position))
        self.assertFalse(service.validate_answer(challenge.challenge_id, None))
        self.assertFalse(hasattr(challenge, "correct_answer"))

    def test_invalid_configuration_and_seed_are_rejected(self):
        with self.assertRaises(ValueError):
            ChallengeConfig("shape", ("left", "left"), ("stimulus",), 100, "Where?", ("right",))
        with self.assertRaises(ValueError):
            ChallengeConfig("shape", ("left",), ("stimulus",), 0, "Where?", ("right",))
        with self.assertRaises(ValueError):
            ChallengeConfig("shape", ("left",), ("stimulus",), 100, "Where?", ("left",))
        with self.assertRaises(ValueError):
            ChallengeService().generate(" ", self.config)


if __name__ == "__main__":
    unittest.main()
