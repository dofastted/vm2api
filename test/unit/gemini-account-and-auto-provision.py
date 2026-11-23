import json
import os
import tempfile
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


account_mod = load_module("gemini_host_account_test", "scripts/gemini_host_account.py")
host_mod = load_module("gemini_host_auto_test", "scripts/gemini-host.py")

PROXY = "socks5h://fixture:private-proxy@192.0.2.11:1080"


def test_account_antigravity_ua_and_auto_onboard():
    calls = []
    load_count = 0

    def fake_get_json(proxy_url, url, header=None, body=None, *, timeout=6):
        nonlocal load_count
        calls.append((url, header, body))
        if url.endswith("/userinfo"):
            return 200, {"email": "fresh@example.test"}
        if url.endswith("loadCodeAssist"):
            load_count += 1
            assert isinstance(header, list)
            assert any(h.startswith("User-Agent: antigravity/") for h in header)
            if load_count == 1:
                return 200, {
                    "allowedTiers": [
                        {"id": "free-tier", "name": "Google AI Standard", "isDefault": True}
                    ]
                }
            return 200, {
                "cloudaicompanionProject": "proj-onboarded-1",
                "currentTier": {"id": "free-tier", "name": "Google AI Standard"},
                "paidTier": {
                    "id": "g1-pro-tier",
                    "name": "Google AI Pro",
                    "availableCredits": [{"creditType": "GOOGLE_ONE_AI", "creditAmount": "1000"}],
                },
            }
        if url.endswith("onboardUser"):
            assert isinstance(header, list)
            assert any(h.startswith("User-Agent: antigravity/") for h in header)
            assert body["tierId"] == "free-tier"
            return 200, {"done": True, "response": {"cloudaicompanionProject": {"id": "proj-onboarded-1"}}}
        if url.endswith("fetchAvailableModels"):
            assert body == {"project": "proj-onboarded-1"}
            return 200, {
                "models": {
                    "gemini-3-pro": {"quotaInfo": {"remainingFraction": 0.8, "resetTime": "2030-01-01T00:00:00Z"}}
                }
            }
        if url.endswith("retrieveUserQuotaSummary"):
            assert body == {"project": "proj-onboarded-1"}
            return 200, {
                "groups": [
                    {
                        "displayName": "Gemini Pro",
                        "buckets": [
                            {"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.75}
                        ],
                    }
                ]
            }
        raise AssertionError(f"unexpected URL: {url}")

    with patch.object(account_mod, "get_json", side_effect=fake_get_json):
        result = account_mod.probe_oauth_token(
            PROXY,
            {"token": {"access_token": "ya29.fixture-access-token", "expiry": "2030-01-01T00:00:00Z"}},
        )
    assert result["state"] == "ok"
    assert result["email"] == "fresh@example.test"
    assert result["project_id"] == "proj-onboarded-1"
    assert result["plan"] == "Google AI Pro"
    assert result["models"] == ["gemini-3-pro"]
    assert len(result["quotas"]) == 1
    assert len(result["quota_groups"]) == 1
    assert result["credits"] == [{"type": "GOOGLE_ONE_AI", "amount": "1000"}]
    assert any(url.endswith("onboardUser") for url, _, _ in calls)


def test_account_skips_onboard_when_validation_required():
    calls = []

    def fake_get_json(proxy_url, url, header=None, body=None, *, timeout=6):
        calls.append(url)
        if url.endswith("/userinfo"):
            return 200, {"email": "verify@example.test"}
        if url.endswith("loadCodeAssist"):
            return 200, {
                "allowedTiers": [{"id": "standard-tier", "isDefault": True}],
                "ineligibleTiers": [{"reasonCode": "VALIDATION_REQUIRED", "tierId": "standard-tier"}],
            }
        if url.endswith("fetchAvailableModels"):
            return 200, {"models": {"gemini-2.5-pro": {}}}
        raise AssertionError(f"unexpected URL: {url}")

    with patch.object(account_mod, "get_json", side_effect=fake_get_json):
        result = account_mod.probe_oauth_token(
            PROXY,
            {"token": {"access_token": "ya29.fixture-access-token", "expiry": "2030-01-01T00:00:00Z"}},
        )
    assert result["state"] == "ok"
    assert result["models"] == ["gemini-2.5-pro"]
    assert not any(url.endswith("onboardUser") for url in calls)


def test_post_oauth_auto_pulls_models_and_refreshes_expired_token():
    class FixtureHost(host_mod.Host):
        def payload_config(self):
            return self.payload, True, self.public_key, None, "0.3.0"

        def payload_identity(self, source, public_key, digest):
            return digest

        def verify_payload(self, source, public_key, install=False):
            return "0.3.0"

        def recover_network(self, env_dir, slot):
            pass

        def oauth_runtime_issue(self):
            return None

    with tempfile.TemporaryDirectory(prefix="gemini-auto-prov-") as temporary:
        directory = Path(temporary)
        env_id = "gemini-" + "a" * 24
        profile_a = "1" * 32
        profile_b = "2" * 32
        args = SimpleNamespace(
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
        records = {
            env_id: {
                "id": env_id,
                "name": "OAuth Env",
                "proxy_id": "px-1",
                "auth_state": "reauth_required",
                "auth_method": "oauth",
                "profile": profile_a,
                "updated_at": "2026-01-01T00:00:00+00:00",
                "slot": 0,
            }
        }
        (directory / "environments.json").write_text(json.dumps(records))
        (directory / env_id / profile_a).mkdir(parents=True)
        (directory / env_id / profile_b).mkdir(parents=True)

        expired_token = json.dumps(
            {
                "token": {
                    "access_token": "ya29.expired",
                    "refresh_token": "1//valid-refresh",
                    "expiry": "2020-01-01T00:00:00Z",
                }
            }
        ).encode()
        fresh_token = json.dumps(
            {
                "token": {
                    "access_token": "ya29.refreshed",
                    "refresh_token": "1//valid-refresh",
                    "expiry": "2035-01-01T00:00:00Z",
                }
            }
        ).encode()

        token_state = {"bytes": expired_token}

        def fake_profile_secrets(profile, uid, *, include_raw=False):
            raw = token_state["bytes"]
            if include_raw:
                return (("ya29.token",), raw)
            return ("ya29.token",)

        def fake_read_account(uid, proxy_url, mode, **kwargs):
            if b"ya29.expired" in token_state["bytes"]:
                return {"state": "reauth_required", "checked_at": "2026-01-01T00:00:00+00:00"}
            return {
                "state": "ok",
                "email": "ok@example.test",
                "plan": "Google AI Pro",
                "project_id": "proj-1",
                "checked_at": "2026-01-01T00:00:01+00:00",
            }

        pull_calls = []

        def fake_pull_models(self_host, env, proxy_url, *, allow_reauth_probe=False):
            pull_calls.append((env["id"], allow_reauth_probe))
            token_state["bytes"] = fresh_token
            self_host.save_environment(
                env, {**env, "call_models": ["gemini-3-pro", "gemini-3-flash"], "updated_at": host_mod.now()}
            )
            return self_host.view(env)

        with (
            patch.object(host_mod, "check_root_owned"),
            patch.object(host_mod, "profile_secrets", side_effect=fake_profile_secrets),
            patch.object(host_mod, "read_account", side_effect=fake_read_account),
            patch.object(FixtureHost, "pull_models", new=fake_pull_models),
            patch.object(host_mod, "Login") as login_cls,
        ):
            host = FixtureHost(args)
            # 1. Refreshing an expired account in reauth_required with valid refresh_token auto-recovers via agy models
            refreshed = host.refresh_account(host.environments[env_id], PROXY)
            assert len(pull_calls) == 1
            assert pull_calls[0] == (env_id, True)
            assert refreshed["auth_state"] == "authorized"
            assert refreshed["models_discovered"] is True
            assert refreshed["models"] == ["gemini-3-pro", "gemini-3-flash"]
            assert refreshed["account"]["plan"] == "Google AI Pro"

            # 2. Completing a fresh OAuth login automatically triggers pull_models + refresh_account
            pull_calls.clear()
            login_cls.return_value.attempt = profile_b
            login_cls.return_value.deadline = float("inf")
            login_cls.return_value.proxy_url = PROXY
            login_cls.return_value.challenge.return_value = {"attempt_id": profile_b, "url": "https://example.test"}
            login_cls.return_value.finished.return_value = True
            host._request(
                "authorize",
                {"id": env_id, "proxy_id": "px-1", "proxy_url": PROXY},
            )
            host.cleanup()
            assert len(pull_calls) == 1
            assert host.environments[env_id]["auth_state"] == "authorized"
            assert host.environments[env_id]["call_models"] == ["gemini-3-pro", "gemini-3-flash"]
            assert host.environments[env_id]["account"]["plan"] == "Google AI Pro"


if __name__ == "__main__":
    test_account_antigravity_ua_and_auto_onboard()
    test_account_skips_onboard_when_validation_required()
    test_post_oauth_auto_pulls_models_and_refreshes_expired_token()
    print("OK")
