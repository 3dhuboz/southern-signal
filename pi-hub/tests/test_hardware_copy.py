import copy
import unittest

from app.hardware_copy import PROVIDER_COPY, enrich_hardware_status


def _mock_status(active: str = "mock") -> dict:
    return {
        "active_provider": active,
        "providers": [
            {"name": "sense_hat", "label": "Sense HAT", "available": False, "detail": "Not detected."},
            {"name": "mock", "label": "Mock development sensors", "available": True, "detail": "Synthetic readings."},
        ],
    }


class EnrichHardwareStatusTests(unittest.TestCase):
    def test_does_not_mutate_input(self):
        status = _mock_status("mock")
        snapshot = copy.deepcopy(status)
        enrich_hardware_status(status)
        self.assertEqual(status, snapshot)

    def test_active_mock_yields_standalone_mode(self):
        enriched = enrich_hardware_status(_mock_status("mock"))
        self.assertEqual(enriched["mode"], "standalone")
        self.assertIsNotNone(enriched["pi_hint"])
        self.assertTrue(enriched["pi_hint"].strip())
        self.assertTrue(
            "standalone" in enriched["mode_label"].lower()
            or "mobile" in enriched["mode_label"].lower()
        )

    def test_active_sense_hat_yields_pi_enhanced_mode(self):
        enriched = enrich_hardware_status(_mock_status("sense_hat"))
        self.assertEqual(enriched["mode"], "pi_enhanced")
        self.assertIsNone(enriched["pi_hint"])
        self.assertEqual(enriched["mode_label"], "Pi-enhanced capture")

    def test_unknown_provider_gets_sensible_defaults(self):
        status = {
            "active_provider": "lab_rig",
            "providers": [
                {"name": "lab_rig", "available": True, "detail": "Custom rig."},
            ],
        }
        enriched = enrich_hardware_status(status)
        provider = enriched["providers"][0]
        self.assertIn("friendly_label", provider)
        self.assertIn("friendly_description", provider)
        self.assertIn("is_pi_hardware", provider)
        self.assertFalse(provider["is_pi_hardware"])
        self.assertEqual(provider["friendly_label"], "Lab Rig")

    def test_known_provider_copy_preserved(self):
        enriched = enrich_hardware_status(_mock_status("mock"))
        providers_by_name = {p["name"]: p for p in enriched["providers"]}

        mock_copy = providers_by_name["mock"]
        self.assertEqual(mock_copy["friendly_label"], PROVIDER_COPY["mock"]["friendly_label"])
        self.assertEqual(
            mock_copy["friendly_description"],
            PROVIDER_COPY["mock"]["friendly_description"],
        )
        self.assertFalse(mock_copy["is_pi_hardware"])

        sense_hat_copy = providers_by_name["sense_hat"]
        self.assertEqual(
            sense_hat_copy["friendly_label"],
            PROVIDER_COPY["sense_hat"]["friendly_label"],
        )
        self.assertTrue(sense_hat_copy["is_pi_hardware"])

    def test_existing_provider_fields_are_preserved(self):
        enriched = enrich_hardware_status(_mock_status("mock"))
        providers_by_name = {p["name"]: p for p in enriched["providers"]}
        self.assertTrue(providers_by_name["mock"]["available"])
        self.assertFalse(providers_by_name["sense_hat"]["available"])
        self.assertEqual(providers_by_name["sense_hat"]["detail"], "Not detected.")


if __name__ == "__main__":
    unittest.main()
