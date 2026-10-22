"""Validate generated PostgreSQL deployment config without exposing its credentials."""
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from urllib.parse import urlparse


class PostgreSqlEnvironmentTests(unittest.TestCase):
    def test_arm64_initializer_writes_matching_private_database_configuration(self):
        with tempfile.TemporaryDirectory(prefix='vm2api-env-') as directory:
            root = Path(directory)
            (root / 'deploy').mkdir()
            script = root / 'deploy' / 'init-arm64-env.py'
            shutil.copyfile(Path(__file__).resolve().parents[2] / 'deploy' / 'init-arm64-env.py', script)
            result = subprocess.run(['python3', str(script), '--port', '18787'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            values = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if line and not line.startswith('#'))
            url = urlparse(values['VM2API_DATABASE_URL'])
            self.assertEqual(url.password, values['VM2API_POSTGRES_PASSWORD'])
            self.assertEqual(url.hostname, '127.0.0.1')
            self.assertEqual(url.port, 55432)
            self.assertEqual(url.path, '/vm2api')
            self.assertEqual(values['COMPOSE_PROFILES'], 'postgres')
            self.assertEqual(stat.S_IMODE((root / '.env').stat().st_mode), 0o600)
            self.assertNotIn(values['VM2API_POSTGRES_PASSWORD'], result.stdout + result.stderr)
            original = (root / '.env').read_bytes()
            result = subprocess.run(['python3', str(script)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / '.env').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
