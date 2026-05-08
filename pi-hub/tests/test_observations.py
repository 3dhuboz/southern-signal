import unittest

from app.observations import (
    OBSERVATION_TYPES,
    build_observation_event,
    find_observation_type,
    list_observation_types,
)


REQUIRED_KEYS = {
    "id",
    "label",
    "description",
    "default_intensity",
    "suggests_media",
    "category",
}


class ObservationTypeCatalogTests(unittest.TestCase):
    def test_observation_types_is_non_empty(self):
        self.assertGreater(len(OBSERVATION_TYPES), 0)

    def test_every_entry_has_required_keys_with_correct_types(self):
        for entry in OBSERVATION_TYPES:
            self.assertEqual(set(entry.keys()) & REQUIRED_KEYS, REQUIRED_KEYS)
            self.assertIsInstance(entry["id"], str)
            self.assertIsInstance(entry["label"], str)
            self.assertIsInstance(entry["description"], str)
            self.assertIsInstance(entry["default_intensity"], int)
            self.assertIn(entry["suggests_media"], {"audio", "image", None})
            self.assertIsInstance(entry["category"], str)
            self.assertGreaterEqual(entry["default_intensity"], 1)
            self.assertLessEqual(entry["default_intensity"], 5)

    def test_ids_are_unique(self):
        ids = [entry["id"] for entry in OBSERVATION_TYPES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_required_ids_present(self):
        ids = {entry["id"] for entry in OBSERVATION_TYPES}
        for required in [
            "felt_presence",
            "cold_spot",
            "temperature_drop",
            "temperature_rise",
            "evp_heard",
            "voice_heard",
            "knocks_taps",
            "footsteps_heard",
            "physical_touch",
            "visual_anomaly",
            "shadow_figure",
            "object_movement",
            "equipment_interference",
            "smell_anomaly",
            "emotional_response",
            "general",
        ]:
            self.assertIn(required, ids)

    def test_list_observation_types_returns_deep_copy(self):
        first = list_observation_types()
        first[0]["label"] = "Mutated"
        first[0]["category"] = "mutated"
        second = list_observation_types()
        self.assertNotEqual(second[0]["label"], "Mutated")
        self.assertNotEqual(second[0]["category"], "mutated")


class FindObservationTypeTests(unittest.TestCase):
    def test_find_returns_matching_entry(self):
        entry = find_observation_type("cold_spot")
        self.assertEqual(entry["id"], "cold_spot")
        self.assertEqual(entry["category"], "sensory")

    def test_find_unknown_id_raises_key_error(self):
        with self.assertRaises(KeyError):
            find_observation_type("does_not_exist")


class BuildObservationEventTests(unittest.TestCase):
    def test_happy_path_returns_expected_shape(self):
        event = build_observation_event(
            observation_type="felt_presence",
            title="Presence in the kitchen",
            intensity=4,
            description="Strong sense of company near the stove.",
            timestamp="2026-05-08T10:00:00+00:00",
        )

        self.assertEqual(event["source"], "user")
        self.assertEqual(event["event_type"], "observation")
        self.assertEqual(event["title"], "Presence in the kitchen")
        self.assertEqual(event["description"], "Strong sense of company near the stove.")
        self.assertEqual(event["timestamp"], "2026-05-08T10:00:00+00:00")
        self.assertEqual(event["metadata"]["observation_type"], "felt_presence")
        self.assertEqual(event["metadata"]["intensity"], 4)
        self.assertEqual(event["metadata"]["category"], "sensory")
        self.assertEqual(event["metadata"]["default_label"], "Felt presence")
        self.assertIsNone(event["metadata"]["linked_media_id"])

    def test_title_falls_back_to_type_label(self):
        event = build_observation_event(observation_type="evp_heard")
        type_entry = find_observation_type("evp_heard")
        self.assertEqual(event["title"], type_entry["label"])

    def test_intensity_default_falls_back_to_type_default(self):
        event = build_observation_event(observation_type="evp_heard")
        type_entry = find_observation_type("evp_heard")
        self.assertEqual(event["metadata"]["intensity"], type_entry["default_intensity"])

    def test_whitespace_only_title_raises_value_error(self):
        with self.assertRaises(ValueError):
            build_observation_event(observation_type="general", title="   ")

    def test_intensity_zero_raises_value_error(self):
        with self.assertRaises(ValueError):
            build_observation_event(observation_type="general", intensity=0)

    def test_intensity_six_raises_value_error(self):
        with self.assertRaises(ValueError):
            build_observation_event(observation_type="general", intensity=6)

    def test_intensity_negative_raises_value_error(self):
        with self.assertRaises(ValueError):
            build_observation_event(observation_type="general", intensity=-1)

    def test_unknown_observation_type_raises_key_error(self):
        with self.assertRaises(KeyError):
            build_observation_event(observation_type="not_a_real_type")

    def test_linked_media_id_survives_into_metadata(self):
        event = build_observation_event(
            observation_type="visual_anomaly",
            linked_media_id="media-1234",
        )
        self.assertEqual(event["metadata"]["linked_media_id"], "media-1234")

    def test_categories_present_in_output(self):
        event = build_observation_event(observation_type="shadow_figure")
        self.assertIn("category", event["metadata"])
        self.assertEqual(event["metadata"]["category"], "visual")


if __name__ == "__main__":
    unittest.main()
