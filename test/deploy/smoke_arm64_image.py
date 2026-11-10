#!/usr/bin/env python3
"""Check a candidate image without mounting credentials or the Docker socket."""

import argparse
import json
from pathlib import Path
import subprocess
import uuid


ROOT = Path(__file__).resolve().parents[2]
PROGRAM = r'''
import json
import os
from pathlib import Path
import secrets
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

root = Path('/opt/vm2api')
expected = json.loads(sys.argv[1])
assert (root / 'VERSION').read_text().strip() == expected['version']
assert subprocess.check_output(['node', '-p', 'process.arch'], text=True).strip() == 'arm64'

def elf(path, machine, static=False):
    data = path.read_bytes()
    assert data[:6] == b'\x7fELF\x02\x01', path
    assert struct.unpack_from('<H', data, 18)[0] == machine, path
    if static:
        offset = struct.unpack_from('<Q', data, 32)[0]
        size, count = struct.unpack_from('<HH', data, 54)
        assert all(struct.unpack_from('<I', data, offset + i * size)[0] != 3 for i in range(count)), path

for name in ('kin-worker', 'kin-egress'):
    elf(root / 'image-bin' / name, 183, static=True)
    elf(root / 'cluster-bin-amd64' / name, 62, static=True)
elf(root / 'image-bin' / 'kin-api-kernel', 183, static=True)
elf(Path('/usr/local/bin/docker'), 183, static=True)
subprocess.run(['docker', '--version'], check=True, timeout=10)
for name in ('kin-kernel', 'kin-codex-kernel', 'kin-oauth-auth', 'kin-computer'):
    elf(root / 'image-bin' / name, 62)
for name in ('kin-kernel', 'kin-codex-kernel'):
    loaded = subprocess.run(['/usr/lib64/ld-linux-x86-64.so.2', '--list', str(root / 'image-bin' / name)],
                            check=True, timeout=30, capture_output=True, text=True)
    assert 'not found' not in loaded.stdout + loaded.stderr, name + ': ' + loaded.stderr
for name in ('cli-node', 'cc-node'):
    binary = root / 'image-wrap-cli' / name
    # The pinned payload no longer ships cc-node (#967); check it only when present.
    if name == 'cc-node' and not binary.exists():
        print(name + ': absent (optional)')
        continue
    elf(binary, 62)
    version = subprocess.check_output([str(binary), '--version'], text=True, timeout=60).strip()
    assert version, name
    print(name + ': ' + version)

env = {**os.environ, 'HOST': '127.0.0.1', 'PORT': '18787', 'KIN_AUTO_SYNC_WRAP': '0',
       'VM2API_ADMIN_PASSWORD': secrets.token_hex(24), 'VM2API_API_KEY': secrets.token_hex(32),
       'VM2API_DB_SECRET': secrets.token_hex(32)}
server = subprocess.Popen(['/usr/local/bin/vm2api-entrypoint'], env=env,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    deadline = time.monotonic() + 45
    while True:
        assert server.poll() is None, 'control plane exited before becoming ready'
        try:
            with urllib.request.urlopen('http://127.0.0.1:18787/health', timeout=2) as response:
                assert response.status == 200
            break
        except (urllib.error.URLError, TimeoutError):
            assert time.monotonic() < deadline, 'health readiness timeout'
            time.sleep(0.5)
    with urllib.request.urlopen('http://127.0.0.1:18787/console', timeout=5) as response:
        assert response.status == 200
    for name in ('kin-worker', 'kin-egress', 'kin-api-kernel'):
        elf(root / 'bin' / name, 183, static=True)
        assert (root / 'bin' / name).read_bytes() == (root / 'image-bin' / name).read_bytes()
    subprocess.run(['node', '--input-type=module', '-e', r"""
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureSlotComputer } from './src/lib/identity/slot-computer.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-smoke-'))
try {
  for (const type of ['docker', 'kvm']) {
    const vm = { id: `vm-smoke-${type}`, runtime: { type } }
    const first = ensureSlotComputer(root, vm)
    const second = ensureSlotComputer(root, vm)
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.hostname, first.hostname)
    assert.equal(second.guest_machine_id, first.guest_machine_id)
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
"""], cwd=root, check=True, timeout=120)
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=5)
print('PASS: native control plane, amd64 cluster helpers, QEMU CLI/computer, stable Docker/KVM identities, entrypoint refresh, health and console')
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    args = parser.parse_args()
    expected = {"version": (ROOT / "VERSION").read_text().strip()}
    name = "vm2api-arm64-smoke-" + uuid.uuid4().hex[:12]
    try:
        subprocess.run(["docker", "run", "--name", name, "--platform", "linux/arm64",
                        "--network", "none", "-i", "--entrypoint", "python3", args.image,
                        "-", json.dumps(expected)], input=PROGRAM, text=True, check=True, timeout=210)
    finally:
        result = subprocess.run(["docker", "inspect", "--format", "{{.Id}} {{.State.Running}}", name],
                                capture_output=True, text=True)
        if result.returncode == 0:
            container_id, running = result.stdout.strip().split()
            if running == "true":
                subprocess.run(["docker", "stop", "--time", "5", container_id], check=True)
            subprocess.run(["docker", "container", "rm", container_id], check=True)


if __name__ == "__main__":
    main()
