import unittest

from app.protocols import get_protocol, list_protocols


class ProtocolTests(unittest.TestCase):
    def test_lists_baseline_and_prompted_evp_protocols(self):
        protocols = list_protocols()

        protocol_ids = {protocol["id"] for protocol in protocols}
        self.assertIn("baseline", protocol_ids)
        self.assertIn("prompted_evp", protocol_ids)

    def test_baseline_protocol_has_quiet_sensor_and_review_steps(self):
        protocol = get_protocol("baseline")

        step_titles = [step["title"] for step in protocol["steps"]]
        self.assertEqual(step_titles[0], "Set room state")
        self.assertIn("Quiet-room capture", step_titles)
        self.assertIn("Review baseline", step_titles)

    def test_prompted_evp_protocol_uses_silence_windows(self):
        protocol = get_protocol("prompted_evp")

        silence_steps = [step for step in protocol["steps"] if "silence" in step["title"].lower()]
        self.assertTrue(silence_steps)
        self.assertTrue(all(step["duration_seconds"] >= 20 for step in silence_steps))

    def test_unknown_protocol_raises_key_error(self):
        with self.assertRaises(KeyError):
            get_protocol("missing")


if __name__ == "__main__":
    unittest.main()
