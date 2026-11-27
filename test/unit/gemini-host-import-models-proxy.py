"""Regression tests for Gemini host daemon fixes:
(a) UMask=0077 directory creation (0o711) & self-heal on load/refresh/pull_models/Agy.start
(b) OAuth client extraction (all 3 agy clients + ARM64 fallback), oauth_client_key ordering,
    multi-client fallback (including invalid_grant), read_account oauth_clients forwarding,
    and removal of silent access-only fallback trap
(c) File 1 & File 2 RT import metadata forwarding, cache/onboarding.json, and create call_models
(d) OAuth pull_models direct fetchAvailableModels (daily -> production & {} -> {project}) +
    accurate non-502 error propagation
(e) bind_proxy runtime proxy + egress_options persistence, CragDaemonShard egress_options keying,
    and domain-name proxy safety against gemini-host-egress.sh
"""

import json
import os
import struct
import subprocess
import tempfile
import threading
import time
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]


def load_module(name, relative_path):
    spec = spec_from_file_location(name, ROOT / relative_path)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


account_mod = load_module("gemini_host_account_reg", "scripts/gemini_host_account.py")
host_mod = load_module("gemini_host_reg", "scripts/gemini-host.py")

PROXY = "socks5h://fixture:private-proxy@192.0.2.11:1080"
PROXY2 = "http://fixture:other-proxy@proxy.example.com:8080"


class FixtureHost(host_mod.Host):
    def payload_config(self):
        return self.payload, True, self.public_key, None, "0.5.3"

    def payload_identity(self, source, public_key, digest):
        return digest

    def verify_payload(self, source, public_key, install=False):
        return "0.5.3"

    def recover_network(self, env_dir, slot):
        pass

    def oauth_runtime_issue(self):
        return None


def _make_args(directory):
    return SimpleNamespace(
        state=directory,
        uid_base=1000,
        payload=directory / "payload",
        payload_source=None,
        public_key=None,
        default_public_key=None,
        default_release_verifier=None,
        release_verifier=None,
        egress=directory / "kin-egress",
    )


def _build_synthetic_elf64(
    rodata_bytes, text_bytes, *, text_va=0x401000, ro_va=0x402000, e_machine=62
):
    shstr = b"\x00.text\x00.rodata\x00.shstrtab\x00"
    hdr_size = 64
    text_off = hdr_size
    ro_off = text_off + len(text_bytes)
    shstr_off = ro_off + len(rodata_bytes)
    shoff = shstr_off + len(shstr)

    e_ident = b"\x7fELF" + bytes([2, 1, 1]) + b"\x00" * 9
    elf_hdr = e_ident + struct.pack(
        "<HHIQQQIHHHHHH",
        2,
        e_machine,
        1,
        text_va,
        0,
        shoff,
        0,
        hdr_size,
        0,
        0,
        64,
        4,
        3,
    )

    def shdr(name_off, sh_type, flags, addr, offset, size):
        return struct.pack(
            "<IIQQQQIIQQ", name_off, sh_type, flags, addr, offset, size, 0, 0, 1, 0
        )

    sh_null = shdr(0, 0, 0, 0, 0, 0)
    sh_text = shdr(1, 1, 6, text_va, text_off, len(text_bytes))
    sh_ro = shdr(7, 1, 2, ro_va, ro_off, len(rodata_bytes))
    sh_str = shdr(15, 3, 0, 0, shstr_off, len(shstr))
    return elf_hdr + text_bytes + rodata_bytes + shstr + sh_null + sh_text + sh_ro + sh_str


def test_a_umask_0077_dir_creation_onboarding_call_models_and_self_heal():
    old_umask = os.umask(0o077)
    try:
        with tempfile.TemporaryDirectory(prefix="gemini-umask-fix-") as tmp:
            state_dir = Path(tmp)
            os.chmod(state_dir, 0o700)
            token_doc = {
                "token": {
                    "access_token": "ya29.fresh-token",
                    "token_type": "Bearer",
                    "refresh_token": "1//06QFile2RefreshToken_abc123",
                    "expiry": "2035-01-01T00:00:00Z",
                },
                "auth_method": "consumer",
            }
            seen_imports = []

            def fake_read_account(uid, proxy_url, method, **kwargs):
                if method == "oauth_refresh_import":
                    seen_imports.append(dict(kwargs.get("oauth_token") or {}))
                    return {
                        "account": {
                            "state": "ok",
                            "email": "user2@gmail.com",
                            "project_id": "aicode-consumers",
                            "plan": "Google AI Pro",
                            "models": ["gemini-3-pro", "claude-sonnet-4-6-high"],
                            "checked_at": "2026-11-28T00:00:00+00:00",
                        },
                        "token_doc": token_doc,
                    }
                if method == "oauth":
                    return {
                        "state": "ok",
                        "email": "user2@gmail.com",
                        "project_id": "aicode-consumers",
                        "plan": "Google AI Pro",
                        "models": ["gemini-3-pro"],
                        "checked_at": "2026-11-28T00:01:00+00:00",
                    }
                if method == "oauth-models":
                    return {
                        "state": "ok",
                        "models": ["gemini-3-pro", "gemini-3-flash"],
                        "quotas": [],
                        "checked_at": "2026-11-28T00:02:00+00:00",
                    }
                raise AssertionError(f"unexpected read_account method: {method}")

            with (
                patch.object(host_mod, "check_root_owned"),
                patch.object(host_mod, "read_account", side_effect=fake_read_account),
                patch.object(host_mod.os, "chown"),
                patch.object(FixtureHost, "_schedule_provision_locked"),
                patch.object(FixtureHost, "_schedule_warm_locked"),
            ):
                host = FixtureHost(_make_args(state_dir))
                # Startup self-heals state_dir from 0o700 -> 0o711
                assert (state_dir.stat().st_mode & 0o7777) == 0o711

                # File 2 RT import payload under UMask=0077
                view2 = host._request(
                    "create",
                    {
                        "name": "file2-env",
                        "proxy_id": "px-1",
                        "proxy_url": PROXY,
                        "auth_method": "oauth",
                        "oauth_account": {
                            "email": "user2@gmail.com",
                            "refresh_token": "1//06QFile2RefreshToken_abc123",
                            "oauth_client_key": "antigravity_enterprise",
                            "is_gcp_tos": False,
                            "project_id": "aicode-consumers",
                        },
                    },
                )
                assert seen_imports[-1] == {
                    "refresh_token": "1//06QFile2RefreshToken_abc123",
                    "oauth_client_key": "antigravity_enterprise",
                    "is_gcp_tos": False,
                    "project_id": "aicode-consumers",
                    "email": "user2@gmail.com",
                }
                env_id = view2["id"]
                env = host.environments[env_id]
                assert env["call_models"] == ["gemini-3-pro", "claude-sonnet-4-6-high"]
                assert view2["models"] == ["gemini-3-pro", "claude-sonnet-4-6-high"]

                env_dir = state_dir / env_id
                profile_dir = env_dir / env["profile"]
                assert (env_dir.stat().st_mode & 0o7777) == 0o711
                assert (profile_dir.stat().st_mode & 0o7777) == 0o711

                cli_dir = profile_dir / "home" / ".gemini" / "antigravity-cli"
                onboarding = cli_dir / "cache" / "onboarding.json"
                assert onboarding.is_file()
                assert json.loads(onboarding.read_text(encoding="utf-8")) == {
                    "onboardingComplete": True
                }
                assert (onboarding.stat().st_mode & 0o7777) == 0o600
                assert (
                    (cli_dir / "cache" / "default_project_id.txt")
                    .read_text(encoding="utf-8")
                    .strip()
                    == "aicode-consumers"
                )

                # File 1 bare RT import payload ({ email, refresh_token })
                view1 = host._request(
                    "create",
                    {
                        "name": "file1-env",
                        "proxy_id": "px-1",
                        "proxy_url": PROXY,
                        "auth_method": "oauth",
                        "oauth_account": {
                            "email": "user1@gmail.com",
                            "refresh_token": "1//06MFile1RefreshToken_xyz789",
                        },
                    },
                )
                assert seen_imports[-1] == {
                    "refresh_token": "1//06MFile1RefreshToken_xyz789",
                    "email": "user1@gmail.com",
                }
                assert (state_dir / view1["id"]).stat().st_mode & 0o7777 == 0o711

                # Self-heal 1: host restart repairs broken 0700 env & profile dirs
                os.chmod(env_dir, 0o700)
                os.chmod(profile_dir, 0o700)
                restarted = FixtureHost(_make_args(state_dir))
                assert (env_dir.stat().st_mode & 0o7777) == 0o711
                assert (profile_dir.stat().st_mode & 0o7777) == 0o711

                # Self-heal 2: refresh_account repairs broken 0700 dirs before read_account
                os.chmod(env_dir, 0o700)
                os.chmod(profile_dir, 0o700)
                restarted.refresh_account(
                    restarted.environments[env_id], PROXY, auto_pull_models=False
                )
                assert (env_dir.stat().st_mode & 0o7777) == 0o711
                assert (profile_dir.stat().st_mode & 0o7777) == 0o711

                # Self-heal 3: pull_models repairs broken 0700 dirs
                os.chmod(env_dir, 0o700)
                os.chmod(profile_dir, 0o700)
                with patch.object(
                    host_mod, "profile_secrets", return_value=(("ya29.fresh-token",), b"{}")
                ):
                    restarted.pull_models(restarted.environments[env_id], PROXY)
                assert (env_dir.stat().st_mode & 0o7777) == 0o711
                assert (profile_dir.stat().st_mode & 0o7777) == 0o711

                # Self-heal 4: Agy.start repairs broken 0700 profile dir before bwrap launch
                os.chmod(env_dir, 0o700)
                os.chmod(profile_dir, 0o700)
                fake_agy = host_mod.Agy.__new__(host_mod.Agy)
                fake_agy.host = SimpleNamespace(
                    directory=state_dir,
                    egress_uid=1008,
                    payload=state_dir / "payload",
                    ensure_env_machine_id=lambda _e: state_dir / "machine-id",
                    acquire_slot_network=lambda *a, **kw: {
                        "lock": None,
                        "egress": Mock(),
                        "relay": None,
                    },
                )
                (state_dir / "machine-id").write_text("0" * 32 + "\n", encoding="utf-8")
                fake_agy.environment = restarted.environments[env_id]
                fake_agy.slot = 0
                fake_agy.uid = os.getuid()
                fake_agy.directory = env_dir / ("terminal-" + "f" * 32)
                fake_agy.profile = profile_dir
                fake_agy.owns_directory = False
                fake_agy.network = ["0", "1008", "192.0.2.11", "1080"]
                fake_agy.namespace = "vm2agy0"
                fake_agy.proxy_hash = b"0" * 32
                fake_agy.egress_options = {}
                fake_agy.launch_cli = lambda argv, size: None
                fake_agy.start(PROXY, (80, 24))
                assert (env_dir.stat().st_mode & 0o7777) == 0o711
                assert (profile_dir.stat().st_mode & 0o7777) == 0o711
    finally:
        os.umask(old_umask)


def test_b_oauth_clients_extraction_multi_fallback_and_read_account_forwarding():
    # 1. All 3 embedded agy clients (consumer, cloud, enterprise 1098991175725-...) extracted on x86_64
    consumer_id = host_mod._AGY_DEFAULT_OAUTH_CLIENT_IDS["consumer"].encode("ascii")
    cloud_id = host_mod._AGY_DEFAULT_OAUTH_CLIENT_IDS["cloud"].encode("ascii")
    ent_id = host_mod._AGY_DEFAULT_OAUTH_CLIENT_IDS["enterprise"].encode("ascii")
    assert ent_id.startswith(b"1098991175725-md")

    sec_c = ("GOCSPX-" + "A" * 28).encode("ascii")
    sec_g = ("GOCSPX-" + "B" * 28).encode("ascii")
    sec_e = ("GOCSPX-" + "E" * 28).encode("ascii")
    rodata = b"HDR" + consumer_id + sec_c + b"SEP" + cloud_id + sec_g + b"SEP" + ent_id + sec_e
    text_va, ro_va = 0x401000, 0x402000

    def lea_rax(pos, target_off):
        disp = (ro_va + target_off) - (text_va + pos + 7)
        return b"\x48\x8d\x05" + struct.pack("<i", disp)

    text = bytearray()
    for cid, sec in ((consumer_id, sec_c), (cloud_id, sec_g), (ent_id, sec_e)):
        text += lea_rax(len(text), rodata.index(cid))
        text += lea_rax(len(text), rodata.index(sec))
        text += b"\x90" * 512

    with tempfile.TemporaryDirectory(prefix="gemini-elf3-") as tmp:
        x86_agy = Path(tmp) / "agy-x86"
        x86_agy.write_bytes(_build_synthetic_elf64(rodata, bytes(text), e_machine=62))
        arm_agy = Path(tmp) / "agy-arm64"
        arm_agy.write_bytes(_build_synthetic_elf64(rodata, b"\x00" * 16, e_machine=183))

        with patch.dict(
            os.environ,
            {
                "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_ID": "681255809395-fixture.apps.googleusercontent.com",
                "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_SECRET": "GOCSPX-" + "G" * 28,
            },
            clear=True,
        ):
            resolved_x86 = host_mod._resolve_host_oauth_clients(agy_path=x86_agy)
            assert resolved_x86["KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID"] == consumer_id.decode()
            assert resolved_x86["KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID"] == cloud_id.decode()
            assert resolved_x86["KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_ID"] == ent_id.decode()
            assert resolved_x86["KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_SECRET"] == sec_e.decode()
            assert (
                resolved_x86["KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_ID"]
                == "681255809395-fixture.apps.googleusercontent.com"
            )

        with patch.dict(os.environ, {}, clear=True):
            resolved_arm = host_mod._resolve_host_oauth_clients(agy_path=arm_agy)
            assert resolved_arm["KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET"] == sec_c.decode()
            assert resolved_arm["KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET"] == sec_g.decode()
            assert resolved_arm["KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_SECRET"] == sec_e.decode()

    # 2. oauth_client_key="antigravity_enterprise" orders enterprise -> consumer -> cloud -> geminicli
    #    and retries on invalid_grant, unauthorized_client, AND invalid_client across all clients!
    all_clients = {
        "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID": "cid-consumer",
        "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET": "sec-consumer",
        "KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID": "cid-cloud",
        "KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET": "sec-cloud",
        "KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_ID": "cid-enterprise",
        "KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_SECRET": "sec-enterprise",
        "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_ID": "cid-geminicli",
        "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_SECRET": "sec-geminicli",
    }
    tried = []

    def fake_multi_client(proxy_url, url, form_fields, *, timeout=10):
        tried.append(form_fields["client_id"])
        if len(tried) == 1:
            return 400, {"error": "invalid_grant"}
        if len(tried) == 2:
            return 401, {"error": "unauthorized_client"}
        if len(tried) == 3:
            return 400, {"error": "invalid_client"}
        return 200, {
            "access_token": "ya29.matched-on-4th-client",
            "expires_in": 3600,
            "token_type": "Bearer",
        }

    with patch.object(account_mod, "post_form_json", side_effect=fake_multi_client):
        res = account_mod.refresh_oauth_token(
            PROXY,
            "1//06MultiClientFallbackRt",
            oauth_clients=all_clients,
            oauth_client_key="antigravity_enterprise",
            is_gcp_tos=False,
        )
    assert res["state"] == "ok"
    assert tried == ["cid-enterprise", "cid-consumer", "cid-cloud", "cid-geminicli"]
    assert res["token_doc"]["token"]["access_token"] == "ya29.matched-on-4th-client"

    # 3. read_account passes oauth_clients for oauth_refresh_import, oauth, AND oauth-models
    for method in ("oauth_refresh_import", "oauth", "oauth-models"):
        captured = {}

        def fake_subproc(cmd, *, input=None, check=False, timeout=None, capture_output=False, env=None):
            captured["payload"] = json.loads(input.decode("utf-8"))
            captured["env"] = dict(env or {})
            return SimpleNamespace(stdout=b'{"state":"ok"}')

        with (
            patch.dict(os.environ, all_clients, clear=True),
            patch.object(host_mod.subprocess, "run", side_effect=fake_subproc),
        ):
            host_mod.read_account(1000, PROXY, method, profile=Path("/tmp/p"))
        assert captured["payload"]["oauth_clients"] == all_clients
        assert "KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_SECRET" not in captured["env"]


def test_c_direct_oauth_pull_models_and_accurate_error_status_codes():
    # 1. fetch_oauth_models: refreshes expired token, calls daily-cloudcode-pa with {},
    #    falls back to cloudcode-pa on 503, and falls back to {"project": ...} if {} returns empty.
    with tempfile.TemporaryDirectory(prefix="gemini-oauth-models-") as tmp:
        profile = Path(tmp)
        cli = profile / "home" / ".gemini" / "antigravity-cli"
        (cli / "cache").mkdir(parents=True)
        (cli / "cache" / "default_project_id.txt").write_text("proj-cached\n", encoding="utf-8")
        token_path = cli / "antigravity-oauth-token"
        token_path.write_text(
            json.dumps(
                {
                    "token": {
                        "access_token": "ya29.expired-old",
                        "token_type": "Bearer",
                        "refresh_token": "1//06ValidRefreshForModels",
                        "expiry": "2020-01-01T00:00:00Z",
                    },
                    "auth_method": "consumer",
                }
            ),
            encoding="utf-8",
        )
        os.chmod(token_path, 0o600)

        oauth_clients = {
            "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID": "cid-consumer",
            "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET": "sec-consumer",
        }
        seen_model_calls = []

        def fake_post_form(proxy_url, url, form, *, timeout=10):
            return 200, {
                "access_token": "ya29.refreshed-fresh",
                "expires_in": 3600,
                "token_type": "Bearer",
            }

        def fake_get_json(proxy_url, url, header=None, body=None, *, timeout=10):
            seen_model_calls.append((url, list(header), dict(body)))
            assert any(h == "Authorization: Bearer ya29.refreshed-fresh" for h in header)
            assert any(h.startswith("User-Agent: antigravity/hub/") for h in header)
            # 1st call: daily with {} -> 503 -> triggers fallback to cloudcode-pa
            if len(seen_model_calls) == 1:
                assert url == account_mod.CODE_ASSIST_DAILY + "fetchAvailableModels"
                assert body == {}
                return 503, {"error": {"message": "daily temporarily unavailable"}}
            # 2nd call: production with {} -> 200 empty -> triggers {"project": "proj-cached"} retry
            if len(seen_model_calls) == 2:
                assert url == account_mod.CODE_ASSIST + "fetchAvailableModels"
                assert body == {}
                return 200, {"models": {}}
            # 3rd call: production with {"project": "proj-cached"} -> returns models
            assert url == account_mod.CODE_ASSIST + "fetchAvailableModels"
            assert body == {"project": "proj-cached"}
            return 200, {
                "models": {
                    "gemini-3-pro": {"modelProvider": "MODEL_PROVIDER_GOOGLE"},
                    "claude-sonnet-4-6-high": {"modelProvider": "MODEL_PROVIDER_ANTHROPIC"},
                }
            }

        with (
            patch.object(account_mod, "post_form_json", side_effect=fake_post_form),
            patch.object(account_mod, "get_json", side_effect=fake_get_json),
        ):
            out = account_mod.fetch_oauth_models(
                PROXY, str(profile), oauth_clients=oauth_clients
            )
        assert out["state"] == "ok"
        assert out["models"] == ["claude-sonnet-4-6-high", "gemini-3-pro"]
        # Refreshed token persisted on disk with 0600
        persisted = json.loads(token_path.read_text(encoding="utf-8"))
        assert persisted["token"]["access_token"] == "ya29.refreshed-fresh"
        assert (token_path.stat().st_mode & 0o7777) == 0o600

    # 2. Host.pull_models for OAuth calls read_account("oauth-models") directly (NEVER Headless),
    #    persists call_models + account.models, and propagates 401/403/409/429 accurately (NOT 502).
    with tempfile.TemporaryDirectory(prefix="gemini-pull-models-") as tmp:
        state_dir = Path(tmp)
        env_id = "gemini-" + "d" * 24
        prof = "e" * 32
        (state_dir / env_id / prof).mkdir(parents=True)
        (state_dir / "environments.json").write_text(
            json.dumps(
                {
                    env_id: {
                        "id": env_id,
                        "name": "OAuth Pull",
                        "proxy_id": "px-1",
                        "slot": 0,
                        "auth_method": "oauth",
                        "auth_state": "authorized",
                        "profile": prof,
                        "account": {"state": "ok", "project_id": "aicode-consumers"},
                        "updated_at": "2026-11-28T00:00:00+00:00",
                    }
                }
            )
        )
        with (
            patch.object(host_mod, "check_root_owned"),
            patch.object(host_mod, "profile_secrets", return_value=(("ya29.tok",), b"{}")),
            patch.object(
                host_mod,
                "Headless",
                side_effect=AssertionError("OAuth pull_models must not spawn Headless"),
            ),
        ):
            host = FixtureHost(_make_args(state_dir))
            with patch.object(
                host_mod,
                "read_account",
                return_value={
                    "state": "ok",
                    "models": ["gemini-3-pro", "gemini-3-flash"],
                    "quotas": [{"model": "gemini-3-pro", "remaining_fraction": 0.9, "reset_at": None}],
                    "checked_at": "2026-11-28T01:00:00+00:00",
                },
            ):
                view = host.pull_models(host.environments[env_id], PROXY)
            assert view["models"] == ["gemini-3-pro", "gemini-3-flash"]
            assert host.environments[env_id]["call_models"] == ["gemini-3-pro", "gemini-3-flash"]
            assert host.environments[env_id]["account"]["models"] == ["gemini-3-pro", "gemini-3-flash"]

            for expected_status, probe_payload, expected_code in (
                (
                    401,
                    {
                        "state": "reauth_required",
                        "error_code": "gemini_oauth_required",
                        "error_message": "token revoked",
                        "http_status": 401,
                    },
                    "gemini_oauth_required",
                ),
                (
                    403,
                    {
                        "state": "error",
                        "error_code": "gemini_location_unsupported",
                        "error_message": "unsupported region",
                        "http_status": 403,
                    },
                    "gemini_location_unsupported",
                ),
                (
                    429,
                    {
                        "state": "error",
                        "error_code": "gemini_quota_exhausted",
                        "error_message": "quota exceeded",
                        "http_status": 429,
                    },
                    "gemini_quota_exhausted",
                ),
                (
                    503,
                    {
                        "state": "error",
                        "error_code": "gemini_oauth_client_not_configured",
                        "error_message": "missing oauth client",
                        "http_status": 503,
                    },
                    "gemini_oauth_client_not_configured",
                ),
            ):
                with patch.object(host_mod, "read_account", return_value=probe_payload):
                    try:
                        host.pull_models(host.environments[env_id], PROXY)
                        raise AssertionError(f"expected Failure {expected_status}")
                    except host_mod.Failure as err:
                        assert err.status == expected_status, (err.status, expected_status)
                        assert err.code == expected_code
                        assert err.message == probe_payload["error_message"]


def test_d_bind_proxy_shard_egress_options_and_domain_proxy_safety():
    # 1. bind_proxy preserves _runtime_proxies and egress_options (and restarts session on egress change)
    with tempfile.TemporaryDirectory(prefix="gemini-proxy-bind-") as tmp:
        state_dir = Path(tmp)
        env_id = "gemini-" + "9" * 24
        (state_dir / "environments.json").write_text(
            json.dumps(
                {
                    env_id: {
                        "id": env_id,
                        "name": "Proxy Env",
                        "proxy_id": "px-1",
                        "slot": 0,
                        "auth_method": "oauth",
                        "auth_state": "authorized",
                        "profile": "a" * 32,
                        "updated_at": "2026-11-28T00:00:00+00:00",
                    }
                }
            )
        )
        with patch.object(host_mod, "check_root_owned"):
            host = FixtureHost(_make_args(state_dir))
            egress_opts = {"domain_forward": True, "dns_empty_types": [64, 65]}
            host._request(
                "proxy-bind",
                {
                    "id": env_id,
                    "previous_proxy_id": "px-1",
                    "proxy_id": "px-2",
                    "proxy_url": PROXY2,
                    "egress_options": egress_opts,
                },
            )
            entry = host._runtime_proxy_entry(env_id)
            assert entry is not None
            assert entry[0] == "px-2"
            assert entry[1] == PROXY2
            assert entry[3] == egress_opts

            # Updating egress_options on the same proxy_id stops stale native session & updates cache
            fake_session = Mock()
            host.native_sessions[env_id] = fake_session
            new_opts = {"domain_forward": True, "dns_empty_types": [65]}
            host._request(
                "proxy-bind",
                {
                    "id": env_id,
                    "previous_proxy_id": "px-2",
                    "proxy_id": "px-2",
                    "proxy_url": PROXY2,
                    "egress_options": new_opts,
                },
            )
            fake_session.close.assert_called_once()
            assert env_id not in host.native_sessions
            assert host._runtime_proxy_entry(env_id)[3] == new_opts

    # 2. CragDaemonShard keys members by egress_key (including egress_options) & rebinds on change
    shard = host_mod.CragDaemonShard.__new__(host_mod.CragDaemonShard)
    shard._lock = threading.RLock()
    shard.uid = os.getuid()
    shard.policy = dict(host_mod.DEFAULT_RUNTIME_POLICY)
    shard.native_dir = Path("/tmp/shard-egress-test")
    shard.native_token = "tok"
    shard.is_alive = lambda: True
    shard.host = SimpleNamespace(_initial_session_model=lambda _e: "gemini-3-pro")
    shard._stage_account_files = lambda env, auth: ("/accounts/x/home", "/accounts/x/work")
    shard.members = {}

    worker_calls = []

    def fake_worker_req(sock, token, method, path, payload=None, timeout=5.0):
        worker_calls.append((method, path, payload))
        return 200, {"ok": True}

    env_shard = {
        "id": "gemini-" + "8" * 24,
        "proxy_id": "px-2",
        "max_concurrency": 2,
    }
    opts_a = {"domain_forward": True, "dns_empty_types": [64, 65]}
    opts_b = {"domain_forward": True, "dns_empty_types": [65]}
    with patch.object(
        host_mod, "native_module", return_value=SimpleNamespace(worker_json_request=fake_worker_req)
    ):
        shard.sync_account(
            env_shard, PROXY2, (("tok",), b"{}"), model="gemini-3-pro", egress_options=opts_a
        )
        assert shard.members[env_shard["id"]]["egress_options"] == opts_a
        assert shard.members[env_shard["id"]]["egress_key"] == host_mod.egress_fingerprint(
            PROXY2, opts_a
        )
        # Same proxy_url + same egress_options -> no proxy rebind request
        worker_calls.clear()
        shard.sync_account(
            env_shard, PROXY2, (("tok",), b"{}"), model="gemini-3-pro", egress_options=opts_a
        )
        assert worker_calls == []
        # Same proxy_url + changed egress_options -> triggers proxy rebind & updates shard member key
        shard.sync_account(
            env_shard, PROXY2, (("tok",), b"{}"), model="gemini-3-pro", egress_options=opts_b
        )
        assert len(worker_calls) == 1
        assert worker_calls[0][1] == f"/internal/v1/accounts/{env_shard['id']}/proxy"
        # Ensure no unknown fields that would fail craggemini's #[serde(deny_unknown_fields)]
        assert set(worker_calls[0][2].keys()) == {
            "proxy_id",
            "proxy_url",
            "proxy_sha256",
            "auto_calibrate",
        }
        assert shard.members[env_shard["id"]]["egress_options"] == opts_b

    # 3. Domain-name proxy in Agy.start non-relay fallback resolves/relays to IPv4 before start_network
    with tempfile.TemporaryDirectory(prefix="gemini-domain-proxy-") as tmp:
        root = Path(tmp)
        env_id = "gemini-" + "7" * 24
        (root / env_id).mkdir()
        (root / "machine-id").write_text("0" * 32 + "\n", encoding="utf-8")
        started_networks = []
        fake_host = SimpleNamespace(
            directory=root,
            egress_uid=1008,
            egress=root / "kin-egress",
            payload=root / "payload",
            ensure_env_machine_id=lambda _e: root / "machine-id",
            start_network=lambda d, net: (started_networks.append(list(net)), 99)[1],
        )
        agy = host_mod.Agy.__new__(host_mod.Agy)
        agy.host = fake_host
        agy.environment = {"id": env_id, "proxy_id": "px-dom", "slot": 0}
        agy.slot = 0
        agy.uid = os.getuid()
        agy.directory = root / env_id / ("a" * 32)
        agy.profile = None
        agy.owns_directory = False
        agy.network = ["0", "1008", "proxy.example.com", "8080"]
        agy.namespace = "vm2agy0"
        agy.proxy_hash = b"0" * 32
        agy.egress_options = {}
        agy.wait_egress = lambda: None
        agy.launch_cli = lambda argv, size: None
        with (
            patch.object(host_mod, "_resolve_proxy_ipv4", return_value="198.51.100.42"),
            patch.object(host_mod.os, "chown"),
            patch.object(host_mod.subprocess, "run"),
            patch.object(host_mod.subprocess, "Popen", return_value=Mock(poll=lambda: None)),
        ):
            agy.start(PROXY2, (80, 24))
        assert started_networks == [["0", "1008", "198.51.100.42", "8080"]]
        egress_cfg = json.loads((agy.directory / "egress.json").read_text(encoding="utf-8"))
        assert "198.51.100.42:8080" in egress_cfg["proxy_url"]

    # 4. gemini-host-egress.sh rejects domain host on 'start' cleanly (exit != 0)
    res = subprocess.run(
        ["bash", str(ROOT / "scripts/gemini-host-egress.sh"), "start", "0", "1008", "proxy.example.com", "8080"],
        capture_output=True,
    )
    assert res.returncode != 0


if __name__ == "__main__":
    test_a_umask_0077_dir_creation_onboarding_call_models_and_self_heal()
    test_b_oauth_clients_extraction_multi_fallback_and_read_account_forwarding()
    test_c_direct_oauth_pull_models_and_accurate_error_status_codes()
    test_d_bind_proxy_shard_egress_options_and_domain_proxy_safety()
    print("OK")
