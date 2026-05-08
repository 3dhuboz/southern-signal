import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from app.exporter import build_export_zip
from app.sensors.registry import SensorRegistry
from app.store import InvestigationStore


class HardwareStatusTests(unittest.TestCase):
    def test_sensor_registry_reports_mock_available_and_sense_hat_optional(self):
        registry = SensorRegistry()

        status = registry.status()

        providers = {provider["name"]: provider for provider in status["providers"]}
        self.assertTrue(providers["mock"]["available"])
        self.assertIn("sense_hat", providers)
        self.assertIn("active_provider", status)

    def test_registry_reads_samples_from_active_provider(self):
        registry = SensorRegistry(preferred_provider="mock")

        readings = registry.read()

        sensor_types = {reading["sensor_type"] for reading in readings}
        self.assertIn("temperature", sensor_types)
        self.assertIn("mock_magnetometer", sensor_types)

    def test_export_includes_hardware_status_manifest(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Hardware manifest")
            store.start_investigation(investigation["id"])
            archive = build_export_zip(
                store,
                investigation["id"],
                hardware_status={"active_provider": "mock", "providers": [{"name": "mock", "available": True}]},
            )

            with zipfile.ZipFile(archive) as zipped:
                manifest = json.loads(zipped.read("hardware_status.json"))

            self.assertEqual(manifest["active_provider"], "mock")
            self.assertTrue(manifest["providers"][0]["available"])


if __name__ == "__main__":
    unittest.main()
