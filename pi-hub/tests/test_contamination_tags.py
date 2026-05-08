import unittest

from app.contamination import CONTAMINATION_TAGS, get_contamination_tags


class ContaminationTagTests(unittest.TestCase):
    def test_contamination_tags_include_common_field_noise_sources(self):
        tag_ids = {tag["id"] for tag in get_contamination_tags()}

        self.assertIn("footstep", tag_ids)
        self.assertIn("breath", tag_ids)
        self.assertIn("phone_movement", tag_ids)
        self.assertIn("wind", tag_ids)

    def test_tags_are_grouped_for_fast_field_use(self):
        groups = {tag["group"] for tag in CONTAMINATION_TAGS}

        self.assertIn("human", groups)
        self.assertIn("environment", groups)
        self.assertIn("equipment", groups)


if __name__ == "__main__":
    unittest.main()
