"""Host profile setup uses real files and mocked policy loading, never host sysctls."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).resolve().parents[2] / 'deploy/install.sh'
DEFINITIONS = INSTALLER.read_text().split('\nCOMMAND="install"\n')[0]


class DockerAppArmorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for path, value in {
            'sys/module/apparmor/parameters/enabled': 'Y',
            'proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1',
            'etc/apparmor.d/abi/4.0': 'fixture ABI',
        }.items():
            p = self.root / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(value)
        self.profile = self.root / 'etc/apparmor.d/vm2api-crag-docker'

    def run_setup(self, fail=''):
        env = dict(os.environ, TEST_ROOT=str(self.root), FAIL=fail)
        script = DEFINITIONS + r'''
apparmor_parser() {
  printf '%s\n' "$1" >> "$TEST_ROOT/parser.calls"
  [ "$1" != "$FAIL" ]
}
prepare_docker_crag_apparmor "$TEST_ROOT"
'''
        return subprocess.run(['bash', '-c', script], env=env, text=True, capture_output=True, timeout=10)

    def test_profile_loads_and_reloads_without_relaxing_sysctl(self):
        for _ in range(2):
            result = self.run_setup()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('profile vm2api-crag-docker flags=(unconfined)', self.profile.read_text())
            self.assertIn('  userns,', self.profile.read_text())
            self.assertEqual(self.profile.stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.root / 'parser.calls').read_text().splitlines(), ['-Q', '-r', '-Q', '-r'])
        self.assertEqual((self.root / 'proc/sys/kernel/apparmor_restrict_unprivileged_userns').read_text(), '1')

    def test_unrestricted_and_non_apparmor_hosts_are_untouched(self):
        for rel, value in [('proc/sys/kernel/apparmor_restrict_unprivileged_userns', '0'),
                           ('sys/module/apparmor/parameters/enabled', 'N')]:
            p = self.root / rel
            original = p.read_text()
            p.write_text(value)
            self.assertEqual(self.run_setup().returncode, 0)
            self.assertFalse(self.profile.exists())
            self.assertFalse((self.root / 'parser.calls').exists())
            p.write_text(original)

    def test_operator_policy_and_symlink_are_not_overwritten(self):
        self.profile.write_text('operator-owned policy\n')
        self.assertNotEqual(self.run_setup().returncode, 0)
        self.assertEqual(self.profile.read_text(), 'operator-owned policy\n')
        target = self.profile.with_name('operator-policy')
        self.profile.rename(target)
        self.profile.symlink_to(target)
        self.assertNotEqual(self.run_setup().returncode, 0)
        self.assertEqual(target.read_text(), 'operator-owned policy\n')

    def test_parser_failures_do_not_replace_persistent_policy(self):
        self.assertEqual(self.run_setup().returncode, 0)
        previous = self.profile.read_bytes()
        for phase in ['-Q', '-r']:
            self.assertNotEqual(self.run_setup(phase).returncode, 0)
            self.assertEqual(self.profile.read_bytes(), previous)

    def test_missing_abi_fails_before_loading(self):
        (self.root / 'etc/apparmor.d/abi/4.0').rename(self.root / 'saved-abi')
        self.assertNotEqual(self.run_setup().returncode, 0)
        self.assertFalse(self.profile.exists())
        self.assertFalse((self.root / 'parser.calls').exists())

    def test_no_start_does_not_modify_host(self):
        script = DEFINITIONS + '\ninstall_mode() { echo image; }; NO_START=1; prepare_docker_crag_apparmor() { exit 97; }; start_stack'
        result = subprocess.run(['bash', '-c', script], text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_profile_failure_prevents_compose(self):
        script = DEFINITIONS + '\ninstall_mode() { echo image; }; prepare_docker_crag_apparmor() { return 1; }; compose() { echo unexpected-compose; }; start_stack'
        result = subprocess.run(['bash', '-c', script], text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('unexpected-compose', result.stdout)
