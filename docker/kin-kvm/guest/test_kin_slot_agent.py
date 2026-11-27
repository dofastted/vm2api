#!/usr/bin/env python3
"""Unit tests for docker/kin-kvm/guest/kin-slot-agent RPC daemon."""

from __future__ import annotations

import base64
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

AGENT_PATH = Path(__file__).resolve().parent / "kin-slot-agent"


def _load_agent_module():
    loader = importlib.machinery.SourceFileLoader("kin_slot_agent", str(AGENT_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = mod
    loader.exec_module(mod)
    return mod


agent = _load_agent_module()


def _b64_and_sha(data: bytes) -> tuple[str, str]:
    return base64.b64encode(data).decode("ascii"), hashlib.sha256(data).hexdigest()


class KinSlotAgentRpcTests(unittest.TestCase):
    def setUp(self) -> None:
        self.token = secrets.token_hex(32)
        # Base workspace in /tmp (ext4 on WSL/Linux); real tmpfs crag_root under /dev/shm.
        self.tmp_root = Path(tempfile.mkdtemp(prefix="kin-agent-test-"))
        self.state_dir = self.tmp_root / "state"
        self.run_dir = self.tmp_root / "run"
        self.managed_dir = self.tmp_root / "managed-settings.d"
        self.store_dir = self.tmp_root / "store"
        self.dmi_dir = self.tmp_root / "dmi"
        for d in (self.state_dir / "claude", self.run_dir, self.managed_dir, self.store_dir, self.dmi_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.machine_id = "0123456789abcdef0123456789abcdef"
        self.machine_id_file = self.state_dir / "machine-id"
        self.machine_id_file.write_text(self.machine_id + "\n", encoding="utf-8")
        (self.run_dir / "store-mount-type").write_text("virtiofs\n", encoding="utf-8")
        (self.dmi_dir / "bios_vendor").write_text("HP\n", encoding="utf-8")
        (self.dmi_dir / "sys_vendor").write_text("HP\n", encoding="utf-8")
        (self.dmi_dir / "product_name").write_text("HP EliteBook 840 14 inch G9 Notebook PC\n", encoding="utf-8")
        (self.dmi_dir / "product_uuid").write_text("11111111-2222-4333-8444-555555555555\n", encoding="utf-8")
        (self.dmi_dir / "chassis_vendor").write_text("HP\n", encoding="utf-8")

        shm_base = Path("/dev/shm")
        if shm_base.is_dir() and agent.path_fs_magic(shm_base) == agent.TMPFS_MAGIC:
            self.crag_root = Path(tempfile.mkdtemp(prefix="kin-agent-crag-", dir="/dev/shm"))
            self.has_real_tmpfs = True
        else:
            self.crag_root = self.tmp_root / "crag-not-tmpfs"
            self.crag_root.mkdir(parents=True, exist_ok=True)
            self.has_real_tmpfs = False

        self.crag_pid_file = self.run_dir / "crag.pid"
        self.sock_path = self.tmp_root / "agent.sock"
        self.cfg = agent.AgentConfig(
            token=self.token,
            state_dir=self.state_dir,
            run_dir=self.run_dir,
            crag_root=self.crag_root,
            managed_preset_dir=self.managed_dir,
            store_dir=self.store_dir,
            machine_id_file=self.machine_id_file,
            crag_pid_file=self.crag_pid_file,
            dmi_dir=self.dmi_dir,
            kincli_uid=os.getuid(),
            kincli_gid=os.getgid(),
            project_mounts=False,
        )
        self.service = agent.SlotAgentService(self.cfg)
        self.stop_event = threading.Event()
        self.server_sock = agent._bind_unix(self.sock_path)
        self.server_thread = threading.Thread(
            target=agent.serve_socket_listener,
            args=(self.service, self.server_sock, self.stop_event),
            daemon=True,
        )
        self.server_thread.start()

    def tearDown(self) -> None:
        self.stop_event.set()
        try:
            self.server_sock.close()
        except OSError:
            pass
        self.server_thread.join(timeout=2)
        shutil.rmtree(self.tmp_root, ignore_errors=True)
        if self.has_real_tmpfs and self.crag_root.exists():
            shutil.rmtree(self.crag_root, ignore_errors=True)

    def _rpc(self, payload: dict) -> dict:
        raw = (json.dumps(payload) + "\n").encode("utf-8")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(5)
            s.connect(str(self.sock_path))
            s.sendall(raw)
            buf = bytearray()
            while b"\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf.extend(chunk)
        return json.loads(buf.decode("utf-8").strip())

    def test_auth_rejects_missing_or_wrong_token_and_unknown_op(self) -> None:
        bad = self._rpc({"id": "r1", "token": "0" * 64, "op": "status", "params": {}})
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["id"], "r1")
        self.assertEqual(bad["error"], "unauthorized")

        missing = self._rpc({"id": "r2", "op": "status", "params": {}})
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["error"], "unauthorized")

        unknown = self._rpc({"id": "r3", "token": self.token, "op": "exec_shell", "params": {}})
        self.assertFalse(unknown["ok"])
        self.assertEqual(unknown["error"], "unknown_op")

    def test_line_and_content_size_limits(self) -> None:
        oversized_line = b"a" * (agent.MAX_LINE_BYTES + 128) + b"\n"
        resp = json.loads(agent.process_line(self.service, oversized_line).decode("utf-8"))
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"], "line_too_large")

        too_big = b"x" * (agent.MAX_CONTENT_BYTES + 1)
        b64, sha = _b64_and_sha(too_big)
        resp2 = self._rpc({
            "id": "r-big",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "kernel_config", "content_b64": b64, "sha256": sha},
        })
        self.assertFalse(resp2["ok"])
        self.assertEqual(resp2["error"], "invalid_params")

    def test_sync_file_all_targets_atomicity_permissions_and_guards(self) -> None:
        creds = b'{"claudeAiOauth":{"accessToken":"tok-1"}}\n'
        b64, sha = _b64_and_sha(creds)
        res = self._rpc({
            "id": "s1",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "credentials", "content_b64": b64, "sha256": sha},
        })
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["result"]["target"], "credentials")
        self.assertEqual(res["result"]["sha256"], sha)
        self.assertEqual(res["result"]["bytes"], len(creds))
        cred_path = self.state_dir / "claude" / "credentials.json"
        dot_cred_path = self.state_dir / "claude" / ".credentials.json"
        self.assertEqual(res["result"]["path"], str(cred_path))
        self.assertEqual(cred_path.read_bytes(), creds)
        self.assertEqual(stat.S_IMODE(cred_path.stat().st_mode), 0o600)
        self.assertTrue(dot_cred_path.is_symlink())
        self.assertEqual(os.readlink(dot_cred_path), "credentials.json")
        self.assertEqual(dot_cred_path.read_bytes(), creds)

        # Updating credentials atomically replaces credentials.json while keeping .credentials.json symlink intact.
        creds2 = b'{"claudeAiOauth":{"accessToken":"tok-2"}}\n'
        b64_2, sha_2 = _b64_and_sha(creds2)
        res_upd = self._rpc({
            "id": "s1-upd",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "credentials", "content_b64": b64_2, "sha256": sha_2},
        })
        self.assertTrue(res_upd["ok"], res_upd)
        self.assertEqual(cred_path.read_bytes(), creds2)
        self.assertTrue(dot_cred_path.is_symlink())
        self.assertEqual(os.readlink(dot_cred_path), "credentials.json")
        self.assertEqual(dot_cred_path.read_bytes(), creds2)

        kcfg = b'{"disable_dumpable":true,"listen_vsock_port":7070}\n'
        b64, sha = _b64_and_sha(kcfg)
        res2 = self._rpc({
            "id": "s2",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "kernel_config", "content_b64": b64, "sha256": sha},
        })
        self.assertTrue(res2["ok"], res2)
        self.assertEqual((self.run_dir / "kernel.json").read_bytes(), kcfg)
        self.assertEqual(stat.S_IMODE((self.run_dir / "kernel.json").stat().st_mode), 0o640)

        preset = b'{"theme":"dark","env":{"TZ":"America/Los_Angeles","LANG":"en_US.UTF-8"}}\n'
        b64, sha = _b64_and_sha(preset)
        res3 = self._rpc({
            "id": "s3",
            "token": self.token,
            "op": "sync_file",
            "params": {
                "target": "managed_preset",
                "name": "10-slot-preset.json",
                "content_b64": b64,
                "sha256": sha,
            },
        })
        self.assertTrue(res3["ok"], res3)
        self.assertEqual((self.managed_dir / "10-slot-preset.json").read_bytes(), preset)
        self.assertEqual(stat.S_IMODE((self.managed_dir / "10-slot-preset.json").stat().st_mode), 0o644)

        # Verify optional --claude-dir override (used by custom-erofs whole-$HOME bind mount)
        # while keeping default state_dir/claude backward compatible above.
        custom_claude_dir = self.state_dir / "home" / ".claude"
        custom_cfg = agent.AgentConfig(
            token=self.token,
            state_dir=self.state_dir,
            claude_dir=custom_claude_dir,
            run_dir=self.run_dir,
            crag_root=self.crag_root,
            managed_preset_dir=self.managed_dir,
            store_dir=self.store_dir,
            machine_id_file=self.machine_id_file,
            crag_pid_file=self.crag_pid_file,
            dmi_dir=self.dmi_dir,
            kincli_uid=os.getuid(),
            kincli_gid=os.getgid(),
            project_mounts=False,
        )
        custom_svc = agent.SlotAgentService(custom_cfg)
        res_custom = custom_svc.handle_request({
            "id": "s-custom-claude",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "credentials", "content_b64": b64_2, "sha256": sha_2},
        })
        self.assertTrue(res_custom["ok"], res_custom)
        self.assertEqual(res_custom["result"]["path"], str(custom_claude_dir / "credentials.json"))
        self.assertEqual((custom_claude_dir / "credentials.json").read_bytes(), creds2)
        self.assertEqual(stat.S_IMODE((custom_claude_dir / "credentials.json").stat().st_mode), 0o600)
        self.assertTrue((custom_claude_dir / ".credentials.json").is_symlink())
        self.assertEqual(os.readlink(custom_claude_dir / ".credentials.json"), "credentials.json")
        self.assertEqual((custom_claude_dir / ".credentials.json").read_bytes(), creds2)

        # Reject sha256 mismatch
        bad_sha = self._rpc({
            "id": "s-bad-sha",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "kernel_config", "content_b64": b64, "sha256": "a" * 64},
        })
        self.assertFalse(bad_sha["ok"])
        self.assertEqual(bad_sha["error"], "sha256_mismatch")

        # Reject path traversal in managed_preset name
        bad_name = self._rpc({
            "id": "s-bad-name",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "managed_preset", "name": "../escape.json", "content_b64": b64, "sha256": sha},
        })
        self.assertFalse(bad_name["ok"])
        self.assertEqual(bad_name["error"], "invalid_params")

        # Reject forbidden Self-Probe conflict env keys in managed_preset
        bad_preset = b'{"env":{"CLAUDE_CODE_ATTRIBUTION_HEADER":"0"}}'
        pb64, psha = _b64_and_sha(bad_preset)
        bad_conflict = self._rpc({
            "id": "s-bad-preset",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "managed_preset", "name": "20-bad.json", "content_b64": pb64, "sha256": psha},
        })
        self.assertFalse(bad_conflict["ok"])
        self.assertEqual(bad_conflict["error"], "invalid_params")

        # Reject symlink destination via O_NOFOLLOW
        link_dest = self.managed_dir / "30-link.json"
        link_dest.symlink_to(self.tmp_root / "outside.json")
        bad_link = self._rpc({
            "id": "s-symlink",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "managed_preset", "name": "30-link.json", "content_b64": b64, "sha256": sha},
        })
        self.assertFalse(bad_link["ok"])
        self.assertEqual(bad_link["error"], "unsafe_path")

    def test_sync_file_worker_config_atomicity_permissions_and_guards(self) -> None:
        wcfg = b'{"vm_id":"vm-erofs-1","egress_mode":"transparent","proxy_url":""}\n'
        wb64, wsha = _b64_and_sha(wcfg)
        res = self._rpc({
            "id": "w1",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "worker_config", "content_b64": wb64, "sha256": wsha},
        })
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["result"]["target"], "worker_config")
        worker_path = self.run_dir / "worker.json"
        self.assertEqual(res["result"]["path"], str(worker_path))
        self.assertEqual(res["result"]["sha256"], wsha)
        self.assertEqual(res["result"]["bytes"], len(wcfg))
        self.assertEqual(worker_path.read_bytes(), wcfg)
        self.assertEqual(stat.S_IMODE(worker_path.stat().st_mode), 0o600)
        self.assertEqual(list(self.run_dir.glob(".kin-tmp-*")), [])

        # Atomic replacement updates content and preserves 0600 permissions.
        wcfg2 = b'{"vm_id":"vm-erofs-1","egress_mode":"transparent","proxy_url":"","rev":2}\n'
        wb64_2, wsha_2 = _b64_and_sha(wcfg2)
        res2 = self._rpc({
            "id": "w2",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "worker_config", "content_b64": wb64_2, "sha256": wsha_2},
        })
        self.assertTrue(res2["ok"], res2)
        self.assertEqual(worker_path.read_bytes(), wcfg2)
        self.assertEqual(stat.S_IMODE(worker_path.stat().st_mode), 0o600)

        # Reject sha256 mismatch
        bad_sha = self._rpc({
            "id": "w-bad-sha",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "worker_config", "content_b64": wb64_2, "sha256": "b" * 64},
        })
        self.assertFalse(bad_sha["ok"])
        self.assertEqual(bad_sha["error"], "sha256_mismatch")

        # Reject symlink at /run/kin/worker.json via O_NOFOLLOW
        worker_path.unlink()
        worker_path.symlink_to(self.tmp_root / "outside-worker.json")
        bad_link = self._rpc({
            "id": "w-symlink",
            "token": self.token,
            "op": "sync_file",
            "params": {"target": "worker_config", "content_b64": wb64_2, "sha256": wsha_2},
        })
        self.assertFalse(bad_link["ok"])
        self.assertEqual(bad_link["error"], "unsafe_path")

    def test_managed_preset_rejects_proxy_and_auth_env_keys(self) -> None:
        expected_forbidden = {
            "CLAUDE_CODE_ATTRIBUTION_HEADER",
            "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        }
        self.assertTrue(expected_forbidden.issubset(agent.FORBIDDEN_MANAGED_ENV_KEYS))

        cases = sorted(expected_forbidden) + ["Http_Proxy", "anthropic_base_url", "No_Proxy"]
        for idx, key in enumerate(cases):
            body = json.dumps({"env": {key: "http://127.0.0.1:9999"}}).encode("utf-8")
            b64, sha = _b64_and_sha(body)
            preset_name = f"20-forbidden-{idx}.json"
            resp = self._rpc({
                "id": f"fp-{idx}",
                "token": self.token,
                "op": "sync_file",
                "params": {
                    "target": "managed_preset",
                    "name": preset_name,
                    "content_b64": b64,
                    "sha256": sha,
                },
            })
            self.assertFalse(resp["ok"], f"expected key {key} to be rejected")
            self.assertEqual(resp["error"], "invalid_params")
            self.assertFalse((self.managed_dir / preset_name).exists())

    def test_restart_crag_live_empty_stale_zombie_and_uid_guards(self) -> None:
        # Missing crag.pid -> ok=True, signaled=False, pid=None
        res_missing = self._rpc({"id": "rc-miss", "token": self.token, "op": "restart_crag", "params": {}})
        self.assertTrue(res_missing["ok"], res_missing)
        self.assertEqual(res_missing["result"], {"signaled": False, "pid": None})

        # Empty / invalid / non-positive pid -> ok=True, signaled=False, pid=None
        for idx, raw in enumerate(("", "   \n", "not-a-pid\n", "0\n", "-42\n")):
            self.crag_pid_file.write_text(raw, encoding="utf-8")
            res = self._rpc({"id": f"rc-empty-{idx}", "token": self.token, "op": "restart_crag", "params": {}})
            self.assertTrue(res["ok"], res)
            self.assertEqual(res["result"], {"signaled": False, "pid": None})

        # Dead/stale PID -> ok=True, signaled=False, pid=None
        short = subprocess.Popen([sys.executable, "-c", "pass"])
        short.wait(timeout=5)
        self.crag_pid_file.write_text(f"{short.pid}\n", encoding="utf-8")
        res_stale = self._rpc({"id": "rc-stale", "token": self.token, "op": "restart_crag", "params": {}})
        self.assertTrue(res_stale["ok"], res_stale)
        self.assertEqual(res_stale["result"], {"signaled": False, "pid": None})

        # Protected PIDs (PID 1 and self PID) must be refused fail-closed without signaling.
        for label, bad_pid in (("init", 1), ("self", os.getpid())):
            self.crag_pid_file.write_text(f"{bad_pid}\n", encoding="utf-8")
            res_prot = self._rpc({"id": f"rc-prot-{label}", "token": self.token, "op": "restart_crag", "params": {}})
            self.assertFalse(res_prot["ok"], res_prot)
            self.assertEqual(res_prot["error"], "unsafe_pid")

        # Symlink crag.pid must be refused via O_NOFOLLOW.
        self.crag_pid_file.unlink()
        target_pid = self.tmp_root / "outside.pid"
        target_pid.write_text("999999\n", encoding="utf-8")
        self.crag_pid_file.symlink_to(target_pid)
        res_sym = self._rpc({"id": "rc-sym", "token": self.token, "op": "restart_crag", "params": {}})
        self.assertFalse(res_sym["ok"], res_sym)
        self.assertEqual(res_sym["error"], "unsafe_path")
        self.crag_pid_file.unlink()

        # Live process owned by matching kincli_uid -> SIGTERM sent and process terminates.
        live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.crag_pid_file.write_text(f"{live.pid}\n", encoding="utf-8")
            res_live = self._rpc({"id": "rc-live", "token": self.token, "op": "restart_crag", "params": {}})
            self.assertTrue(res_live["ok"], res_live)
            self.assertEqual(res_live["result"], {"signaled": True, "pid": live.pid})
            rc = live.wait(timeout=5)
            self.assertEqual(rc, -signal.SIGTERM)
        finally:
            if live.poll() is None:
                live.kill()
                live.wait(timeout=5)

        # Zombie process (exited, not yet reaped) must be treated as not running.
        zombie = subprocess.Popen([sys.executable, "-c", "import sys; sys.exit(0)"])
        try:
            deadline = time.time() + 5.0
            while time.time() < deadline:
                info = agent._read_process_info(zombie.pid)
                if info is not None and info[0] == "Z":
                    break
                time.sleep(0.02)
            self.crag_pid_file.write_text(f"{zombie.pid}\n", encoding="utf-8")
            res_zombie = self._rpc({"id": "rc-zombie", "token": self.token, "op": "restart_crag", "params": {}})
            self.assertTrue(res_zombie["ok"], res_zombie)
            self.assertEqual(res_zombie["result"], {"signaled": False, "pid": None})
            st_zombie = self._rpc({"id": "st-zombie", "token": self.token, "op": "status", "params": {}})
            self.assertTrue(st_zombie["ok"], st_zombie)
            self.assertIsNone(st_zombie["result"]["crag_pid"])
        finally:
            zombie.wait(timeout=5)

        # Unauthorized UID protection: refuse to signal a live process whose UID != kincli_uid.
        foreign = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.crag_pid_file.write_text(f"{foreign.pid}\n", encoding="utf-8")
            other_uid = os.getuid() + 1 if os.getuid() < 60000 else 65534
            mismatch_cfg = agent.AgentConfig(
                token=self.token,
                state_dir=self.state_dir,
                run_dir=self.run_dir,
                crag_root=self.crag_root,
                managed_preset_dir=self.managed_dir,
                store_dir=self.store_dir,
                machine_id_file=self.machine_id_file,
                crag_pid_file=self.crag_pid_file,
                dmi_dir=self.dmi_dir,
                kincli_uid=other_uid,
                kincli_gid=os.getgid(),
                project_mounts=False,
            )
            mismatch_svc = agent.SlotAgentService(mismatch_cfg)
            res_uid = mismatch_svc.handle_request({
                "id": "rc-uid",
                "token": self.token,
                "op": "restart_crag",
                "params": {},
            })
            self.assertFalse(res_uid["ok"], res_uid)
            self.assertEqual(res_uid["error"], "pid_uid_mismatch")
            time.sleep(0.1)
            self.assertIsNone(foreign.poll(), "unauthorized process must NOT be killed")
        finally:
            foreign.terminate()
            foreign.wait(timeout=5)

    def test_publish_universal_block_clear_on_real_tmpfs_and_reject_non_tmpfs(self) -> None:
        if not self.has_real_tmpfs:
            self.skipTest("/dev/shm tmpfs not available")

        dev_bytes = b'{"vm_id":"vm-1"}\n'
        db64, dsha = _b64_and_sha(dev_bytes)
        pub = self._rpc({
            "id": "p1",
            "token": self.token,
            "op": "publish",
            "params": {
                "scope": "license",
                "files": [{"rel": "device.json", "content_b64": db64, "sha256": dsha}],
            },
        })
        self.assertTrue(pub["ok"], pub)
        self.assertEqual(pub["result"]["scope"], "license")
        self.assertEqual(pub["result"]["count"], 1)
        self.assertEqual((self.crag_root / "license" / "device.json").read_bytes(), dev_bytes)

        uni_bytes = b"CRAGU1.test-permit\n"
        ub64, usha = _b64_and_sha(uni_bytes)
        uni = self._rpc({
            "id": "p2",
            "token": self.token,
            "op": "publish_universal",
            "params": {"files": [{"rel": "registration.code", "content_b64": ub64, "sha256": usha}]},
        })
        self.assertTrue(uni["ok"], uni)
        self.assertEqual(uni["result"]["scope"], "license")
        self.assertTrue(uni["result"]["universal"])
        reg_path = self.crag_root / "license" / "registration.code"
        self.assertEqual(reg_path.read_bytes(), uni_bytes)
        self.assertEqual(stat.S_IMODE(reg_path.stat().st_mode), 0o600)

        uni_host = self._rpc({
            "id": "p2-host",
            "token": self.token,
            "op": "publish_universal",
            "params": {"scope": "host", "files": [{"rel": "entitlement.code", "content_b64": ub64, "sha256": usha}]},
        })
        self.assertTrue(uni_host["ok"], uni_host)
        self.assertEqual(uni_host["result"]["scope"], "host")
        self.assertEqual((self.crag_root / "host" / "entitlement.code").read_bytes(), uni_bytes)

        # Reject rel traversal
        bad_rel = self._rpc({
            "id": "p-bad-rel",
            "token": self.token,
            "op": "publish",
            "params": {
                "scope": "host",
                "files": [{"rel": "../pwn", "content_b64": ub64, "sha256": usha}],
            },
        })
        self.assertFalse(bad_rel["ok"])
        self.assertEqual(bad_rel["error"], "invalid_params")

        blk = self._rpc({
            "id": "b1",
            "token": self.token,
            "op": "block",
            "params": {"scope": "all", "reason": "maintenance"},
        })
        self.assertTrue(blk["ok"], blk)
        self.assertTrue((self.crag_root / "license" / "sync-pending").is_file())
        self.assertTrue((self.crag_root / "host" / "sync-pending").is_file())

        clr = self._rpc({
            "id": "c1",
            "token": self.token,
            "op": "clear",
            "params": {"scope": "all"},
        })
        self.assertTrue(clr["ok"], clr)
        self.assertFalse((self.crag_root / "license" / "device.json").exists())
        self.assertFalse((self.crag_root / "license" / "registration.code").exists())
        self.assertFalse((self.crag_root / "host" / "entitlement.code").exists())
        self.assertFalse((self.crag_root / "host" / "sync-pending").exists())

        # Verify fail-closed rejection when crag_root is NOT tmpfs (e.g. /tmp ext4).
        non_tmpfs_dir = self.tmp_root / "ext4-crag"
        non_tmpfs_dir.mkdir(parents=True, exist_ok=True)
        non_tmpfs_cfg = agent.AgentConfig(
            token=self.token,
            state_dir=self.state_dir,
            run_dir=self.run_dir,
            crag_root=non_tmpfs_dir,
            managed_preset_dir=self.managed_dir,
            project_mounts=False,
        )
        non_tmpfs_svc = agent.SlotAgentService(non_tmpfs_cfg)
        rejected = non_tmpfs_svc.handle_request({
            "id": "p-ext4",
            "token": self.token,
            "op": "publish",
            "params": {
                "scope": "host",
                "files": [{"rel": "host_id", "content_b64": ub64, "sha256": usha}],
            },
        })
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["error"], "tmpfs_required")

    def test_status_and_core_check_against_live_process(self) -> None:
        # Before crag runs, crag_pid and crag_dumpable must both be None.
        st_idle = self._rpc({"id": "st0", "token": self.token, "op": "status", "params": {}})
        self.assertTrue(st_idle["ok"], st_idle)
        self.assertIsNone(st_idle["result"]["crag_pid"])
        self.assertIsNone(st_idle["result"]["crag_dumpable"])

        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.crag_pid_file.write_text(f"{proc.pid}\n", encoding="utf-8")
            st = self._rpc({"id": "st1", "token": self.token, "op": "status", "params": {}})
            self.assertTrue(st["ok"], st)
            res = st["result"]
            self.assertEqual(res["machine_id"], self.machine_id)
            self.assertEqual(res["store_mount_type"], "virtiofs")
            self.assertEqual(res["crag_pid"], proc.pid)
            self.assertTrue(res["dmi_present"])
            self.assertIsInstance(res["dmi"], dict)
            self.assertEqual(res["dmi"]["bios_vendor"], "HP")
            self.assertEqual(res["dmi"]["sys_vendor"], "HP")
            self.assertEqual(res["dmi"]["product_name"], "HP EliteBook 840 14 inch G9 Notebook PC")
            self.assertEqual(res["dmi"]["product_uuid"], "11111111-2222-4333-8444-555555555555")
            self.assertEqual(res["dmi"]["chassis_vendor"], "HP")
            self.assertIsNone(res["dmi"]["board_serial"])
            self.assertIsInstance(res["dockerenv_exists"], bool)
            self.assertIsInstance(res["virtio9p_mounts"], int)
            self.assertGreaterEqual(res["virtio9p_mounts"], 0)
            self.assertEqual(set(res["crag_mounts_ro"].keys()), {"license", "host"})
            self.assertIsInstance(res["crag_mounts_ro"]["license"], bool)
            self.assertIsInstance(res["crag_mounts_ro"]["host"], bool)
            if os.geteuid() != 0:
                self.assertEqual(res["crag_dumpable"], 1)
            self.assertIsInstance(res["uptime_sec"], float)
            if self.has_real_tmpfs:
                self.assertEqual(res["tmpfs_magic"], "0x01021994")
                self.assertTrue(res["tmpfs_ok"])

            cc_no_exp = self._rpc({"id": "cc1", "token": self.token, "op": "core_check", "params": {}})
            self.assertTrue(cc_no_exp["ok"], cc_no_exp)
            actual_sha = cc_no_exp["result"]["sha256"]
            self.assertRegex(actual_sha, r"^[0-9a-f]{64}$")
            self.assertEqual(cc_no_exp["result"]["crag_pid"], proc.pid)
            self.assertTrue(cc_no_exp["result"]["exe_target"])
            self.assertIsNone(cc_no_exp["result"]["matches"])

            cc_match = self._rpc({
                "id": "cc2",
                "token": self.token,
                "op": "core_check",
                "params": {"expected_sha256": actual_sha},
            })
            self.assertTrue(cc_match["ok"])
            self.assertTrue(cc_match["result"]["matches"])

            cc_mismatch = self._rpc({
                "id": "cc3",
                "token": self.token,
                "op": "core_check",
                "params": {"expected_sha256": "0" * 64},
            })
            self.assertTrue(cc_mismatch["ok"])
            self.assertFalse(cc_mismatch["result"]["matches"])
        finally:
            proc.terminate()
            proc.wait(timeout=5)

        # Verify PR_SET_DUMPABLE=0 is detected accurately as crag_dumpable == 0 for non-root process.
        if os.geteuid() != 0:
            nodump = subprocess.Popen([
                sys.executable,
                "-c",
                "import ctypes, time; ctypes.CDLL('libc.so.6').prctl(4, 0, 0, 0, 0); time.sleep(30)",
            ])
            try:
                time.sleep(0.2)
                self.crag_pid_file.write_text(f"{nodump.pid}\n", encoding="utf-8")
                st_nd = self._rpc({"id": "st-nd", "token": self.token, "op": "status", "params": {}})
                self.assertTrue(st_nd["ok"], st_nd)
                self.assertEqual(st_nd["result"]["crag_dumpable"], 0)
            finally:
                nodump.terminate()
                nodump.wait(timeout=5)

    def test_persistent_multi_request_on_single_connection_and_cli_unix_mode(self) -> None:
        # Persistent multi-request over one socket
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(5)
            s.connect(str(self.sock_path))
            req1 = json.dumps({"id": "m1", "token": self.token, "op": "status", "params": {}}) + "\n"
            req2 = json.dumps({"id": "m2", "token": self.token, "op": "status", "params": {}}) + "\n"
            s.sendall((req1 + req2).encode("utf-8"))
            lines = []
            buf = bytearray()
            while len(lines) < 2:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf.extend(chunk)
                while b"\n" in buf:
                    idx = buf.index(b"\n")
                    lines.append(json.loads(bytes(buf[:idx]).decode("utf-8")))
                    del buf[: idx + 1]
            self.assertEqual([r["id"] for r in lines], ["m1", "m2"])
            self.assertTrue(all(r["ok"] for r in lines))

        # Subprocess CLI smoke test with --unix-socket (matching reviewer cross-process harness)
        cli_sock = self.tmp_root / "cli-agent.sock"
        tok_file = self.tmp_root / "cli.token"
        tok_file.write_text(self.token + "\n", encoding="utf-8")
        os.chmod(tok_file, 0o600)
        with subprocess.Popen(
            [
                sys.executable,
                "-B",
                str(AGENT_PATH),
                "--unix-socket",
                str(cli_sock),
                "--token-file",
                str(tok_file),
                "--state-dir",
                str(self.state_dir),
                "--claude-dir",
                str(self.state_dir / "home" / ".claude"),
                "--run-dir",
                str(self.run_dir),
                "--crag-root",
                str(self.crag_root),
                "--managed-preset-dir",
                str(self.managed_dir),
                "--store-dir",
                str(self.store_dir),
                "--machine-id-file",
                str(self.machine_id_file),
                "--crag-pid-file",
                str(self.crag_pid_file),
                "--dmi-dir",
                str(self.dmi_dir),
                "--no-mount-project",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ) as proc:
            try:
                deadline = time.time() + 5.0
                while not cli_sock.exists() and time.time() < deadline:
                    time.sleep(0.05)
                self.assertTrue(cli_sock.exists(), "kin-slot-agent CLI failed to bind unix socket")
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                    s.settimeout(5)
                    s.connect(str(cli_sock))
                    s.sendall(
                        (json.dumps({"id": "cli1", "token": self.token, "op": "status", "params": {}}) + "\n").encode()
                    )
                    data = s.recv(65536).decode("utf-8").strip()
                reply = json.loads(data)
                self.assertTrue(reply["ok"])
                self.assertEqual(reply["id"], "cli1")
                self.assertEqual(reply["result"]["machine_id"], self.machine_id)
            finally:
                proc.terminate()
                proc.wait(timeout=5)

    def test_kernel_relay_port_config_and_tcp_to_unix_roundtrip(self) -> None:
        relay_path = Path(__file__).resolve().parent / "kin-kernel-relay.py"
        echo_sock = self.tmp_root / "kernel-echo.sock"
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(echo_sock))
        srv.listen(4)
        srv.settimeout(5)

        def _echo_once() -> None:
            try:
                conn, _ = srv.accept()
                with conn:
                    data = conn.recv(4096)
                    if data:
                        conn.sendall(b"echo:" + data)
            except OSError:
                pass

        echo_thread = threading.Thread(target=_echo_once, daemon=True)
        echo_thread.start()

        # Pick an ephemeral free localhost TCP port for the relay subprocess.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]

        env = os.environ.copy()
        env["KIN_RELAY_HOST"] = "127.0.0.1"
        env["KIN_VSOCK_PORT"] = str(port)
        env["KIN_RELAY_UNIX"] = str(echo_sock)
        with subprocess.Popen(
            [sys.executable, "-B", str(relay_path)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ) as relay:
            try:
                got = b""
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
                            client.sendall(b"ping-relay")
                            client.shutdown(socket.SHUT_WR)
                            got = client.recv(4096)
                            break
                    except OSError:
                        time.sleep(0.05)
                self.assertEqual(got, b"echo:ping-relay")
            finally:
                relay.terminate()
                relay.wait(timeout=5)
                srv.close()
                echo_thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
