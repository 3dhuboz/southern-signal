import unittest

from app.analysis.review_windows import build_review_windows


class ReviewWindowTests(unittest.TestCase):
    def test_builds_replay_window_around_anomaly_with_nearby_events_and_media(self):
        anomalies = [
            {
                "timestamp": "2026-05-07T10:00:30+00:00",
                "sensor_type": "mock_magnetometer",
                "severity": "high",
                "reason": "Magnetic spike above baseline.",
            }
        ]
        events = [
            {
                "timestamp": "2026-05-07T10:00:20+00:00",
                "event_type": "marker",
                "title": "Question asked",
            },
            {
                "timestamp": "2026-05-07T10:04:00+00:00",
                "event_type": "marker",
                "title": "Too late",
            },
        ]
        media = [
            {
                "timestamp_start": "2026-05-07T10:00:35+00:00",
                "media_type": "image",
                "file_path": "media/camera/still.png",
            }
        ]

        windows = build_review_windows(anomalies, events, media, window_seconds=20)

        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["start"], "2026-05-07T10:00:10+00:00")
        self.assertEqual(windows[0]["end"], "2026-05-07T10:00:50+00:00")
        self.assertEqual(len(windows[0]["events"]), 1)
        self.assertEqual(len(windows[0]["media"]), 1)


if __name__ == "__main__":
    unittest.main()
