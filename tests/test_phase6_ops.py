import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

OPS = Path(__file__).resolve().parents[1] / "tools" / "ops"
sys.path.insert(0, str(OPS))
import ops_core


def load_script(name, module_name):
    spec = importlib.util.spec_from_file_location(module_name, OPS / name)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


monitor = load_script("monitor-school-hosted.py", "termly_monitor_phase6")
support = load_script("build-support-bundle.py", "termly_support_phase6")


class OpsCoreTests(unittest.TestCase):
    def test_overall_status_precedence(self):
        self.assertEqual(ops_core.overall_status([{"status": "ok"}, {"status": "ok"}]), "healthy")
        self.assertEqual(ops_core.overall_status([{"status": "ok"}, {"status": "warning"}]), "degraded")
        self.assertEqual(ops_core.overall_status([{"status": "warning"}, {"status": "critical"}]), "critical")

    def test_public_status_is_allowlisted(self):
        result = ops_core.public_status_document([{
            "id": "BACKEND/DB",
            "label": "Database",
            "status": "ok",
            "message": "Running",
            "password": "DO_NOT_PUBLISH",
            "connectionString": "postgres://secret",
        }])
        self.assertEqual(result["checks"][0]["id"], "backenddb")
        rendered = json.dumps(result)
        self.assertNotIn("DO_NOT_PUBLISH", rendered)
        self.assertNotIn("connectionString", rendered)
        self.assertEqual(result["overall"], "healthy")

    def test_env_file_is_parsed_as_data_not_executed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "executed"
            config = root / "monitor.env"
            config.write_text(f"TOKEN='safe value'\nUNTRUSTED=$(touch {marker})\n", encoding="utf-8")
            os.chmod(config, 0o600)
            values = ops_core.parse_env_file(config)
            self.assertEqual(values["TOKEN"], "safe value")
            self.assertIn("$(touch", values["UNTRUSTED"])
            self.assertFalse(marker.exists())

    def test_env_file_rejects_group_or_world_permissions(self):
        if os.name == "nt":
            self.skipTest("POSIX file permissions not supported on Windows")
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "monitor.env"
            config.write_text("A=1\n", encoding="utf-8")
            os.chmod(config, 0o644)
            with self.assertRaises(PermissionError):
                ops_core.parse_env_file(config)

    def test_update_status_drops_unrecognised_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "status.json"
            path.write_text(json.dumps({
                "product": "termly", "version": "1.2.3", "channel": "stable",
                "serviceRoleKey": "SECRET", "databaseUrl": "postgres://private",
                "migrationCount": 2,
            }), encoding="utf-8")
            result = ops_core.safe_update_status(path)
            rendered = json.dumps(result)
            self.assertIn('"version": "1.2.3"', rendered)
            self.assertNotIn("SECRET", rendered)
            self.assertNotIn("databaseUrl", rendered)

    def test_backup_metadata_does_not_expose_filename(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "termly-schoolhosted-secret-school-label.tar.gz.age"
            path.write_bytes(b"encrypted")
            result = ops_core.backup_metadata(temporary)
            self.assertTrue(result["available"])
            self.assertEqual(result["count"], 1)
            self.assertNotIn("secret-school-label", json.dumps(result))


class MonitorTests(unittest.TestCase):
    def test_web_healthy(self):
        with tempfile.TemporaryDirectory() as temporary:
            web_dir = Path(temporary)
            (web_dir / "compose.yml").write_text("services: {}\n", encoding="utf-8")
            with mock.patch.object(monitor, "run", side_effect=[
            mock.Mock(returncode=0, stdout="container-123\n", stderr=""),
                mock.Mock(returncode=0, stdout="running|healthy", stderr=""),
            ]):
                result = monitor.check_web({}, web_dir)
            self.assertEqual(result["status"], "ok")

    def test_web_missing_container_is_critical(self):
        with mock.patch.object(monitor, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            result = monitor.check_web({}, Path("/fake"))
        self.assertEqual(result["status"], "critical")

    def test_endpoint_rejects_non_https(self):
        result = monitor.check_endpoint({"TERMLY_HEALTH_URL": "http://termly.school/healthz"})
        self.assertEqual(result["status"], "critical")

    def test_alert_payload_contains_no_webhook_secret(self):
        captured = {}
        class FakeResponse:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
        def fake_open(request, timeout=None):
            captured["data"] = request.data.decode("utf-8")
            return FakeResponse()
        with mock.patch.object(monitor.urllib.request, "urlopen", side_effect=fake_open):
            ok, _ = monitor.send_alert("https://hooks.example/very-secret-token", "critical", "healthy", "Checks needing attention: Termly web app")
        self.assertTrue(ok)
        self.assertNotIn("very-secret-token", captured["data"])
        self.assertIn("CRITICAL", captured["data"])


class SupportBundleTests(unittest.TestCase):
    def test_compose_status_parser_accepts_array_json(self):
        with mock.patch.object(support, "capture", return_value='[{"Service":"db","State":"running","Health":"healthy"}]'):
            rows = support.parse_compose_status(Path("/not-used.yml"), None)
        self.assertEqual(rows, [{"service": "db", "state": "running", "health": "healthy"}])

    def test_bundle_is_encrypted_and_contains_only_operational_metadata(self):
        if not hasattr(os, "geteuid") or os.geteuid() != 0:
            self.skipTest("support bundle intentionally requires root")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            web = root / "web"
            runtime = web / "runtime"
            runtime.mkdir(parents=True)
            supabase = root / "supabase"
            supabase.mkdir()
            backup_config = root / "backup.env"
            backup_config.write_text(f"SUPABASE_DIR={supabase}\nBACKUP_DIR={root}/backups\n", encoding="utf-8")
            os.chmod(backup_config, 0o600)
            monitor_config = root / "monitor.env"
            monitor_config.write_text(
                f"TERMLY_WEB_DIR={web}\nTERMLY_WEB_COMPOSE_FILE={web}/compose.yml\n"
                f"TERMLY_WEB_ENV_FILE={web}/.env\nTERMLY_BACKUP_ENV={backup_config}\n"
                f"TERMLY_ALERT_WEBHOOK_URL=https://hooks.example/SECRET_TOKEN\n",
                encoding="utf-8",
            )
            os.chmod(monitor_config, 0o600)
            output = root / "bundle.tar.gz.age"

            def fake_run(command, **kwargs):
                if Path(command[0]).name == "age":
                    destination = Path(command[command.index("--output") + 1])
                    source = Path(command[-1])
                    destination.write_bytes(source.read_bytes())  # fake encryption for structure test only
                    return mock.Mock(returncode=0, stdout="", stderr="")
                return mock.Mock(returncode=127, stdout="", stderr="")

            with mock.patch.object(support.shutil, "which", return_value="/usr/bin/age"), \
                 mock.patch.object(support.subprocess, "run", side_effect=fake_run):
                result = support.build_support_bundle(str(monitor_config), "age1" + "a" * 58, str(output), root)

            self.assertTrue(result.is_file())
            self.assertTrue(Path(str(output) + ".sha256").is_file())
            with tarfile_open(result) as archive:
                names = archive.getnames()
                self.assertNotIn(".env", names)
                self.assertFalse(any("log" in name.lower() for name in names))
                body = b"".join(archive.extractfile(name).read() for name in names if archive.extractfile(name))
                self.assertNotIn(b"SECRET_TOKEN", body)
                self.assertNotIn(b"serviceRoleKey", body)
                self.assertNotIn(b"real student row", body.lower())


def tarfile_open(path):
    import tarfile
    return tarfile.open(path, "r:gz")


if __name__ == "__main__":
    unittest.main(verbosity=2)
