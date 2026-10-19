import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GitsignWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.wrapper = self.root / 'wrapper/gitsign'
        self.wrapper.parent.mkdir()
        shutil.copyfile(ROOT / 'bin/gitsign-wrapper', self.wrapper)
        self.wrapper.chmod(0o755)
        self.signer = self.root / 'fallback/gitsign'
        self.signer.parent.mkdir()
        self.signer.write_text(
            f'#!{sys.executable}\n'
            'import json, os, sys\n'
            'print(json.dumps({"home": os.environ["HOME"], "args": sys.argv[1:], '
            '"signer": sys.argv[0], "cache": os.environ.get("GITSIGN_CREDENTIAL_CACHE")}))\n'
            'sys.exit(int(os.environ.get("TEST_EXIT_CODE", "0")))\n'
        )
        self.signer.chmod(0o755)
        self.config = self.root / 'gitconfig'
        self.config.touch()
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('GIT_', 'GITSIGN_', 'SIGSTORE_', '_GITSIGN_'))}
        self.env.update(
            GIT_CONFIG_GLOBAL=str(self.config), GIT_CONFIG_NOSYSTEM='1',
            PATH=f'{self.wrapper.parent}:{self.signer.parent}:/usr/bin:/bin',
            GITSIGN_CREDENTIAL_CACHE='/test/cache.sock',
        )

    def configure(self, key, value):
        subprocess.run(['git', 'config', '--file', str(self.config), key, value], check=True)

    def run_wrapper(self, *args):
        return subprocess.run([str(self.wrapper), *args], cwd=self.root, env=self.env,
                              capture_output=True, text=True, timeout=5)

    def test_configured_signer_preserves_home_arguments_and_environment(self):
        configured = self.root / 'fork signer'
        shutil.copyfile(self.signer, configured)
        configured.chmod(0o755)
        self.configure('gpg.x509.program', str(configured))
        result = self.run_wrapper('--sign', 'a file', '$(not-a-command)')
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['signer'], str(configured))
        self.assertEqual(output['home'], os.environ['HOME'])
        self.assertEqual(output['args'], ['--sign', 'a file', '$(not-a-command)'])
        self.assertEqual(output['cache'], '/test/cache.sock')

    def test_auth_settings_preserve_home(self):
        self.configure('gpg.x509.program', 'gitsign')
        self.configure('gitsign.connectorID', 'https://accounts.google.com')
        result = self.run_wrapper('version')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['home'], os.environ['HOME'])

    def test_wrapper_alias_does_not_recurse(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.wrapper)
        self.configure('gpg.x509.program', str(alias))
        self.env['GITSIGN_WRAP_ENABLE'] = 'false'
        result = self.run_wrapper('version')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['signer'], str(self.signer))
        self.assertEqual(json.loads(result.stdout)['home'], os.environ['HOME'])

    def test_missing_configured_signer_fails(self):
        self.configure('gpg.x509.program', str(self.root / 'missing'))
        result = self.run_wrapper('version')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('configured signer not found', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_exit_status_preserved(self):
        self.configure('gpg.x509.program', str(self.signer))
        self.env['TEST_EXIT_CODE'] = '23'
        self.assertEqual(self.run_wrapper().returncode, 23)

    def test_legacy_fallback_cleans_up_temporary_home(self):
        self.env['TEST_EXIT_CODE'] = '23'
        result = self.run_wrapper('version')
        self.assertEqual(result.returncode, 23, result.stderr)
        output = json.loads(result.stdout)
        product = Path('/sys/class/dmi/id/product_name')
        if product.exists() and product.read_text().strip() == 'Google Compute Engine':
            self.assertNotEqual(output['home'], os.environ['HOME'])
            self.assertFalse(Path(output['home']).exists())
        else:
            self.assertEqual(output['home'], os.environ['HOME'])


if __name__ == '__main__':
    unittest.main()
