import unittest

from app.analysis.anomalies import detect_sensor_anomalies


class AnomalyDetectionTests(unittest.TestCase):
    def test_detects_sensor_value_spike_against_local_baseline(self):
        samples = [
            {
                "timestamp": f"2026-05-07T10:00:{second:02d}+00:00",
                "sensor_type": "mock_magnetometer",
                "value": value,
                "unit": "uT",
            }
            for second, value in enumerate([44.8, 45.1, 45.0, 45.2, 70.5, 45.1, 44.9])
        ]

        anomalies = detect_sensor_anomalies(samples)

        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["sensor_type"], "mock_magnetometer")
        self.assertEqual(anomalies[0]["timestamp"], "2026-05-07T10:00:04+00:00")
        self.assertEqual(anomalies[0]["severity"], "high")
        self.assertGreater(anomalies[0]["deviation"], 20)
        self.assertIn("baseline", anomalies[0]["reason"].lower())

    def test_ignores_streams_without_enough_baseline_samples(self):
        anomalies = detect_sensor_anomalies(
            [
                {"timestamp": "a", "sensor_type": "temperature", "value": 21.0, "unit": "C"},
                {"timestamp": "b", "sensor_type": "temperature", "value": 31.0, "unit": "C"},
            ]
        )

        self.assertEqual(anomalies, [])

    def test_uses_vector_magnitude_for_axis_samples(self):
        samples = []
        for index, axes in enumerate([(1, 2, 2), (1, 2, 2), (1, 2, 2), (1, 2, 2), (16, 1, 1)]):
            x, y, z = axes
            samples.append(
                {
                    "timestamp": f"t{index}",
                    "sensor_type": "accelerometer",
                    "x": x,
                    "y": y,
                    "z": z,
                    "unit": "g",
                }
            )

        anomalies = detect_sensor_anomalies(samples)

        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["timestamp"], "t4")
        self.assertEqual(anomalies[0]["metric"], "magnitude")


if __name__ == "__main__":
    unittest.main()
