import unittest

from app.analysis.scoring import score_evidence


class EvidenceScoringTests(unittest.TestCase):
    def test_weak_contaminated_event_scores_low_with_plain_english_reasons(self):
        result = score_evidence(
            {
                "audio_spike": True,
                "sensor_correlation_count": 0,
                "media_support": False,
                "unattended_room": False,
                "blind_reviewer_agreement_count": 0,
                "contamination_count": 3,
                "calibration_ok": True,
                "sync_confidence": 0.8,
            }
        )

        self.assertLessEqual(result["score"], 30)
        self.assertEqual(result["label"], "weak")
        self.assertTrue(any("contamination" in reason.lower() for reason in result["reasons"]))
        self.assertTrue(any("audio spike" in reason.lower() for reason in result["reasons"]))

    def test_strong_correlated_event_scores_high(self):
        result = score_evidence(
            {
                "audio_spike": True,
                "sensor_correlation_count": 4,
                "media_support": True,
                "unattended_room": True,
                "blind_reviewer_agreement_count": 3,
                "contamination_count": 0,
                "calibration_ok": True,
                "sync_confidence": 0.95,
            }
        )

        self.assertGreaterEqual(result["score"], 80)
        self.assertEqual(result["label"], "strong")
        self.assertTrue(any("4 sensor" in reason.lower() for reason in result["reasons"]))
        self.assertTrue(any("blind reviewer" in reason.lower() for reason in result["reasons"]))

    def test_bad_calibration_and_poor_sync_penalize_otherwise_promising_event(self):
        clean_result = score_evidence(
            {
                "audio_spike": True,
                "sensor_correlation_count": 3,
                "media_support": True,
                "unattended_room": True,
                "blind_reviewer_agreement_count": 2,
                "contamination_count": 0,
                "calibration_ok": True,
                "sync_confidence": 0.9,
            }
        )
        penalized_result = score_evidence(
            {
                "audio_spike": True,
                "sensor_correlation_count": 3,
                "media_support": True,
                "unattended_room": True,
                "blind_reviewer_agreement_count": 2,
                "contamination_count": 0,
                "calibration_ok": False,
                "sync_confidence": 0.35,
            }
        )

        self.assertLess(penalized_result["score"], clean_result["score"])
        self.assertEqual(penalized_result["label"], "moderate")
        self.assertTrue(any("calibration" in reason.lower() for reason in penalized_result["reasons"]))
        self.assertTrue(any("sync" in reason.lower() for reason in penalized_result["reasons"]))


if __name__ == "__main__":
    unittest.main()
