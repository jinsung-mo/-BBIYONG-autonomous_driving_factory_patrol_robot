import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bbiyong_bringup.commissioning_artifacts import (
    collect_evidence,
    redact_text,
    redact_value,
)
from bbiyong_bringup.release_manager import (
    activate_release,
    stage_release,
    verify_release,
)


class RedactionTest(unittest.TestCase):
    def test_redacts_common_secret_forms(self):
        value = redact_text(
            "password=hunter2 token: abc Bearer xyz.123 "
            "https://robot:secret@example.test/path"
        )
        self.assertNotIn("hunter2", value)
        self.assertNotIn("abc", value)
        self.assertNotIn("xyz.123", value)
        self.assertNotIn("robot:secret", value)

    def test_redacts_nested_secret_keys(self):
        payload = redact_value({"safe": "ok", "apiToken": "secret", "nested": {"pwd": "x"}})
        self.assertEqual(payload["safe"], "ok")
        self.assertEqual(payload["apiToken"], "<redacted>")
        self.assertEqual(payload["nested"]["pwd"], "<redacted>")

    def test_evidence_is_atomic_hashed_and_redacted(self):
        command_result = {
            "command": "probe --token=raw-token",
            "returnCode": 0,
            "timedOut": False,
            "durationSec": 0.1,
            "output": "Authorization: Bearer raw-token",
        }
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "evidence"
            with patch(
                "bbiyong_bringup.commissioning_artifacts._run",
                return_value=command_result,
            ), patch.dict(
                "os.environ",
                {
                    "ORINCAR_NAVIGATION_ENABLED": "1",
                    "ORINCAR_PATROL_LOOP_ENABLED": "0",
                },
                clear=True,
            ):
                collect_evidence("base-runtime", output)
            self.assertTrue((output / "sha256.json").is_file())
            text = (output / "commands.json").read_text(encoding="utf-8")
            self.assertNotIn("raw-token", text)
            metadata = json.loads((output / "metadata.json").read_text())
            self.assertEqual(metadata["stage"], "base-runtime")
            self.assertTrue(metadata["capabilities"]["patrol"])
            self.assertFalse(metadata["capabilities"]["patrolLoop"])
            with self.assertRaises(FileExistsError):
                collect_evidence("base-runtime", output)


class ReleaseManagerTest(unittest.TestCase):
    def make_source(self, root):
        source = root / "BE_robot"
        files = {
            "orin_dashboard/cloud_bridge.py": "bridge",
            "orin_dashboard/.env": "PASSWORD=do-not-copy",
            "ros2_ws/dependencies.repos": "repositories: {}",
            "ros2_ws/docs/PHASE7.md": "runbook",
            "ros2_ws/README.md": "readme",
            "ros2_ws/scripts/bbiyong": "#!/bin/bash",
            "ros2_ws/src/pkg/package.xml": "<package/>",
            "ros2_ws/src/pkg/__pycache__/bad.pyc": "cache",
        }
        for relative, content in files.items():
            path = source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return source

    def test_stage_is_allowlisted_redacted_and_hash_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = stage_release(self.make_source(root), root / "deploy", "abc123")
            self.assertTrue((target / "release-manifest.json").is_file())
            self.assertFalse((target / "orin_dashboard/.env").exists())
            self.assertFalse(any("__pycache__" in path.parts for path in target.rglob("*")))
            self.assertEqual(verify_release(target)["releaseId"], "abc123")

    def test_verify_rejects_modified_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = stage_release(self.make_source(root), root / "deploy", "abc123")
            (target / "orin_dashboard/cloud_bridge.py").write_text("modified")
            with self.assertRaises(ValueError):
                verify_release(target)

    def test_activation_requires_both_operator_safety_confirmations(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "confirm-stopped"):
                activate_release(directory, "abc123", operator="operator")
            with self.assertRaisesRegex(ValueError, "confirm-independent-stop"):
                activate_release(
                    directory, "abc123", confirm_stopped=True,
                    operator="operator",
                )


if __name__ == "__main__":
    unittest.main()
