import unittest

from fastapi.testclient import TestClient

from app.main import app


class ApiTests(unittest.TestCase):
    def test_app_state_endpoint_returns_gui_metadata(self):
        with TestClient(app) as client:
            before = client.get("/api/app-state").json()
            created = client.post("/api/investigations", json={"title": "App state test"}).json()
            client.post(f"/api/investigations/{created['id']}/start")

            response = client.get("/api/app-state")
            client.post(f"/api/investigations/{created['id']}/stop")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["service"], "southern-signal-pi-hub")
        self.assertIsInstance(payload["app_version"], str)
        self.assertGreaterEqual(len(payload["app_version"]), 1)
        self.assertEqual(payload["investigation_count"], before["investigation_count"] + 1)
        self.assertEqual(payload["running_investigation_count"], before["running_investigation_count"] + 1)
        self.assertIn("active_hardware_provider", payload)
        self.assertGreaterEqual(payload["protocol_count"], 3)

    def test_hardware_endpoint_reports_active_provider(self):
        with TestClient(app) as client:
            response = client.get("/api/hardware")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("active_provider", payload)
        self.assertTrue(payload["providers"])

    def test_investigation_detail_includes_counts(self):
        with TestClient(app) as client:
            created = client.post("/api/investigations", json={"title": "API count test"}).json()
            detail = client.get(f"/api/investigations/{created['id']}").json()

        self.assertEqual(detail["event_count"], 0)
        self.assertEqual(detail["sample_count"], 0)

    def test_protocols_endpoint_lists_investigation_workflows(self):
        with TestClient(app) as client:
            response = client.get("/api/protocols")

        self.assertEqual(response.status_code, 200)
        protocol_ids = {protocol["id"] for protocol in response.json()}
        self.assertIn("baseline", protocol_ids)
        self.assertIn("prompted_evp", protocol_ids)

    def test_anomalies_endpoint_returns_detected_sensor_spikes(self):
        with TestClient(app) as client:
            created = client.post("/api/investigations", json={"title": "API anomaly test"}).json()
            investigation_id = created["id"]
            for index, value in enumerate([45.0, 45.1, 44.9, 45.2, 68.0, 45.0]):
                app.state.store.add_sensor_sample(
                    investigation_id=investigation_id,
                    sensor_type="mock_magnetometer",
                    value=value,
                    unit="uT",
                    timestamp=f"2026-05-07T10:00:{index:02d}+00:00",
                )

            response = client.get(f"/api/investigations/{investigation_id}/anomalies")

        self.assertEqual(response.status_code, 200)
        anomalies = response.json()
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["sensor_type"], "mock_magnetometer")

    def test_capture_still_endpoint_creates_image_media_asset(self):
        with TestClient(app) as client:
            created = client.post("/api/investigations", json={"title": "API camera test"}).json()
            investigation_id = created["id"]

            response = client.post(f"/api/investigations/{investigation_id}/camera/still")
            media = client.get(f"/api/investigations/{investigation_id}/media").json()

        self.assertEqual(response.status_code, 200)
        asset = response.json()
        self.assertEqual(asset["media_type"], "image")
        self.assertTrue(any(item["media_type"] == "image" for item in media))

    def test_evidence_report_endpoint_returns_review_summary(self):
        with TestClient(app) as client:
            created = client.post("/api/investigations", json={"title": "API report test"}).json()
            investigation_id = created["id"]
            for index, value in enumerate([45.0, 45.1, 44.9, 45.2, 68.0, 45.0]):
                app.state.store.add_sensor_sample(
                    investigation_id=investigation_id,
                    sensor_type="mock_magnetometer",
                    value=value,
                    unit="uT",
                    timestamp=f"2026-05-07T10:01:{index:02d}+00:00",
                )

            response = client.get(f"/api/investigations/{investigation_id}/evidence-report")

        self.assertEqual(response.status_code, 200)
        report = response.json()
        self.assertEqual(report["counts"]["anomalies"], 1)
        self.assertIn("confidence", report)

    def test_contamination_endpoint_records_ordinary_cause_tag(self):
        with TestClient(app) as client:
            created = client.post("/api/investigations", json={"title": "API contamination test"}).json()
            investigation_id = created["id"]

            response = client.post(
                f"/api/investigations/{investigation_id}/contamination",
                json={
                    "contamination_type": "footsteps",
                    "description": "Investigator walked through hallway.",
                },
            )
            events = client.get(f"/api/investigations/{investigation_id}/events").json()

        self.assertEqual(response.status_code, 200)
        event = response.json()
        self.assertEqual(event["event_type"], "contamination")
        self.assertTrue(any(item["event_type"] == "contamination" for item in events))

    def test_start_session_creates_audio_and_camera_media(self):
        with TestClient(app) as client:
            created = client.post("/api/investigations", json={"title": "Media lifecycle"}).json()
            client.post(f"/api/investigations/{created['id']}/start")
            media = client.get(f"/api/investigations/{created['id']}/media").json()

        media_types = {asset["media_type"] for asset in media}
        self.assertIn("audio", media_types)
        self.assertIn("image", media_types)

    def test_protocols_are_exposed(self):
        with TestClient(app) as client:
            protocols = client.get("/api/protocols").json()
            baseline = client.get("/api/protocols/baseline").json()

        self.assertTrue(any(protocol["id"] == "baseline" for protocol in protocols))
        self.assertEqual(baseline["id"], "baseline")

    def test_evidence_scoring_endpoint_returns_score_and_label(self):
        with TestClient(app) as client:
            response = client.post(
                "/api/evidence/score",
                json={
                    "audio_spike": True,
                    "sensor_correlation_count": 3,
                    "media_support": True,
                    "unattended_room": True,
                    "blind_reviewer_agreement_count": 2,
                    "contamination_count": 0,
                    "calibration_ok": True,
                    "sync_confidence": 0.9,
                },
            )

        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertIn("score", payload)
        self.assertIn(payload["label"], {"weak", "moderate", "strong"})

    def test_contamination_tags_endpoint_and_event_creation(self):
        with TestClient(app) as client:
            created = client.post("/api/investigations", json={"title": "Contamination tag test"}).json()
            tags_response = client.get("/api/contamination-tags")
            event_response = client.post(
                f"/api/investigations/{created['id']}/contamination",
                json={"tag_id": "footstep", "description": "Investigator crossed the room."},
            )
            events = client.get(f"/api/investigations/{created['id']}/events").json()

        self.assertEqual(tags_response.status_code, 200)
        self.assertEqual(event_response.status_code, 200)
        self.assertEqual(event_response.json()["event_type"], "contamination")
        self.assertTrue(any(event["event_type"] == "contamination" for event in events))


if __name__ == "__main__":
    unittest.main()
