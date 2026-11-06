"""Private SSH helper for stopped KVM slot transfers; no dependencies beyond Python 3.

The control plane pipes stdout to the receiver through a bounded, backpressured
SSH stream. Holes are represented by offsets, not zero-filled network traffic.
Never run this helper against a running slot.
"""
import hashlib
import json
import os
import shutil
import stat
import struct
import sys
import time

CHUNK = 256 * 1024
RATE = 1024 * 1024
MARKER = '.vm2api-migration-owner'
EXCLUDE = {'run', 'slot-bin', MARKER}


def entries(root):
    for base, dirs, files in os.walk(root, followlinks=False):
        if base == root:
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDE)
            files = [f for f in files if f not in EXCLUDE]
        for name in sorted(dirs + files):
            full = os.path.join(base, name)
            st = os.lstat(full)
            rel = os.path.relpath(full, root)
            if stat.S_ISSOCK(st.st_mode):
                continue
            if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode)):
                raise ValueError('unsupported special file in slot')
            yield full, rel, st


def probe(root):
    if os.path.islink(root) or not os.path.isdir(root):
        raise ValueError('slot root must be a directory')
    disk = os.lstat(os.path.join(root, 'kvm', 'disk.qcow2'))
    if not stat.S_ISREG(disk.st_mode):
        raise ValueError('KVM disk is not a regular file')
    total = 0
    count = 0
    for _, _, st in entries(root):
        total += st.st_blocks * 512
        count += 1
        if count > 100000:
            raise ValueError('slot contains too many files')
    return {'allocated_bytes': total, 'files': count}


def send(root):
    probe(root)
    out = sys.stdout.buffer
    digest = hashlib.sha256()
    start = time.monotonic()
    written = 0

    def write(data):
        nonlocal written
        out.write(data)
        digest.update(data)
        written += len(data)
        delay = written / RATE - (time.monotonic() - start)
        if delay > 0:
            out.flush()
            time.sleep(delay)

    def frame(meta, data=b''):
        raw = json.dumps(meta, ensure_ascii=True, separators=(',', ':')).encode()
        write(struct.pack('!I', len(raw)) + raw)
        if data:
            write(data)

    for full, rel, st in entries(root):
        meta = {'path': rel, 'mode': stat.S_IMODE(st.st_mode), 'uid': st.st_uid,
                'gid': st.st_gid, 'mtime_ns': st.st_mtime_ns}
        if stat.S_ISDIR(st.st_mode):
            frame(dict(meta, type='dir'))
        elif stat.S_ISLNK(st.st_mode):
            frame(dict(meta, type='link', target=os.readlink(full)))
        else:
            frame(dict(meta, type='file', size=st.st_size))
            fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                offset = 0
                while offset < st.st_size:
                    try:
                        offset = os.lseek(fd, offset, os.SEEK_DATA)
                        end = min(os.lseek(fd, offset, os.SEEK_HOLE), st.st_size)
                    except OSError as exc:
                        if exc.errno == 6:  # ENXIO: the remaining range is a hole
                            break
                        offset = os.lseek(fd, offset, os.SEEK_SET)
                        end = st.st_size  # Filesystem has no sparse seek support.
                    os.lseek(fd, offset, os.SEEK_SET)
                    while offset < end:
                        data = os.read(fd, min(CHUNK, end - offset))
                        if not data:
                            raise ValueError('source file changed during transfer')
                        frame({'type': 'data', 'offset': offset, 'length': len(data)}, data)
                        offset += len(data)
            finally:
                os.close(fd)
            frame({'type': 'close'})
    raw = json.dumps({'type': 'end', 'sha256': digest.hexdigest()}).encode()
    out.write(struct.pack('!I', len(raw)) + raw)
    out.flush()


def owned(root, token):
    with open(os.path.join(root, MARKER), encoding='ascii') as f:
        if f.read() != token:
            raise ValueError('migration ownership mismatch')


def receive(root, token):
    os.mkdir(root, 0o700)  # Never merge into an existing tree.
    with open(os.path.join(root, MARKER), 'x', encoding='ascii') as f:
        f.write(token)
    inp = sys.stdin.buffer
    digest = hashlib.sha256()
    handle = None
    current = None
    pending_meta = []
    size = 0
    last_end = 0
    copied = 0
    count = 0

    def read(n):
        result = bytearray()
        while len(result) < n:
            part = inp.read(n - len(result))
            if not part:
                raise ValueError('incomplete migration stream')
            result.extend(part)
        return bytes(result)

    def finish_meta(full, meta, link=False):
        if os.geteuid() == 0:
            os.chown(full, meta['uid'], meta['gid'], follow_symlinks=False)
        if not link:
            os.chmod(full, meta['mode'], follow_symlinks=False)
        os.utime(full, ns=(meta['mtime_ns'], meta['mtime_ns']), follow_symlinks=False)

    try:
        while True:
            header = read(4)
            length = struct.unpack('!I', header)[0]
            if not 0 < length <= 65536:
                raise ValueError('invalid frame length')
            raw = read(length)
            meta = json.loads(raw)
            kind = meta['type']
            if kind == 'end':
                if handle is not None or meta['sha256'] != digest.hexdigest():
                    raise ValueError('migration checksum mismatch')
                for full, info, link in reversed(pending_meta):
                    if link:
                        os.symlink(info['target'], full)
                    finish_meta(full, info, link)
                for name in ('run', 'slot-bin'):
                    os.mkdir(os.path.join(root, name), 0o700)
                print(json.dumps({'copied_bytes': copied, 'sha256': digest.hexdigest()}))
                return
            digest.update(header + raw)
            if kind == 'data':
                length = meta['length']
                offset = meta['offset']
                if handle is None or not 0 < length <= CHUNK or not last_end <= offset <= size - length:
                    raise ValueError('invalid file extent')
                data = read(length)
                digest.update(data)
                handle.seek(offset)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
                last_end = offset + length
                copied += length
                continue
            if kind == 'close':
                if handle is None:
                    raise ValueError('no open file')
                handle.truncate(size)
                handle.flush()
                os.fsync(handle.fileno())
                handle.close()
                handle = None
                finish_meta(*current)
                continue
            if handle is not None:
                raise ValueError('missing file terminator')
            rel = meta['path']
            parts = rel.split('/')
            if not rel or any(p in ('', '.', '..') for p in parts) or parts[0] in EXCLUDE:
                raise ValueError('invalid relative path')
            full = os.path.join(root, *parts)
            # Links are installed only after all regular files, so no write can follow one.
            count += 1
            if count > 100000:
                raise ValueError('too many files')
            if kind == 'dir':
                os.mkdir(full, 0o700)
                pending_meta.append((full, meta, False))
            elif kind == 'link':
                pending_meta.append((full, meta, True))
            elif kind == 'file':
                size = meta['size']
                if not isinstance(size, int) or not 0 <= size <= 1024 ** 4:
                    raise ValueError('invalid file size')
                handle = open(full, 'xb')
                last_end = 0
                current = (full, meta)
            else:
                raise ValueError('unknown entry type')
    except BaseException:
        if handle is not None:
            handle.close()
        shutil.rmtree(root)
        raise


def main():
    action, root = sys.argv[1:3]
    if action == 'probe':
        print(json.dumps(probe(root)))
    elif action == 'send':
        send(root)
    elif action == 'receive':
        receive(root, sys.argv[3])
    elif action == 'publish':
        target, token = sys.argv[3:5]
        owned(root, token)
        if os.path.lexists(target):
            raise ValueError('destination already exists')
        os.rename(root, target)
    elif action == 'remove':
        if os.path.lexists(root):
            owned(root, sys.argv[3])
            shutil.rmtree(root)
    elif action == 'unmark':
        owned(root, sys.argv[3])
        os.unlink(os.path.join(root, MARKER))
    else:
        raise ValueError('unsupported action')


if __name__ == '__main__':
    main()
