#!/usr/bin/env python3
"""Publish trusted assets beneath a slot home without following user symlinks."""
import errno
import json
import os
import re
import secrets
import shutil
import stat
import sys


DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def owned(fd, uid, gid, mode):
    os.fchmod(fd, mode)
    try:
        os.fchown(fd, uid, gid)
    except PermissionError:
        # Local non-root development mirrors the existing ownership helper.
        # Production runs as root and must not publish under the wrong identity.
        if os.geteuid() == 0:
            raise


def open_directory(parent, name, uid, gid, slot_owned=True):
    created = False
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        created = True
    except FileExistsError:
        pass
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        if created and slot_owned:
            owned(fd, uid, gid, 0o700)
        return fd
    except BaseException:
        os.close(fd)
        raise


def parts_of(value):
    if not isinstance(value, str) or not value or value.startswith('/'):
        raise ValueError('A relative slot asset path is required')
    parts = value.split('/')
    if any(part in ('', '.', '..') or '\x00' in part for part in parts):
        raise ValueError('Invalid slot asset path')
    return parts


def parent_directory(home, parts, uid, gid):
    current = os.dup(home)
    try:
        for part in parts:
            next_fd = open_directory(current, part, uid, gid)
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def publish(home, relative, uid, gid, source=None, mode=0o600):
    parts = parts_of(relative)
    parent = parent_directory(home, parts[:-1], uid, gid)
    temporary = f'.{parts[-1]}.{secrets.token_hex(16)}.tmp'
    fd = None
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        if source is not None:
            source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(source_fd, 'rb') as original:
                if not stat.S_ISREG(os.fstat(original.fileno()).st_mode):
                    raise ValueError('The trusted slot asset source must be a regular file')
                with os.fdopen(fd, 'wb', closefd=False) as destination:
                    shutil.copyfileobj(original, destination)
        owned(fd, uid, gid, mode)
        os.fsync(fd)
        os.close(fd)
        fd = None
        # A symlink at the destination is replaced as an entry, never followed.
        os.replace(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=parent)
        except OSError as error:
            if error.errno != errno.ENOENT:
                raise
        finally:
            os.close(parent)


def run(request):
    vm_id = request['vm_id']
    if not isinstance(vm_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', vm_id):
        raise ValueError('Invalid slot id')
    uid, gid = request['uid'], request['gid']
    if not isinstance(uid, int) or not isinstance(gid, int) or uid < 0 or gid < 0:
        raise ValueError('Invalid slot identity')
    root = os.open(request['project_root'], DIR_FLAGS)
    descriptors = [root]
    try:
        vms = open_directory(root, 'vms', uid, gid, slot_owned=False)
        descriptors.append(vms)
        slot = open_directory(vms, vm_id, uid, gid, slot_owned=False)
        descriptors.append(slot)
        home = open_directory(slot, 'cli-home', uid, gid)
        descriptors.append(home)
        for directory in request.get('directories', []):
            fd = parent_directory(home, parts_of(directory), uid, gid)
            os.close(fd)
        for entry in request.get('files', []):
            publish(home, entry['path'], uid, gid, source=entry['source'], mode=0o755)
        for marker in request.get('markers', []):
            publish(home, marker, uid, gid)
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


if __name__ == '__main__':
    try:
        run(json.loads(sys.argv[1]))
    except Exception:
        # Do not print user-controlled paths or file contents into panel errors.
        print('Unable to publish isolated slot assets', file=sys.stderr)
        sys.exit(1)
