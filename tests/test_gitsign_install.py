import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GitsignInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'home with spaces'
        self.home.mkdir()
        self.bin = self.home / 'mock-bin'
        self.bin.mkdir()
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('GIT_', 'GITSIGN_', 'GO'))}
        self.env.update(HOME=str(self.home), GIT_CONFIG_NOSYSTEM='1',
                        PATH=f'{self.bin}:/usr/bin:/bin',
                        GIT_AUTHOR_NAME='Test', GIT_AUTHOR_EMAIL='test@example.com',
                        GIT_COMMITTER_NAME='Test', GIT_COMMITTER_EMAIL='test@example.com')
        self.origin = self.home / 'origin'
        self.run_git('init', '-q', str(self.origin))
        (self.origin / 'go.mod').write_text('module example.test/gitsign\n')
        self.run_git('-C', str(self.origin), 'add', '.')
        self.run_git('-C', str(self.origin), '-c', 'commit.gpgSign=false',
                     'commit', '-qm', 'pinned')
        self.revision = self.run_git('-C', str(self.origin), 'rev-parse', 'HEAD')
        (self.origin / 'go.mod').write_text('module example.test/newer\n')
        self.run_git('-C', str(self.origin), '-c', 'commit.gpgSign=false',
                     'commit', '-qam', 'newer')
        self.env.update(GITSIGN_REPOSITORY=str(self.origin), GITSIGN_REVISION=self.revision)
        self.checkout = self.home / 'github/fritzy/gitsign'
        self.install_dir = self.home / '.local/lib/gitsign'
        self.log = self.home / 'commands.jsonl'
        self.write_tool('go', '''
args = sys.argv[1:]
with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as f:
    f.write(json.dumps(['go', os.environ['GOTOOLCHAIN'], *args]) + '\\n')
if os.environ.get('TEST_BUILD_FAILURE'):
    sys.exit(9)
target = Path(args[args.index('-o') + 1])
target.write_text('#!/bin/sh\\n# ' + os.environ['GITSIGN_REVISION'] + '\\nexit 0\\n')
target.chmod(0o755)
''')
        self.write_tool('systemctl', '''
args = sys.argv[1:]
with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as f:
    f.write(json.dumps(['systemctl', *args]) + '\\n')
if 'show-environment' in args and os.environ.get('TEST_NO_BUS'):
    sys.exit(1)
''')

    def write_tool(self, name, body):
        p = self.bin / name
        p.write_text(f'#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n' + body)
        p.chmod(0o755)

    def run_git(self, *args):
        return subprocess.check_output(['git', *args], env=self.env, text=True).strip()

    def config(self, key, *values):
        return self.run_git('config', '--global', key, *values)

    def install(self):
        return subprocess.run(['bash', str(ROOT / 'bin/install-gitsign-fork')],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_fresh_install_pins_source_and_configures_signing_and_service(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.run_git('-C', str(self.checkout), 'rev-parse', 'HEAD'), self.revision)
        self.assertEqual(self.config('gpg.x509.program'), str(self.install_dir / 'gitsign'))
        for key, value in {
            'gpg.format': 'x509', 'commit.gpgSign': 'true', 'tag.gpgSign': 'true',
            'gitsign.rekorMode': 'offline', 'gitsign.credentialCache': 'auto',
            'gitsign.connectorID': 'https://accounts.google.com',
            'gitsign.loginHint': 'nathan.fritz@chainguard.dev',
        }.items():
            self.assertEqual(self.config(key), value)
        self.assertEqual((self.home / '.local/bin/gitsign').resolve(), self.install_dir / 'gitsign')
        self.assertIn(['systemctl', '--user', 'enable', '--now', 'gitsign-credential-cache.service'], self.commands())
        builds = [c for c in self.commands() if c[0] == 'go']
        self.assertEqual(len(builds), 2)
        self.assertTrue(all(c[1] == 'go1.27.1' and '-mod=readonly' in c for c in builds))

    def test_repeat_preserves_identity_and_does_not_restart_cache(self):
        self.config('gitsign.loginHint', 'other@example.com')
        self.config('gitsign.connectorID', 'custom-connector')
        self.config('gitsign.urlOpener', 'custom-opener {{.URL}}')
        self.assertEqual(self.install().returncode, 0)
        old_inode = (self.install_dir / 'gitsign-credential-cache').stat().st_ino
        self.log.write_text('')
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config('gitsign.loginHint'), 'other@example.com')
        self.assertEqual(self.config('gitsign.connectorID'), 'custom-connector')
        self.assertEqual(self.config('gitsign.urlOpener'), 'custom-opener {{.URL}}')
        self.assertEqual((self.install_dir / 'gitsign-credential-cache').stat().st_ino, old_inode)
        self.assertFalse(any('restart' in c for c in self.commands()))

    def test_dirty_checkout_is_preserved(self):
        self.assertEqual(self.install().returncode, 0)
        (self.checkout / 'go.mod').write_text('local changes\n')
        self.log.write_text('')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Preserving local changes', result.stderr)
        self.assertEqual((self.checkout / 'go.mod').read_text(), 'local changes\n')
        self.assertEqual(self.commands(), [])

    def test_wrong_origin_is_preserved(self):
        self.assertEqual(self.install().returncode, 0)
        self.run_git('-C', str(self.checkout), 'remote', 'set-url', 'origin', '/another/repo')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('different origin', result.stderr)

    def test_build_failure_preserves_installed_signer_and_configuration(self):
        self.assertEqual(self.install().returncode, 0)
        before = (self.home / '.gitconfig').read_bytes()
        old_inode = (self.install_dir / 'gitsign').stat().st_ino
        self.env['TEST_BUILD_FAILURE'] = '1'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.home / '.gitconfig').read_bytes(), before)
        self.assertEqual((self.install_dir / 'gitsign').stat().st_ino, old_inode)
        self.assertEqual(list(self.install_dir.glob('.build.*')), [])

    def test_no_user_bus_leaves_unit_ready_for_next_session(self):
        self.env['TEST_NO_BUS'] = '1'
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('start it in a user session', result.stdout)
        self.assertTrue((self.home / '.config/systemd/user/gitsign-credential-cache.service').is_file())
        self.assertFalse(any('enable' in c for c in self.commands()))


if __name__ == '__main__':
    unittest.main()
