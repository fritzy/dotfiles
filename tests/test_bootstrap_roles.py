import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
STOW = os.environ.get('DOTFILES_TEST_STOW') or shutil.which(
    'stow', path='/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin')


class BootstrapRoleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / 'dotfiles checkout'
        self.home = self.base / 'user home'
        self.home.mkdir()
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        (self.repo / 'bin').mkdir(parents=True)
        for name in ('bootstrap.sh', 'bootstrap-worklaptop.sh', 'bootstrap-workstation.sh', 'workstation.sh',
                     'bin/sync-dotfiles', 'bin/sync-ai-skills', 'bin/setup-fritzworks'):
            shutil.copyfile(ROOT / name, self.repo / name)
        for package in ('worklaptop', 'workstation'):
            shutil.copytree(ROOT / package, self.repo / package, symlinks=True)
        (self.repo / 'home/.config/nvim').mkdir(parents=True)
        (self.repo / 'home/.config/nvim/init.lua').write_text('original config')
        for name in ('.bashrc', '.bash_profile', '.zprofile', '.zshenv', '.zshrc'):
            (self.repo / 'home' / name).write_text('shell config')
        shutil.copyfile(ROOT / 'home/.stow-local-ignore', self.repo / 'home/.stow-local-ignore')
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('GIT_', 'GITSIGN_'))}
        self.env.update(HOME=str(self.home), PATH=f'{self.bin}:/usr/bin:/bin',
                        GIT_CONFIG_NOSYSTEM='1', XDG_CONFIG_HOME=str(self.home / '.config'),
                        CODEX_HOME=str(self.home / '.codex'), CLAUDE_CONFIG_DIR=str(self.home / '.claude'))
        self.tool('systemctl', 'printf "%s\\n" "$*" >> "$HOME/services"')
        self.tool('xdg-open', 'exit 0')
        self.tool('gh', 'printf "%s\\n" "$*" >> "$HOME/gh-calls"')
        (self.bin / 'python3').symlink_to(sys.executable)
        (self.repo / 'bin/setup-work-tools').write_text('echo work-tools >> "$HOME/setup-calls"\n')
        (self.repo / 'bin/install-gitsign-fork').write_text(
            'echo "gitsign $*" >> "$HOME/setup-calls"\n'
            'exit "${TEST_SIGNER_EXIT:-0}"\n')

    def tool(self, name, body):
        target = self.bin / name
        target.write_text('#!/bin/sh\n' + body + '\n')
        target.chmod(0o755)

    def run_script(self, name, *args, success=True):
        command = [sys.executable] if name in ('bin/sync-dotfiles', 'bin/sync-ai-skills', 'bin/setup-fritzworks') else ['bash']
        result = subprocess.run([*command, str(self.repo / name), *args],
                                env=self.env, capture_output=True, text=True, timeout=20)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_general_package_does_not_install_work_roles(self):
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertTrue((self.home / '.bashrc').is_symlink())
        for name in ('.ssh', '.config/systemd', '.config/shell/browser.sh', '.scripts/url-open'):
            self.assertFalse((self.home / name).exists(), name)
        self.assertFalse((self.home / '.gitconfig').exists())

    def test_shared_and_role_bootstraps_are_additive_across_reruns(self):
        for role in ('worklaptop', 'workstation'):
            with self.subTest(role=role):
                case = BootstrapRoleTests()
                case.setUp()
                try:
                    case.prepare_general_bootstrap()
                    case.tool('fw', 'echo existing-fw')
                    case.run_script('bootstrap.sh', '--no-nvim')
                    for _ in range(2):
                        case.run_script(f'bootstrap-{role}.sh')
                        case.run_script('bootstrap.sh', '--no-nvim')
                    self.assertEqual((case.home / '.config/nvim/init.lua').read_text(), 'original config')
                    if role == 'worklaptop':
                        self.assertTrue((case.home / '.ssh/config.d/workstation').is_file())
                        self.assertTrue((case.home / '.config/systemd/user/url-open.socket').is_file())
                        self.assertFalse((case.home / '.local/bin/xdg-open').exists())
                        self.assertFalse((case.home / '.config/shell/browser.sh').exists())
                    else:
                        self.assertTrue((case.home / '.local/bin/xdg-open').is_file())
                        self.assertTrue((case.home / '.config/shell/browser.sh').is_file())
                        self.assertFalse((case.home / '.ssh/config.d/workstation').exists())
                        self.assertFalse((case.home / '.config/systemd/user/url-open.socket').exists())
                finally:
                    case.doCleanups()

    def prepare_general_bootstrap(self):
        for name in ('stow', 'fzf', 'zsh-autosuggestions', 'nc', 'zellij', 'wget',
                     'coldbrew', 'eget', 'starship', 'node'):
            self.tool(name, 'exit 0')
        self.tool('npm', 'echo "$HOME/.local"')
        for name in ('setup-codex', 'install-fritzworks'):
            (self.repo / 'bin' / name).write_text(f'echo {name} >> "$HOME/general-calls"\n')
        self.env['SHELL'] = '/bin/bash'

    def test_general_bootstrap_does_not_run_work_setup(self):
        self.prepare_general_bootstrap()
        (self.home / '.ssh').mkdir()
        (self.home / '.ssh/config').write_text('Host workstation\n  Hostname old\n')
        self.run_script('bootstrap.sh', '--no-nvim')
        self.assertEqual((self.home / 'general-calls').read_text(),
                         'setup-codex\ninstall-fritzworks\n')
        for name in ('setup-calls', 'services', 'gh-calls', '.gitconfig'):
            self.assertFalse((self.home / name).exists(), name)
        self.assertEqual((self.home / '.ssh/config').read_text(), 'Host workstation\n  Hostname old\n')

    def test_repeat_bootstrap_updates_skills_and_preserves_client_settings_and_fw_config(self):
        self.prepare_general_bootstrap()
        self.tool('fw', 'echo existing-fw')
        self.env['CLAUDE_CONFIG_DIR'] = str(self.home / 'custom-claude')
        self.env['CODEX_HOME'] = str(self.home / 'custom-codex')
        preserved = {}
        for relative in ('settings.json', 'plugins/known_marketplaces.json', 'skills/fw/SKILL.md'):
            target = Path(self.env['CLAUDE_CONFIG_DIR']) / relative
            source = self.repo / 'claude' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('existing hooks, MCP settings, and customizations')
            source.write_text('repository seed')
            if not relative.startswith('skills/'):
                preserved[target] = (target.read_bytes(), target.stat().st_mtime_ns)
        for relative in ('config.toml', 'skills/fw/SKILL.md'):
            target = Path(self.env['CODEX_HOME']) / relative
            source = self.repo / 'codex' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('existing MCP settings')
            source.write_text('repository seed')
            if not relative.startswith('skills/'):
                preserved[target] = (target.read_bytes(), target.stat().st_mtime_ns)
        fw_config = self.home / '.config/fritzworks/config.ini'
        fw_seed = self.repo / 'home/.config/fritzworks/config.ini'
        fw_config.parent.mkdir(parents=True)
        fw_seed.parent.mkdir(parents=True)
        fw_config.write_text('existing daemon configuration')
        fw_seed.write_text('repository seed')
        preserved[fw_config] = (fw_config.read_bytes(), fw_config.stat().st_mtime_ns)
        new_skill = self.repo / 'claude/skills/new/SKILL.md'
        new_skill.parent.mkdir(parents=True)
        new_skill.write_text('new skill')
        for _ in range(2):
            self.run_script('bootstrap.sh', '--no-nvim')
        for target, before in preserved.items():
            self.assertEqual((target.read_bytes(), target.stat().st_mtime_ns), before, str(target))
        self.assertEqual((Path(self.env['CLAUDE_CONFIG_DIR']) / 'skills/new/SKILL.md').read_text(), 'new skill')
        self.assertNotIn('install-fritzworks', (self.home / 'general-calls').read_text())
        for key in ('CLAUDE_CONFIG_DIR', 'CODEX_HOME'):
            client = Path(self.env[key])
            self.assertEqual((client / 'skills/fw/SKILL.md').read_text(), 'repository seed')
            self.assertEqual(len(list((client / 'skill-backups').iterdir())), 1)
            self.assertNotEqual((client / 'skill-backups/fw/SKILL.md').read_text(), 'repository seed')

    def test_stow_failure_restores_files_and_links(self):
        self.tool('stow', '[ "$1" = --version ] && exit 0\nexit 7')
        (self.home / '.bashrc').write_text('personal shell')
        (self.home / '.zshrc').symlink_to(self.repo / 'home/.zshrc')
        original = os.readlink(self.home / '.zshrc')
        result = self.run_script('bin/sync-dotfiles', 'home', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.home / '.bashrc').read_text(), 'personal shell')
        self.assertFalse((self.home / '.bashrc.bak').exists())
        self.assertEqual(os.readlink(self.home / '.zshrc'), original)
        self.assertFalse((self.home / '.config').exists())

    def test_unusable_stow_uses_relative_links(self):
        self.tool('stow', 'exit 7')
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertEqual((self.home / '.config/nvim/init.lua').read_text(), 'original config')

    def test_directory_validation_failure_rolls_back_earlier_files(self):
        (self.home / '.bashrc').write_text('personal shell')
        outside = self.base / 'outside'
        outside.mkdir()
        (self.home / '.config').symlink_to(outside)
        result = self.run_script('bin/sync-dotfiles', 'home', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.home / '.bashrc').read_text(), 'personal shell')
        self.assertEqual((self.home / '.config').resolve(), outside)

    def test_unfold_preserves_ignored_config_and_does_not_import_roles(self):
        config = self.repo / 'home/.config/fritzworks/config.ini'
        config.parent.mkdir()
        config.write_text('working config')
        (self.home / '.config').symlink_to(self.repo / 'home/.config')
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertEqual((self.home / '.config/fritzworks/config.ini').read_text(), 'working config')
        (self.home / '.config/fritzworks/runtime.json').write_text('runtime')
        self.assertFalse((config.parent / 'runtime.json').exists())
        self.assertFalse((self.home / '.config/shell').exists())
        self.assertFalse((self.home / '.config/systemd').exists())

    def test_skill_sync_detaches_directory_link_and_preserves_unmanaged_skills(self):
        source = self.repo / 'codex/skills'
        (source / 'fw').mkdir(parents=True)
        (source / 'fw/SKILL.md').write_text('current')
        old = self.base / 'old-skills'
        (old / 'fw').mkdir(parents=True)
        (old / 'fw/SKILL.md').write_text('stale')
        (old / 'custom').mkdir()
        (old / 'custom/SKILL.md').write_text('personal')
        target = self.home / 'skills'
        target.symlink_to(old)
        self.run_script('bin/sync-ai-skills', str(source), str(target))
        self.assertFalse(target.is_symlink())
        self.assertEqual((target / 'fw/SKILL.md').read_text(), 'current')
        self.assertEqual((target / 'custom/SKILL.md').read_text(), 'personal')
        self.assertEqual((old / 'fw/SKILL.md').read_text(), 'stale')
        before = (target / 'fw/SKILL.md').stat().st_mtime_ns
        self.run_script('bin/sync-ai-skills', str(source), str(target))
        self.assertEqual((target / 'fw/SKILL.md').stat().st_mtime_ns, before)

    def test_fw_setup_adds_missing_mcp_without_replacing_existing_registration(self):
        self.tool('fw', 'printf "%s\\n" "$*" >> "$HOME/fw-calls"')
        self.tool('codex', 'echo "[]"')
        self.tool('claude', 'exit 0')
        custom = self.home / '.claude'
        custom.mkdir()
        registration = '{"mcpServers":{"fw":{"type":"http","url":"https://example.test"}}}'
        (custom / 'claude.json').write_text(registration)
        self.run_script('bin/setup-fritzworks')
        calls = (self.home / 'fw-calls').read_text()
        self.assertIn('config validate', calls)
        self.assertIn('setup --no-mcp', calls)
        self.assertIn('setup --provider codex', calls)
        self.assertNotIn('setup --provider claude', calls)
        self.assertEqual((custom / 'claude.json').read_text(), registration)

    def test_invalid_fw_config_stops_integration_setup(self):
        self.tool('fw', '[ "$1" = config ] && exit 4\necho unexpected >> "$HOME/fw-calls"')
        result = self.run_script('bin/setup-fritzworks', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.home / 'fw-calls').exists())

    def test_fresh_bootstrap_seeds_valid_fw_paths_and_refreshes_integrations(self):
        self.prepare_general_bootstrap()
        seed = self.repo / 'home/.config/fritzworks/config.ini'
        seed.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / 'home/.config/fritzworks/config.ini', seed)
        self.tool('fw', '''if [ "$1" = config ]; then
python3 - <<'INNER'
import configparser, os
from pathlib import Path
config = configparser.ConfigParser()
config.read(Path(os.environ['XDG_CONFIG_HOME']) / 'fritzworks/config.ini')
assert config['paths']['data']
INNER
else
echo "$*" >> "$HOME/fw-calls"
fi''')
        self.run_script('bootstrap.sh', '--no-nvim')
        self.assertIn('setup --no-mcp', (self.home / 'fw-calls').read_text())

    def test_broken_config_link_stops_bootstrap_without_overwriting_it(self):
        self.prepare_general_bootstrap()
        target = self.home / '.config/fritzworks/config.ini'
        target.parent.mkdir(parents=True)
        target.symlink_to('missing.ini')
        result = self.run_script('bootstrap.sh', '--no-nvim', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Broken configuration link', result.stderr)
        self.assertEqual(os.readlink(target), 'missing.ini')

    @unittest.skipUnless(STOW, 'GNU Stow is required for interoperability checks')
    def test_stow_preserves_existing_fritzworks_configuration(self):
        (self.bin / 'stow').symlink_to(STOW)
        source = self.repo / 'home/.config/fritzworks/config.ini'
        source.parent.mkdir(parents=True)
        source.write_text('seed')
        target = self.home / '.config/fritzworks/config.ini'
        target.parent.mkdir(parents=True)
        target.write_text('working configuration')
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertEqual(target.read_text(), 'working configuration')
        self.assertFalse(target.is_symlink())

    @unittest.skipUnless(STOW, 'GNU Stow is required for interoperability checks')
    def test_absolute_links_and_fallback_are_accepted_by_stow(self):
        shell = self.home / '.bashrc'
        shell.symlink_to(self.repo / 'home/.bashrc')
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertFalse(os.path.isabs(os.readlink(shell)))
        self.run_script('bootstrap-workstation.sh')
        # Use actual Stow after the fallback and old-link migration.
        for package in ('home', 'workstation'):
            result = subprocess.run([STOW, '--dir', str(self.repo), '--target', str(self.home),
                                     '--no-folding', '--simulate', package],
                                    env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(STOW, 'GNU Stow is required for interoperability checks')
    def test_real_stow_ignores_bytecode(self):
        (self.bin / 'stow').symlink_to(STOW)
        cache = self.repo / 'home/.scripts/__pycache__'
        cache.mkdir(parents=True)
        (cache / 'example.pyc').write_bytes(b'bytecode')
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertFalse((self.home / '.scripts/__pycache__').exists())
        self.assertTrue((self.home / '.bashrc').is_symlink())

    def test_conflicting_files_are_backed_up_without_overwriting_previous_backup(self):
        (self.home / '.bashrc').write_text('personal config')
        (self.home / '.bashrc.bak').write_text('previous backup')
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertEqual((self.home / '.bashrc.bak').read_text(), 'previous backup')
        self.assertEqual((self.home / '.bashrc.bak.1').read_text(), 'personal config')
        self.run_script('bin/sync-dotfiles', 'home')
        self.assertFalse((self.home / '.bashrc.bak.2').exists())

    def test_folded_config_is_unfolded_before_runtime_writes(self):
        (self.home / '.config').symlink_to(self.repo / 'home/.config')
        self.run_script('bin/sync-dotfiles', 'home')
        self.run_script('bootstrap-workstation.sh')
        units = self.home / '.config/systemd/user'
        self.assertTrue(units.is_dir())
        for target in (self.home / '.config', units.parent, units):
            self.assertFalse(target.is_symlink())
        (units / 'runtime.service').write_text('runtime')
        self.assertFalse(list(self.repo.rglob('runtime.service')))
        self.assertEqual((self.home / '.config/nvim/init.lua').read_text(), 'original config')

    def test_foreign_directory_link_is_preserved(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (self.home / '.config').symlink_to(outside)
        result = self.run_script('bin/sync-dotfiles', 'home', success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Preserving directory symlink', result.stderr)
        self.assertEqual(list(outside.iterdir()), [])

    def test_laptop_migrates_ssh_and_starts_only_laptop_services(self):
        ssh = self.home / '.ssh'
        ssh.mkdir()
        config = ssh / 'config'
        original = 'Host personal\n  Hostname example.test\nHost workstation\n  Hostname old\n'
        config.write_text(original)
        for _ in range(2):
            self.run_script('bootstrap-worklaptop.sh')
        self.assertIn('Host personal\n  Hostname example.test', config.read_text())
        self.assertNotIn('Hostname old', config.read_text())
        self.assertEqual(config.read_text().count('Include ~/.ssh/config.d/workstation'), 1)
        self.assertEqual(len(list(ssh.glob('config.backup.*'))), 1)
        self.assertEqual(next(ssh.glob('config.backup.*')).read_text(), original)
        self.assertIn('enable --now url-open.socket', (self.home / 'services').read_text())
        self.assertNotIn('gitsign', (self.home / 'setup-calls').read_text())
        self.assertFalse((self.home / '.gitconfig').exists())
        self.assertFalse((self.home / '.local/bin/xdg-open').exists())

    def test_workstation_migrates_old_links_and_configures_signing(self):
        for relative in ('.scripts/url-open', '.config/shell/browser.sh'):
            target = self.home / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(self.repo / 'home' / relative)
        for _ in range(2):
            self.run_script('bootstrap-workstation.sh')
        self.assertEqual((self.home / '.scripts/url-open').resolve(),
                         self.repo / 'workstation/.scripts/url-open')
        self.assertEqual((self.home / '.local/bin/xdg-open').resolve(),
                         self.repo / 'workstation/.scripts/url-open')
        self.assertIn('gitsign --system', (self.home / 'setup-calls').read_text())
        self.assertIn('urlOpener', (self.home / '.gitconfig').read_text())
        self.assertNotIn('enable', (self.home / 'services').read_text())
        self.assertFalse((self.home / '.ssh/config').exists())

    def test_signer_failure_stops_workstation_setup(self):
        self.env['TEST_SIGNER_EXIT'] = '12'
        result = self.run_script('bootstrap-workstation.sh', success=False)
        self.assertEqual(result.returncode, 12)
        self.assertEqual((self.home / 'setup-calls').read_text(), 'gitsign --system\n')

    def test_legacy_auto_mode_cannot_activate_work_setup(self):
        result = self.run_script('workstation.sh', '--auto', success=False)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.home / 'setup-calls').exists())


if __name__ == '__main__':
    unittest.main()
