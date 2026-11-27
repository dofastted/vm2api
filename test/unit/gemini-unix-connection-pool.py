import threading
import time
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("gemini_host_native", ROOT / "scripts/gemini_host_native.py")
native = module_from_spec(spec)
spec.loader.exec_module(native)

Pool = native._UnixConnectionPool
MAX_PER_PATH = native.CONTROL_CONN_POOL_MAX_PER_PATH
MAX_IDLE_GLOBAL = native.CONTROL_CONN_POOL_MAX_IDLE_GLOBAL


class FakeSock:
    __slots__ = ("closed", "label")

    def __init__(self, label):
        self.label = label
        self.closed = False

    def close(self):
        self.closed = True


def fresh_pool(**kwargs):
    defaults = {
        "max_per_path": MAX_PER_PATH,
        "max_idle_global": MAX_IDLE_GLOBAL,
    }
    defaults.update(kwargs)
    return Pool(**defaults)


def seed_idle(pool, path, socks, *, age=60.0):
    now = time.monotonic()
    with pool._lock:
        pool._idle[path] = [(sock, now - age) for sock in socks]


def cross_path_expiry_eviction():
    pool = fresh_pool(idle_ttl=1.0)
    stale = FakeSock("stale")
    seed_idle(pool, "/retired.sock", [stale])
    assert pool.acquire("/other.sock") is None
    assert stale.closed
    assert "/retired.sock" not in pool._idle


def global_idle_cap():
    pool = fresh_pool(max_idle_global=4, idle_ttl=30.0)
    kept = []
    for i in range(6):
        sock = FakeSock(f"g{i}")
        kept.append(sock)
        pool.release(f"/sock-{i}", sock)
    live = []
    with pool._lock:
        for bucket in pool._idle.values():
            for sock, _ in bucket:
                if not sock.closed:
                    live.append(sock)
    assert len(live) == 4
    assert sum(1 for s in kept if s.closed) == 2


def empty_bucket_cleanup_and_reuse():
    pool = fresh_pool(idle_ttl=0.05)
    path = "/kernel.sock"
    first = FakeSock("first")
    pool.release(path, first)
    time.sleep(0.08)
    assert pool.acquire(path) is None
    assert path not in pool._idle
    second = FakeSock("second")
    pool.release(path, second)
    reused = pool.acquire(path)
    assert reused is second
    assert not second.closed


def per_path_cap_still_eight():
    pool = fresh_pool(idle_ttl=30.0, max_idle_global=256)
    path = "/same.sock"
    socks = [FakeSock(f"p{i}") for i in range(MAX_PER_PATH + 2)]
    for sock in socks:
        pool.release(path, sock)
    live = [s for s in socks if not s.closed]
    assert len(live) == MAX_PER_PATH
    assert sum(1 for s in socks if s.closed) == 2


def concurrent_acquire_release():
    pool = fresh_pool(idle_ttl=30.0, max_idle_global=32)
    path = "/busy.sock"
    errors = []

    def worker(idx):
        try:
            for _ in range(40):
                sock = pool.acquire(path)
                if sock is None:
                    sock = FakeSock(f"t{idx}")
                else:
                    assert not sock.closed
                pool.release(path, sock)
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors
    with pool._lock:
        total = sum(len(b) for b in pool._idle.values())
    assert total <= min(MAX_PER_PATH, 32)


cross_path_expiry_eviction()
global_idle_cap()
empty_bucket_cleanup_and_reuse()
per_path_cap_still_eight()
concurrent_acquire_release()

print("gemini-unix-connection-pool: ok")