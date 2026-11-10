"""Installer tests run without sudo, apt, credentials, or system changes."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('memory_setup', ROOT / 'deploy/linux/configure-memory.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class InstallerTests(unittest.TestCase):
    def test_shell_syntax(self):
        subprocess.run(['bash','-n',str(ROOT/'deploy/linux/install.sh')], check=True)

    def test_readiness_probe_and_launcher_work_with_the_console_token(self):
        # /api answers 401 without the token, so a probe there fails every fresh install.
        script = (ROOT/'deploy/linux/install.sh').read_text()
        self.assertIn('http://127.0.0.1:4173/healthz', script)
        self.assertNotIn('127.0.0.1:4173/api/', script)
        self.assertIn('exec /usr/bin/python3 -I /opt/better-bots/window.py', script)
        self.assertIn('gir1.2-webkit2-4.1', script)

    def test_rejects_non_linux_before_sudo(self):
        result = subprocess.run(['bash','-c', 'source "$1"; uname() { echo Darwin; }; check_platform', '_', str(ROOT/'deploy/linux/install.sh')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Linux Mint', result.stderr)

    def test_rejects_unsupported_mint_and_lmde(self):
        for content in ['ID=linuxmint\nVERSION_ID=21.3\nUBUNTU_CODENAME=jammy', 'ID=linuxmint\nVERSION_ID=6\n', 'ID=ubuntu\nVERSION_ID=24.04\nUBUNTU_CODENAME=noble']:
            with tempfile.NamedTemporaryFile(mode='w') as release:
                release.write(content); release.flush()
                result = subprocess.run(['bash','-c', 'source "$1"; uname() { if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi; }; check_platform "$2"', '_', str(ROOT/'deploy/linux/install.sh'), release.name], capture_output=True,text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not Mint 21.x or LMDE', result.stderr)

    def test_private_env_restricts_mode_preserves_literals_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'settings.env'
            import pwd
            account=pwd.getpwuid(os.getuid())
            with patch.object(module.os, 'fchown'):
                module.private_env(target, {'API_KEY':'test"quote\\slash$dollar%percent'}, account.pw_name)
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                self.assertEqual(target.read_text(), 'API_KEY="test\\"quote\\\\slash$dollar%percent"\n')
                with self.assertRaises(FileExistsError):
                    module.private_env(target, {'API_KEY':'replacement'}, account.pw_name)

    def test_installs_only_after_the_autonomy_warning_is_accepted(self):
        def confirm(accept=None):
            env = {k: v for k, v in os.environ.items() if k != 'BETTER_BOTS_ACCEPT_AUTONOMY'}
            if accept is not None: env['BETTER_BOTS_ACCEPT_AUTONOMY'] = accept
            # No controlling terminal, as in CI: nobody is there to type yes.
            return subprocess.run(['bash', '-c', 'source "$1"; confirm_autonomy || exit 1', '_', str(ROOT/'deploy/linux/install.sh')],
                                  capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, start_new_session=True)
        refused = confirm()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('without asking you first', refused.stdout)
        self.assertIn('BETTER_BOTS_ACCEPT_AUTONOMY=yes', refused.stderr)
        self.assertNotEqual(confirm('no').returncode, 0)
        accepted = confirm('yes')
        self.assertEqual(accepted.returncode, 0)
        self.assertIn('keeps working until the task is done', accepted.stdout)
        script = (ROOT/'deploy/linux/install.sh').read_text()
        self.assertLess(script.index('confirm_autonomy || exit 1'), script.index('exec sudo env BETTER_BOTS_ACCEPT_AUTONOMY=yes'),
                        'the warning comes before the password prompt, and the root pass does not ask again')

    def test_hindsight_is_opt_in_with_its_own_port(self):
        def parse(*args):
            script = 'source "$1"; shift; parse_args "$@" && echo "$WITH_HINDSIGHT $HINDSIGHT_PORT $CHECK_ONLY"'
            return subprocess.run(['bash', '-c', script, '_', str(ROOT/'deploy/linux/install.sh'), *args], capture_output=True, text=True)
        self.assertEqual(parse().stdout.split(), ['0', '8888', '0'])
        self.assertEqual(parse('--check').stdout.split(), ['0', '8888', '1'])
        self.assertEqual(parse('--with-hindsight', '--hindsight-port', '9888').stdout.split(), ['1', '9888', '0'])
        for args in (['--hindsight-port'], ['--hindsight-port', '80'], ['--hindsight-port', '4173'], ['--hindsight-port', '8x'], ['--force']):
            self.assertNotEqual(parse(*args).returncode, 0, args)

    def test_refuses_to_remove_ubuntu_npm_without_consent(self):
        def check(node_major, npm_installed, *args):
            dpkg = 'echo "install ok installed"' if npm_installed else 'return 1'
            script = ('source "$1"; shift; parse_args "$@"; '
                      f'node() {{ if [ "$1" = --version ]; then echo v{node_major}.0.0; else echo {node_major}; fi; }}; '
                      f'dpkg-query() {{ {dpkg}; }}; check_node_replacement')
            return subprocess.run(['bash', '-c', script, '_', str(ROOT/'deploy/linux/install.sh'), *args], capture_output=True, text=True)
        refused = check(18, True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('--replace-node', refused.stderr)
        self.assertIn('Nothing was changed', refused.stderr)
        self.assertEqual(check(18, True, '--replace-node').returncode, 0)
        self.assertEqual(check(18, False).returncode, 0, 'no Ubuntu npm: nothing to remove')
        self.assertEqual(check(22, True).returncode, 0, 'Node 22 already: no replacement')

    def test_memory_ports_validated(self):
        self.assertEqual(module.port('5433'), '5433')
        for value in ['80', '70000', '54x', '']:
            with self.assertRaises(SystemExit): module.port(value)

    def test_env_control_characters_rejected(self):
        for value in ['line\nbreak','carriage\rreturn','null\0byte']:
            with self.assertRaises(ValueError): module.env_value(value)

if __name__ == '__main__': unittest.main()
