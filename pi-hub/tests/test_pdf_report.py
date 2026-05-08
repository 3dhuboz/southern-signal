import tempfile
import unittest
from pathlib import Path

from app.analysis.pdf_report import build_evidence_pdf, render_pdf_bytes
from app.store import InvestigationStore


class PdfReportTests(unittest.TestCase):
    def test_build_evidence_pdf_writes_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("PDF report test", location_name="Old Mill")
            store.add_marker(investigation["id"], "Calibration passed", "Compass and room baseline checked.")
            for index, value in enumerate([45.0, 45.1, 44.9, 45.2, 68.0, 45.0]):
                store.add_sensor_sample(
                    investigation_id=investigation["id"],
                    sensor_type="mock_magnetometer",
                    value=value,
                    unit="uT",
                    timestamp=f"2026-05-07T10:00:{index:02d}+00:00",
                )
            store.add_media_asset(
                investigation_id=investigation["id"],
                media_type="image",
                file_path="media/camera/placeholder.png",
                timestamp_start="2026-05-07T10:00:04+00:00",
                metadata={"recorder": "placeholder_camera"},
            )

            pdf_path = build_evidence_pdf(store, investigation["id"])

            self.assertTrue(pdf_path.exists())
            self.assertGreater(pdf_path.stat().st_size, 0)
            data = pdf_path.read_bytes()
            self.assertTrue(data.startswith(b"%PDF-"))
            self.assertIn(b"%%EOF", data)
            self.assertEqual(pdf_path.parent, store.session_dir(investigation["id"]).resolve())

    def test_build_evidence_pdf_respects_output_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Custom dir report")
            store.add_marker(investigation["id"], "Calibration passed", "baseline.")

            override_dir = root / "exports"
            pdf_path = build_evidence_pdf(store, investigation["id"], output_dir=override_dir)

            self.assertTrue(pdf_path.exists())
            self.assertEqual(pdf_path.parent, override_dir.resolve())
            self.assertTrue(pdf_path.read_bytes().startswith(b"%PDF-"))

    def test_render_pdf_bytes_contains_title(self):
        report = {
            "investigation": {
                "id": "abc-123",
                "title": "My Title",
                "status": "stopped",
                "location_name": "Hall",
                "started_at": "2026-05-07T10:00:00+00:00",
                "ended_at": "2026-05-07T11:00:00+00:00",
            },
            "counts": {"samples": 0, "events": 0, "media": 0, "anomalies": 0},
            "anomalies": [],
            "events": [],
            "media": [],
            "confidence": {"score": 0, "label": "weak", "reasons": []},
            "review_windows": [],
            "review_next_steps": ["Review"],
        }

        data = render_pdf_bytes(report)

        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertIn(b"%%EOF", data)
        self.assertIn(b"My Title", data)
        self.assertIn(b"abc-123", data)

    def test_render_pdf_bytes_paginates_long_reports(self):
        anomalies = [
            {
                "timestamp": f"2026-05-07T10:00:{index:02d}+00:00",
                "sensor_type": "mock_magnetometer",
                "metric": "value",
                "value": 50.0 + index,
                "baseline": 45.0,
                "deviation": 5.0 + index,
                "unit": "uT",
                "severity": "medium",
                "reason": (
                    "mock_magnetometer deviated from local baseline by an unusually "
                    "large magnitude during the controlled walk-through."
                ),
            }
            for index in range(50)
        ]
        review_windows = [
            {
                "timestamp": anomaly["timestamp"],
                "start": anomaly["timestamp"],
                "end": anomaly["timestamp"],
                "severity": anomaly["severity"],
                "title": f"{anomaly['sensor_type']} anomaly",
                "reason": anomaly["reason"],
                "anomaly": anomaly,
                "events": [],
                "media": [],
            }
            for anomaly in anomalies[:10]
        ]
        report = {
            "investigation": {
                "id": "long-report",
                "title": "Long report",
                "status": "stopped",
            },
            "counts": {
                "samples": 200,
                "events": 5,
                "media": 2,
                "anomalies": len(anomalies),
            },
            "anomalies": anomalies,
            "events": [],
            "media": [],
            "confidence": {
                "score": 30,
                "label": "weak",
                "reasons": [f"reason {i}" for i in range(8)],
            },
            "review_windows": review_windows,
            "review_next_steps": ["Step one", "Step two", "Step three"],
        }

        data = render_pdf_bytes(report)

        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertIn(b"%%EOF", data)
        page_object_count = data.count(b"/Type /Page ")
        self.assertGreater(page_object_count, 1)

    def test_render_pdf_bytes_escapes_special_characters(self):
        report = {
            "investigation": {
                "id": "esc-1",
                "title": "Site (north) \\ backslash",
                "status": "stopped",
            },
            "counts": {"samples": 0, "events": 0, "media": 0, "anomalies": 0},
            "anomalies": [],
            "events": [],
            "media": [],
            "confidence": {"score": 0, "label": "weak", "reasons": []},
            "review_windows": [],
            "review_next_steps": [],
        }

        data = render_pdf_bytes(report)

        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertIn(b"\\(north\\)", data)
        self.assertIn(b"\\\\", data)


if __name__ == "__main__":
    unittest.main()
