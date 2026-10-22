import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SETUP = Path(__file__).resolve().parents[1] / "bin/setup-codex"


class CodexSetupTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home with spaces"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.prefix_file = self.root / "prefix"
        self.calls = self.root / "calls.json"
        self.calls.write_text("[]")
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{self.bin}:/usr/bin:/bin",
                        TEST_PREFIX=str(self.prefix_file), TEST_CALLS=str(self.calls))
        self.env.pop("NPM_CONFIG_PREFIX", None)
        self.env.pop("npm_config_prefix", None)
        (self.bin / "node").write_text("#!/bin/sh\nexit 0\n")
        (self.bin / "node").chmod(0o755)
        (self.bin / "npm").write_text(f"#!{sys.executable}\n" + '''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
calls = Path(os.environ["TEST_CALLS"])
calls.write_text(json.dumps(json.loads(calls.read_text()) + [args]))
prefix_file = Path(os.environ["TEST_PREFIX"])
prefix = os.environ.get("NPM_CONFIG_PREFIX") or prefix_file.read_text()
if args == ["config", "get", "prefix"]:
    print(prefix)
elif args[:3] == ["config", "set", "prefix"]:
    prefix_file.write_text(args[3])
elif args[:2] == ["install", "--global"]:
    if os.environ.get("TEST_INSTALL_FAIL"):
        sys.exit(1)
    target = Path(prefix) / "bin/codex"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("#!/bin/sh\\necho codex-cli-test\\n")
    target.chmod(0o755)
else:
    sys.exit(2)
''')
        (self.bin / "npm").chmod(0o755)

    def run_setup(self):
        return subprocess.run(["bash", str(SETUP)], env=self.env, capture_output=True, text=True)

    def test_readonly_prefix_migrates_and_rerun_skips_install(self):
        self.prefix_file.write_text("/sys/dotfiles-npm-test")
        for _ in range(2):
            result = self.run_setup()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("codex-cli-test", result.stdout)
        self.assertEqual(self.prefix_file.read_text(), str(self.home / ".local"))
        calls = json.loads(self.calls.read_text())
        self.assertEqual(sum(call[:2] == ["install", "--global"] for call in calls), 1)
        self.assertEqual(sum(call[:3] == ["config", "set", "prefix"] for call in calls), 1)

    def test_writable_version_manager_prefix_is_preserved(self):
        prefix = self.home / ".nvm/versions/node/v22"
        prefix.mkdir(parents=True)
        self.prefix_file.write_text(str(prefix))
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((prefix / "bin/codex").exists())
        self.assertEqual(self.prefix_file.read_text(), str(prefix))
        self.assertFalse(any(call[:2] == ["config", "set"] for call in json.loads(self.calls.read_text())))

    def test_environment_override_fails_without_installing(self):
        self.prefix_file.write_text("/sys/dotfiles-npm-test")
        self.env["NPM_CONFIG_PREFIX"] = "/sys/dotfiles-npm-override"
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NPM_CONFIG_PREFIX", result.stderr)
        self.assertFalse(any(call[0] == "install" for call in json.loads(self.calls.read_text())))

    def test_install_failure_is_reported(self):
        self.prefix_file.write_text(str(self.home / ".local"))
        self.env["TEST_INSTALL_FAIL"] = "1"
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Codex updates:", result.stdout)

    def test_existing_codex_preserves_npm_and_does_not_install(self):
        codex = self.bin / 'codex'
        codex.write_text('#!/bin/sh\necho existing-codex\n')
        codex.chmod(0o755)
        (self.bin / 'node').unlink()
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('existing-codex', result.stdout)
        self.assertEqual(json.loads(self.calls.read_text()), [])
        self.assertFalse(self.prefix_file.exists())

    def test_broken_existing_codex_is_not_automatically_replaced(self):
        codex = self.bin / 'codex'
        codex.write_text('#!/bin/sh\nexit 9\n')
        codex.chmod(0o755)
        result = self.run_setup()
        self.assertEqual(result.returncode, 9)
        self.assertEqual(json.loads(self.calls.read_text()), [])


if __name__ == "__main__":
    unittest.main()
