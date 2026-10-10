#!/usr/bin/env python3
"""Download CLOUD_IMAGE_URL and store a qcow2 + sha256 at /opt/kin-kvm/base.*."""
import hashlib
import json
import os
import subprocess
import sys

def main():
    url = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('CLOUD_IMAGE_URL', '')).strip()
    if not url:
        raise SystemExit('CLOUD_IMAGE_URL is required')
    src = '/tmp/cloud.img'
    if not os.path.isfile(src) or os.path.getsize(src) < 10_000_000:
        raise SystemExit(f'cloud image too small or missing: {src}')
    info = json.loads(subprocess.check_output(['qemu-img', 'info', '--output=json', src]))
    fmt = info.get('format')
    print(f'kin-kvm: cloud format={fmt} virtual-size={info.get("virtual-size")}', flush=True)
    os.makedirs('/opt/kin-kvm', exist_ok=True)
    dst = '/opt/kin-kvm/base.qcow2'
    if fmt == 'qcow2':
        os.replace(src, dst)
    else:
        subprocess.check_call(['qemu-img', 'convert', '-O', 'qcow2', src, dst])
        try:
            os.remove(src)
        except OSError:
            pass
    digest = hashlib.sha256()
    with open(dst, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(chunk)
    hexdigest = digest.hexdigest()
    open('/opt/kin-kvm/base.id', 'w').write(hexdigest + '\n')
    open('/opt/kin-kvm/base.url', 'w').write(url + '\n')
    os.chmod(dst, 0o644)
    os.chmod('/opt/kin-kvm/base.id', 0o644)
    os.chmod('/opt/kin-kvm/base.url', 0o644)
    print('kin-kvm: base.id', hexdigest, flush=True)
    subprocess.check_call(['qemu-img', 'info', dst])

if __name__ == '__main__':
    main()
