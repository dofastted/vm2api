#!/usr/bin/env python3
"""Track one slot-local login PID without storing CLI output or credentials."""
import json
import os
from pathlib import Path
import signal
import sys
import time


def start_time(pid):
    try:
        # comm can contain spaces, so fields start after the last closing parenthesis.
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def main():
    operation, filename = sys.argv[1:3]
    file = Path(filename)
    if operation == 'start':
        if Path(filename + '.cancel').exists():
            return
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        pid = os.getpid()
        file.write_text(json.dumps({'pid': pid, 'start': start_time(pid)}))
        file.chmod(0o600)
        if Path(filename + '.cancel').exists():
            file.unlink(missing_ok=True)
            return
        os.execvp(sys.argv[3], sys.argv[3:])
    elif operation == 'stop':
        Path(filename + '.cancel').touch(mode=0o600)
        try:
            record = json.loads(file.read_text())
            pid = int(record['pid'])
            expected = record['start']
        except (OSError, ValueError, KeyError):
            return
        if pid > 1 and expected and start_time(pid) == expected:
            try:
                os.kill(pid, signal.SIGTERM)
                for _ in range(20):
                    if start_time(pid) != expected:
                        break
                    time.sleep(0.025)
                else:
                    if start_time(pid) == expected:
                        os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        file.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
