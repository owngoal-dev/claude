#!/usr/bin/env python3
"""Exercise update decisions and rollback without downloading a binary."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class FollowUpstreamTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        source = Path(__file__).resolve().parents[1]
        for name in ("configuration", "scripts", "packaging", "shim", "docs"):
            shutil.copytree(source / name, self.root / name)
        shutil.copy(source / "makefile", self.root)
        self.config = self.root / "configuration/upstream.env"
        self.version = self.root / "configuration/version.txt"
        self.config.write_text(
            "UPSTREAM_PACKAGE=@example/cli\nUPSTREAM_VERSION=1.2.3\n"
            "UPSTREAM_INTEGRITY=reviewed\nMIN_IOS=15.0\n"
        )
        self.version.write_text("1.2.3-2\n")
        self.original = self.config.read_bytes(), self.version.read_bytes()
        mock_bin = self.root / "mock-bin"
        mock_bin.mkdir()
        commands = {
            "npm": '#!/bin/bash\nprintf "%s\\n" "$TEST_METADATA"\n',
            "make": '#!/bin/bash\n[[ -f "$2/docs/depiction.json" ]] || exit 90\nexit "$TEST_BUILD_EXIT"\n',
        }
        for name, contents in commands.items():
            path = mock_bin / name
            path.write_text(contents)
            path.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{mock_bin}:{os.environ['PATH']}", TEST_BUILD_EXIT="0")

    def run_update(self, version="1.2.4", integrity=None, arguments=(), build_exit=0):
        self.env["TEST_METADATA"] = json.dumps({
            "version": version,
            "dist.integrity": integrity if integrity is not None else "sha512-" + "A" * 86 + "==",
        })
        self.env["TEST_BUILD_EXIT"] = str(build_exit)
        return subprocess.run(
            ["bash", str(self.root / "scripts/follow-upstream.sh"), *arguments],
            env=self.env, text=True, capture_output=True, check=False,
        )

    def assert_unchanged(self):
        self.assertEqual(self.original, (self.config.read_bytes(), self.version.read_bytes()))

    def test_success_changes_only_version_pins(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.version.read_text(), "1.2.4\n")
        self.assertEqual(self.config.read_text(), (
            "UPSTREAM_PACKAGE=@example/cli\nUPSTREAM_VERSION=1.2.4\n"
            "UPSTREAM_INTEGRITY=sha512-" + "A" * 86 + "==\nMIN_IOS=15.0\n"
        ))

    def test_build_failure_preserves_both_pins(self):
        self.assertNotEqual(self.run_update(build_exit=65).returncode, 0)
        self.assert_unchanged()

    def test_same_or_older_preserves_packaging_respin(self):
        for version in ("1.2.3", "1.2.2"):
            self.assertEqual(self.run_update(version).returncode, 0)
            self.assert_unchanged()

    def test_check_reports_update_without_writing(self):
        self.assertEqual(self.run_update(arguments=("--check",)).returncode, 1)
        self.assert_unchanged()

    def test_unstable_or_invalid_metadata_is_rejected(self):
        for version, integrity in (("1.2.4-beta.1", None), ("1.2.4", "bad")):
            self.assertNotEqual(self.run_update(version, integrity).returncode, 0)
            self.assert_unchanged()


if __name__ == "__main__":
    unittest.main()
