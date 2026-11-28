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
            assert any(h.startswith("User-Agent: antigravity/hub/") for h in header)
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
            assert any(h.startswith("User-Agent: antigravity/hub/") for h in header)
            assert body["tierId"] == "free-tier"
            return 200, {"done": True, "response": {"cloudaicompanionProject": {"id": "proj-onboarded-1"}}}
        if url.endswith("fetchAvailableModels"):
            assert url.startswith("https://daily-cloudcode-pa.googleapis.com/")
            assert body == {"project": "proj-onboarded-1"}
            return 200, {
                "models": {
                    "gemini-3-pro": {
                        "modelProvider": "MODEL_PROVIDER_GOOGLE",
                        "quotaInfo": {"remainingFraction": 0.8, "resetTime": "2030-01-01T00:00:00Z"},
                    },
                    "claude-sonnet-4-6-high": {
                        "modelProvider": "MODEL_PROVIDER_ANTHROPIC",
                        "quotaInfo": {"remainingFraction": 0.6, "resetTime": "2030-01-01T00:00:00Z"},
                    },
                    "gpt-oss-120b-medium": {
                        "modelProvider": "MODEL_PROVIDER_OPENAI",
                    },
                }
            }
        if url.endswith("retrieveUserQuotaSummary"):
            assert url.startswith("https://daily-cloudcode-pa.googleapis.com/")
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
    assert result["models"] == ["claude-sonnet-4-6-high", "gemini-3-pro", "gpt-oss-120b-medium"]
    assert result["model_catalog"] == [
        {"id": "claude-sonnet-4-6-high", "provider": "anthropic", "quota_group": "3p"},
        {"id": "gemini-3-pro", "provider": "google", "quota_group": "gemini"},
        {"id": "gpt-oss-120b-medium", "provider": "openai", "quota_group": "3p"},
    ]
    assert len(result["quotas"]) == 2
    assert len(result["quota_groups"]) == 1
    assert result["credits"] == [{"type": "GOOGLE_ONE_AI", "amount": "1000"}]
    assert any(url.endswith("onboardUser") for url, _, _ in calls)


def test_account_skips_onboard_when_validation_required():
    calls = []
    valid_url = "https://accounts.google.com/v3/signin/continue?plt=abc123&sarp=1"

    def fake_get_json(proxy_url, url, header=None, body=None, *, timeout=6):
        calls.append(url)
        if url.endswith("/userinfo"):
            return 200, {"email": "verify@example.test"}
        if url.endswith("loadCodeAssist"):
            return 200, {
                "allowedTiers": [{"id": "standard-tier", "isDefault": True}],
                "ineligibleTiers": [
                    {
                        "reasonCode": "VALIDATION_REQUIRED",
                        "tierId": "standard-tier",
                        "validationUrl": valid_url,
                    }
                ],
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
    assert result["eligibility"] == "verification_required"
    assert result["validation_url"] == valid_url
    assert not any(url.endswith("onboardUser") for url in calls)
    assert account_mod.safe_google_validation_url("https://evil.example/phish") is None

    # Active paidTier / currentTier accounts must NOT be flagged by other ineligibleTiers entries.
    assert account_mod.parse_ineligibility(
        {
            "currentTier": {"id": "free-tier", "name": "Google AI Standard"},
            "ineligibleTiers": [
                {
                    "reasonCode": "VALIDATION_REQUIRED",
                    "tierId": "enterprise-tier",
                    "validationUrl": valid_url,
                }
            ],
        }
    ) == (None, None)


def test_realistic_login_settlement_hostname_and_headless_device_inheritance():
    # 1. Deterministic per-env hostname (never shared static "agy")
    h1 = host_mod.env_hostname({"id": "gemini-111111111111111111111111"})
    h2 = host_mod.env_hostname({"id": "gemini-222222222222222222222222"})
    assert h1 != "agy" and h2 != "agy" and h1 != h2
    assert h1 == host_mod.env_hostname({"id": "gemini-111111111111111111111111"})

    # 2. Login.finished() must NOT kill agy at T+0ms just because .config/antigravity exists!
    with tempfile.TemporaryDirectory(prefix="gemini-login-settle-") as tmp:
        root = Path(tmp)
        (root / "home" / ".config" / "antigravity").mkdir(parents=True)
        cache_dir = root / "home" / ".gemini" / "antigravity-cli" / "cache"
        cache_dir.mkdir(parents=True)

        login = host_mod.Login.__new__(host_mod.Login)
        login.directory = root
        login.uid = os.getuid()
        login.sent = True
        login.token_seen_at = None
        login.buffer = b""
        login.read = lambda timeout: None
        login.alive = lambda: True

        clock = [100.0]
        with (
            patch.object(host_mod, "profile_secrets", return_value=("ya29.tok",)),
            patch.object(host_mod.time, "monotonic", side_effect=lambda: clock[0]),
        ):
            # Even though .config/antigravity exists, T+0s and T+1.5s must keep settling!
            assert login.finished() is False
            clock[0] = 101.5
            assert login.finished() is False
            # Once min settle elapsed AND default_project_id.txt is populated, finish cleanly!
            (cache_dir / "default_project_id.txt").write_text("proj-settled-1\n")
            clock[0] = 100.0 + host_mod.AUTH_MIN_SETTLE_SECONDS + 0.1
            assert login.finished() is True

        # Without default_project_id.txt, settle until full AUTH_SETTLE_SECONDS.
        (cache_dir / "default_project_id.txt").unlink()
        login.token_seen_at = None
        clock[0] = 200.0
        with (
            patch.object(host_mod, "profile_secrets", return_value=("ya29.tok",)),
            patch.object(host_mod.time, "monotonic", side_effect=lambda: clock[0]),
        ):
            assert login.finished() is False
            clock[0] = 200.0 + host_mod.AUTH_MIN_SETTLE_SECONDS + 0.5
            assert login.finished() is False
            clock[0] = 200.0 + host_mod.AUTH_SETTLE_SECONDS + 0.1
            assert login.finished() is True

    # 3. Headless.initialize_home() preserves profile's installation_id and cached project ID
    with tempfile.TemporaryDirectory(prefix="gemini-headless-dev-") as tmp:
        root = Path(tmp)
        env_id = "gemini-" + "c" * 24
        prof = "3" * 32
        src_cli = root / env_id / prof / "home" / ".gemini" / "antigravity-cli"
        (src_cli / "cache").mkdir(parents=True)
        (src_cli / "installation_id").write_text("11111111-2222-3333-4444-555555555555")
        (src_cli / "cache" / "default_project_id.txt").write_text("proj-cached-9")

        headless = host_mod.Headless.__new__(host_mod.Headless)
        headless.host = SimpleNamespace(directory=root)
        headless.environment = {"id": env_id, "profile": prof}
        headless.uid = os.getuid()
        headless.token_bytes = b'{"token":{"access_token":"ya29.test"}}'
        dst_home = root / "headless-run" / "home"
        dst_home.parent.mkdir(parents=True)
        with patch.object(host_mod.os, "chown"):
            headless.initialize_home(dst_home)
        dst_cli = dst_home / ".gemini" / "antigravity-cli"
        assert (dst_cli / "installation_id").read_text() == "11111111-2222-3333-4444-555555555555"
        assert (dst_cli / "cache" / "default_project_id.txt").read_text() == "proj-cached-9"
        assert (dst_cli / host_mod.TOKEN_NAME).read_bytes() == b'{"token":{"access_token":"ya29.test"}}'


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


def test_unsupported_client_fallback_and_distinct_classification():
    # 1. Enriched metadata + automatic fallback User-Agent recovers when primary UA gets UNSUPPORTED_CLIENT.
    seen_uas = []
    seen_metadata = []

    def fake_recover(proxy_url, url, header=None, body=None, *, timeout=6):
        if url.endswith("/userinfo"):
            return 200, {"email": "recover@example.test"}
        if url.endswith("loadCodeAssist"):
            seen_metadata.append(body)
            ua = next((h for h in header if h.startswith("User-Agent: ")), "")
            seen_uas.append(ua)
            if len(seen_uas) == 1:
                return 200, {
                    "ineligibleTiers": [
                        {"reasonCode": "UNSUPPORTED_CLIENT", "reasonMessage": "Client not supported"}
                    ]
                }
            return 200, {
                "cloudaicompanionProject": "proj-fallback-ok",
                "currentTier": {"id": "free-tier", "name": "Google AI Standard"},
            }
        if url.endswith("fetchAvailableModels"):
            assert any(h == f"User-Agent: {account_mod.ANTIGRAVITY_FALLBACK_USER_AGENTS[0]}" for h in header)
            return 200, {"models": {"gemini-3-pro": {}}}
        if url.endswith("retrieveUserQuotaSummary"):
            return 200, {"groups": []}
        raise AssertionError(f"unexpected URL: {url}")

    with patch.object(account_mod, "get_json", side_effect=fake_recover):
        recovered = account_mod.probe_oauth_token(
            PROXY,
            {"token": {"access_token": "ya29.fixture-recover", "expiry": "2030-01-01T00:00:00Z"}},
        )
    assert len(seen_uas) == 2
    assert seen_metadata[0] == {
        "metadata": {
            "ideName": "antigravity",
            "ideType": "ANTIGRAVITY",
            "ideVersion": account_mod.ANTIGRAVITY_VERSION,
            "platform": "LINUX_AMD64",
            "pluginType": "GEMINI",
        }
    }
    assert recovered["state"] == "ok"
    assert recovered["project_id"] == "proj-fallback-ok"
    assert "eligibility" not in recovered

    # 1b. Falls back to daily-cloudcode-pa when cloudcode-pa rejects all UAs with UNSUPPORTED_CLIENT.
    daily_urls = []

    def fake_daily_recover(proxy_url, url, header=None, body=None, *, timeout=6):
        if url.endswith("/userinfo"):
            return 200, {"email": "daily@example.test"}
        if url.endswith("loadCodeAssist"):
            daily_urls.append(url)
            if url.startswith(account_mod.CODE_ASSIST_DAILY):
                return 200, {
                    "cloudaicompanionProject": "proj-daily-ok",
                    "currentTier": {"id": "free-tier", "name": "Google AI Standard"},
                }
            return 200, {
                "ineligibleTiers": [
                    {"reasonCode": "UNSUPPORTED_CLIENT", "reasonMessage": "Client not supported"}
                ]
            }
        if url.endswith("fetchAvailableModels"):
            return 200, {"models": {"gemini-3-pro": {}}}
        if url.endswith("retrieveUserQuotaSummary"):
            return 200, {"groups": []}
        raise AssertionError(f"unexpected URL: {url}")

    with patch.object(account_mod, "get_json", side_effect=fake_daily_recover):
        daily_ok = account_mod.probe_oauth_token(
            PROXY,
            {"token": {"access_token": "ya29.fixture-daily", "expiry": "2030-01-01T00:00:00Z"}},
        )
    assert any(u.startswith(account_mod.CODE_ASSIST_DAILY) for u in daily_urls)
    assert daily_ok["state"] == "ok"
    assert daily_ok["project_id"] == "proj-daily-ok"
    assert "eligibility" not in daily_ok

    # 1c. When loadCodeAssist reports UNSUPPORTED_CLIENT but fetchAvailableModels returns
    # runnable models, suppress false-positive client_unsupported blocking.
    def fake_models_override_client_unsupported(proxy_url, url, header=None, body=None, *, timeout=6):
        if url.endswith("/userinfo"):
            return 200, {"email": "models-ok@example.test"}
        if url.endswith("loadCodeAssist"):
            return 200, {
                "ineligibleTiers": [
                    {"reasonCode": "UNSUPPORTED_CLIENT", "reasonMessage": "Client not supported"}
                ]
            }
        if url.endswith("fetchAvailableModels"):
            return 200, {"models": {"gemini-3-pro": {}}}
        raise AssertionError(f"unexpected URL: {url}")

    with patch.object(account_mod, "get_json", side_effect=fake_models_override_client_unsupported):
        models_ok = account_mod.probe_oauth_token(
            PROXY,
            {"token": {"access_token": "ya29.fixture-models-ok", "expiry": "2030-01-01T00:00:00Z"}},
        )
    assert models_ok["state"] == "ok"
    assert models_ok["models"] == ["gemini-3-pro"]
    assert "eligibility" not in models_ok

    # 1d. UNSUPPORTED_CLIENT on an alternative tier does not prevent onboarding an allowed tier.
    assert (
        account_mod.select_onboard_tier(
            {
                "allowedTiers": [{"id": "free-tier", "isDefault": True}],
                "ineligibleTiers": [{"reasonCode": "UNSUPPORTED_CLIENT"}],
            }
        )
        == "free-tier"
    )

    # 2. If all client UAs receive UNSUPPORTED_CLIENT and no models are returned, report 'client_unsupported'.
    def fake_always_unsupported(proxy_url, url, header=None, body=None, *, timeout=6):
        if url.endswith("/userinfo"):
            return 200, {"email": "client-blocked@example.test"}
        if url.endswith("loadCodeAssist"):
            return 200, {
                "ineligibleTiers": [
                    {"reasonCode": "UNSUPPORTED_CLIENT", "reasonMessage": "Client not supported"}
                ]
            }
        if url.endswith("fetchAvailableModels"):
            return 200, {"models": {}}
        raise AssertionError(f"unexpected URL: {url}")

    with patch.object(account_mod, "get_json", side_effect=fake_always_unsupported):
        blocked = account_mod.probe_oauth_token(
            PROXY,
            {"token": {"access_token": "ya29.fixture-blocked", "expiry": "2030-01-01T00:00:00Z"}},
        )
    assert blocked["eligibility"] == "client_unsupported"

    # 3. Native EligibilityDiagnostic classifies UNSUPPORTED_CLIENT distinctly and treats it
    # as advisory for live ready sessions while still surfacing it on final failure.
    native_mod = load_module("gemini_host_native_test", "scripts/gemini_host_native.py")
    diag = native_mod.EligibilityDiagnostic.__new__(native_mod.EligibilityDiagnostic)
    diag.pending = bytearray()
    diag.discard_line = False
    diag.code = None
    diag.descriptor = None
    diag._lock = __import__("threading").Lock()
    diag._consume(
        b"W1126 13:18:02.000000 1234 server_oauth.go:42] Account ineligible: UNSUPPORTED_CLIENT\n"
    )
    assert diag.code == "gemini_client_unsupported"
    assert diag.poll(include_advisory=False) is None
    assert diag.poll(final=True) == "gemini_client_unsupported"
    assert host_mod.session_diagnostic(SimpleNamespace(native_diagnostic=diag)) is None
    assert (
        host_mod.session_diagnostic(
            SimpleNamespace(native_diagnostic=diag), final=True, include_advisory=True
        )
        == "gemini_client_unsupported"
    )
    diag.clear_advisory()
    assert diag.code is None

    # Blocking region diagnostic is never treated as advisory or cleared by clear_advisory().
    diag._consume(
        b"W1126 13:18:03.000000 1234 server_oauth.go:42] Account ineligible: You are not eligible for Antigravity, because it is not currently available in your location.\n"
    )
    assert diag.poll(include_advisory=False) == "gemini_location_unsupported"
    diag.clear_advisory()
    assert diag.code == "gemini_location_unsupported"


def test_refresh_token_import_exchanges_and_creates_standard_profile():
    # 0. Without configured runtime OAuth clients, refresh fails closed without network I/O.
    with (
        patch.dict(os.environ, {}, clear=True),
        patch.object(account_mod, "post_form_json", side_effect=AssertionError("must not call network")),
    ):
        unconfigured = account_mod.refresh_oauth_token(PROXY, "1//06UnconfiguredRefreshToken")
    assert unconfigured == {"state": "error", "error": "oauth_client_not_configured"}

    # 1. refresh_oauth_token uses configured consumer client first, then falls back to cloud client on client mismatch.
    fixture_oauth_env = {
        "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID": "fixture-consumer-client-id",
        "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET": "fixture-consumer-client-secret",
        "KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID": "fixture-cloud-client-id",
        "KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET": "fixture-cloud-client-secret",
    }
    seen_forms = []

    def fake_post_form_cloud_fallback(proxy_url, url, form_fields, *, timeout=10):
        assert proxy_url == PROXY
        assert url == account_mod.GOOGLE_OAUTH_TOKEN_URL
        seen_forms.append(dict(form_fields))
        if len(seen_forms) == 1:
            return 401, {"error": "unauthorized_client"}
        return 200, {
            "access_token": "ya29.exchanged-cloud",
            "expires_in": 3600,
            "token_type": "Bearer",
        }

    with (
        patch.dict(os.environ, fixture_oauth_env, clear=True),
        patch.object(account_mod, "post_form_json", side_effect=fake_post_form_cloud_fallback),
    ):
        res = account_mod.refresh_oauth_token(PROXY, "1//06FixtureCloudRefreshToken")
    assert len(seen_forms) == 2
    assert seen_forms[0]["client_id"] == "fixture-consumer-client-id"
    assert seen_forms[0]["client_secret"] == "fixture-consumer-client-secret"
    assert seen_forms[1]["client_id"] == "fixture-cloud-client-id"
    assert seen_forms[1]["client_secret"] == "fixture-cloud-client-secret"
    assert res["state"] == "ok"
    assert res["token_doc"]["auth_method"] == "gcp"
    assert res["token_doc"]["token"]["access_token"] == "ya29.exchanged-cloud"
    assert res["token_doc"]["token"]["refresh_token"] == "1//06FixtureCloudRefreshToken"

    # 2. probe_oauth_refresh_import must NOT silently degrade to access-only import when RT refresh fails.
    def fake_post_mismatch(proxy_url, url, form_fields, *, timeout=10):
        return 401, {"error": "unauthorized_client", "error_description": "Unauthorized client"}

    with (
        patch.dict(os.environ, fixture_oauth_env, clear=True),
        patch.object(account_mod, "post_form_json", side_effect=fake_post_mismatch),
    ):
        fb = account_mod.probe_oauth_refresh_import(
            PROXY,
            {
                "refresh_token": "1//06ThirdPartyClientRt",
                "access_token": "ya29.valid-short-lived",
                "expiry": int(time.time()) + 1800,
            },
        )
    assert "fallback_access_only" not in fb
    assert fb["account"]["state"] == "reauth_required"
    assert fb["error"] == "unauthorized_client"
    assert fb["account"]["error_code"] == "unauthorized_client"

    # 2b. Host read_account forwards allowlisted OAuth client env vars via stdin payload (never child environ).
    seen_subproc = {}

    def fake_run(cmd, *, input=None, check=False, timeout=None, capture_output=False, env=None):
        seen_subproc["payload"] = json.loads(input.decode("utf-8"))
        seen_subproc["env"] = dict(env or {})
        return SimpleNamespace(stdout=b'{"account":{"state":"ok"}}')

    with (
        patch.dict(os.environ, fixture_oauth_env, clear=True),
        patch.object(host_mod.subprocess, "run", side_effect=fake_run),
    ):
        host_mod.read_account(1000, PROXY, "oauth_refresh_import", oauth_token={"refresh_token": "1//06Test"})
    assert seen_subproc["payload"]["oauth_clients"] == fixture_oauth_env
    assert "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET" not in seen_subproc["env"]

    # 3. Host create with bare refresh_token exchanges token, writes standard agy profile, and omits oauth_imported.
    class FixtureHost(host_mod.Host):
        def payload_config(self):
            return self.payload, True, self.public_key, None, "0.4.13"

        def payload_identity(self, source, public_key, digest):
            return digest

        def verify_payload(self, source, public_key, install=False):
            return "0.4.13"

        def recover_network(self, env_dir, slot):
            pass

        def oauth_runtime_issue(self):
            return None

    with tempfile.TemporaryDirectory(prefix="gemini-rt-import-") as temporary:
        directory = Path(temporary)
        args = SimpleNamespace(
            state=directory,
            uid_base=1000,
            payload=directory / "payload",
            payload_source=None,
            public_key=None,
            default_public_key=None,
            default_release_verifier=None,
            release_verifier=None,
            egress=None,
        )
        token_doc = {
            "token": {
                "access_token": "ya29.fresh-from-rt",
                "token_type": "Bearer",
                "refresh_token": "1//06BareImportedRt_abc123",
                "expiry": "2035-01-01T00:00:00Z",
            },
            "auth_method": "consumer",
        }

        def fake_read_account(uid, proxy_url, method, **kwargs):
            assert method == "oauth_refresh_import"
            assert kwargs["oauth_token"]["refresh_token"] == "1//06BareImportedRt_abc123"
            return {
                "account": {
                    "state": "ok",
                    "email": "imported@example.test",
                    "project_id": "proj-rt-1",
                    "plan": "Google AI Pro",
                    "models": ["gemini-3-pro"],
                    "checked_at": "2026-11-26T00:00:00+00:00",
                },
                "token_doc": token_doc,
            }

        with (
            patch.object(host_mod, "check_root_owned"),
            patch.object(host_mod, "read_account", side_effect=fake_read_account),
            patch.object(host_mod.os, "chown"),
        ):
            host = FixtureHost(args)
            view = host._request(
                "create",
                {
                    "name": "imported@example.test",
                    "proxy_id": "px-1",
                    "proxy_url": PROXY,
                    "auth_method": "oauth",
                    "oauth_account": {"refresh_token": "1//06BareImportedRt_abc123"},
                },
            )
            env_id = view["id"]
            env = host.environments[env_id]
            assert env["auth_state"] == "authorized"
            assert "oauth_imported" not in env
            assert "oauth_imported" not in view
            assert isinstance(env.get("profile"), str) and len(env["profile"]) == 32
            assert view["account"]["email"] == "imported@example.test"
            assert "1//06BareImportedRt_abc123" not in json.dumps(view)
            assert "ya29.fresh-from-rt" not in json.dumps(view)

            profile_cli = directory / env_id / env["profile"] / "home" / ".gemini" / "antigravity-cli"
            saved_token = json.loads((profile_cli / host_mod.TOKEN_NAME).read_text(encoding="utf-8"))
            assert saved_token == token_doc
            assert (profile_cli / "cache" / "default_project_id.txt").read_text(encoding="utf-8").strip() == "proj-rt-1"

            # Rejected refresh token raises 400 gemini_oauth_import_rejected
            with patch.object(
                host_mod,
                "read_account",
                return_value={"account": {"state": "reauth_required", "checked_at": "2026-11-26T00:00:00+00:00"}},
            ):
                try:
                    host._request(
                        "create",
                        {
                            "name": "bad-rt",
                            "proxy_id": "px-1",
                            "proxy_url": PROXY,
                            "auth_method": "oauth",
                            "oauth_account": {"refresh_token": "1//06RevokedRt_abc123"},
                        },
                    )
                    raise AssertionError("expected Failure")
                except host_mod.Failure as err:
                    assert err.status == 400
                    assert err.code == "gemini_oauth_import_rejected"

            # Missing OAuth client config maps to 503 gemini_oauth_client_not_configured (not misleading 502)
            with patch.object(
                host_mod,
                "read_account",
                return_value={
                    "account": {
                        "state": "error",
                        "error_code": "oauth_client_not_configured",
                        "checked_at": "2026-11-26T00:00:00+00:00",
                    },
                    "error": "oauth_client_not_configured",
                },
            ):
                try:
                    host._request(
                        "create",
                        {
                            "name": "missing-oauth-cfg",
                            "proxy_id": "px-1",
                            "proxy_url": PROXY,
                            "auth_method": "oauth",
                            "oauth_account": {"refresh_token": "1//06MissingCfgRt_abc123"},
                        },
                    )
                    raise AssertionError("expected Failure")
                except host_mod.Failure as err:
                    assert err.status == 503
                    assert err.code == "gemini_oauth_client_not_configured"


def _build_synthetic_elf64(rodata_bytes, text_bytes, *, text_va=0x401000, ro_va=0x402000):
    import struct

    shstr = b"\x00.text\x00.rodata\x00.shstrtab\x00"
    hdr_size = 64
    text_off = hdr_size
    ro_off = text_off + len(text_bytes)
    shstr_off = ro_off + len(rodata_bytes)
    shoff = shstr_off + len(shstr)

    e_ident = b"\x7fELF" + bytes([2, 1, 1]) + b"\x00" * 9
    elf_hdr = e_ident + struct.pack(
        "<HHIQQQIHHHHHH",
        2,  # ET_EXEC
        62,  # EM_X86_64
        1,  # EV_CURRENT
        text_va,
        0,
        shoff,
        0,
        hdr_size,
        0,
        0,
        64,  # e_shentsize
        4,  # e_shnum
        3,  # e_shstrndx
    )

    def shdr(name_off, sh_type, flags, addr, offset, size):
        return struct.pack("<IIQQQQIIQQ", name_off, sh_type, flags, addr, offset, size, 0, 0, 1, 0)

    sh_null = shdr(0, 0, 0, 0, 0, 0)
    sh_text = shdr(1, 1, 6, text_va, text_off, len(text_bytes))
    sh_ro = shdr(7, 1, 2, ro_va, ro_off, len(rodata_bytes))
    sh_str = shdr(15, 3, 0, 0, shstr_off, len(shstr))
    return elf_hdr + text_bytes + rodata_bytes + shstr + sh_null + sh_text + sh_ro + sh_str


def test_default_oauth_elf64_extraction_env_override_and_transport_redaction():
    import struct

    host_mod = load_module("gemini_host_oauth_defaults", "scripts/gemini-host.py")
    account_mod = load_module("gemini_account_oauth_defaults", "scripts/gemini_host_account.py")

    consumer_id = host_mod._AGY_DEFAULT_OAUTH_CLIENT_IDS["consumer"].encode("ascii")
    cloud_id = host_mod._AGY_DEFAULT_OAUTH_CLIENT_IDS["cloud"].encode("ascii")
    # Build synthetic 35-byte secrets at runtime (no real credentials in source) and pack
    # them contiguously in .rodata with NO NUL terminators, mirroring Go binary layout.
    syn_consumer_sec = ("GOCSPX-" + "A" * 28).encode("ascii")
    syn_cloud_sec = ("GOCSPX-" + "B" * 28).encode("ascii")
    syn_decoy_sec = ("GOCSPX-" + "C" * 28).encode("ascii")

    rodata = b"PREFIX" + consumer_id + syn_consumer_sec + b"ADJACENT_LITERAL" + cloud_id + syn_cloud_sec + b"TAIL" + syn_decoy_sec
    text_va = 0x401000
    ro_va = 0x402000

    def lea_rax(pos, target_off):
        disp = (ro_va + target_off) - (text_va + pos + 7)
        return b"\x48\x8d\x05" + struct.pack("<i", disp)

    text = bytearray()
    # Pair consumer ID + consumer secret closely
    text += lea_rax(len(text), rodata.index(consumer_id))
    text += lea_rax(len(text), rodata.index(syn_consumer_sec))
    text += b"\x90" * 512  # separate functions beyond 256-byte pairing window
    # Pair cloud ID + cloud secret closely
    text += lea_rax(len(text), rodata.index(cloud_id))
    text += lea_rax(len(text), rodata.index(syn_cloud_sec))
    text += b"\x90" * 512
    # Distant decoy secret alone (must never hijack consumer/cloud)
    text += lea_rax(len(text), rodata.index(syn_decoy_sec))

    elf_bytes = _build_synthetic_elf64(rodata, bytes(text), text_va=text_va, ro_va=ro_va)

    with tempfile.TemporaryDirectory(prefix="gemini-elf-oauth-") as tmpdir:
        fake_agy = Path(tmpdir) / "agy"
        fake_agy.write_bytes(elf_bytes)

        # 1. Empty env derives both consumer & cloud pairs cleanly from installed agy binary.
        with patch.dict(os.environ, {}, clear=True):
            resolved = host_mod._resolve_host_oauth_clients(agy_path=fake_agy)
        assert resolved == {
            "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID": consumer_id.decode("ascii"),
            "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET": syn_consumer_sec.decode("ascii"),
            "KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID": cloud_id.decode("ascii"),
            "KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET": syn_cloud_sec.decode("ascii"),
        }, resolved

        # 2. Explicit env client ID override MUST NOT pair with the derived agy secret.
        with patch.dict(
            os.environ,
            {"KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID": "custom-consumer-id"},
            clear=True,
        ):
            overridden = host_mod._resolve_host_oauth_clients(agy_path=fake_agy)
        assert overridden["KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID"] == "custom-consumer-id"
        assert "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET" not in overridden
        assert overridden["KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID"] == cloud_id.decode("ascii")
        assert overridden["KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET"] == syn_cloud_sec.decode("ascii")

    # 3. probe_oauth_refresh_import preserves error_code='oauth_client_not_configured' when unconfigured.
    with patch.dict(os.environ, {}, clear=True):
        unconfigured = account_mod.probe_oauth_refresh_import(
            PROXY, {"refresh_token": "1//06UnconfiguredRt_xyz"}
        )
    assert unconfigured["error"] == "oauth_client_not_configured"
    assert unconfigured["account"]["error_code"] == "oauth_client_not_configured"

    # 4. post_form_json captures redacted curl transport error without leaking proxy password.
    secret_proxy = "http://alice:verysecretpw@192.0.2.55:8080"
    fake_curl_err = SimpleNamespace(
        returncode=56,
        stdout=b"",
        stderr=b"curl: (56) Proxy CONNECT aborted via http://alice:verysecretpw@192.0.2.55:8080",
    )
    with patch.object(account_mod.subprocess, "run", return_value=fake_curl_err):
        st, body = account_mod.post_form_json(
            secret_proxy, "https://oauth2.googleapis.com/token", {"grant_type": "refresh_token"}
        )
    assert st == 0
    assert "_transport_error" in body
    assert "verysecretpw" not in body["_transport_error"]
    assert "[redacted proxy URL]" in body["_transport_error"]


if __name__ == "__main__":
    test_account_antigravity_ua_and_auto_onboard()
    test_account_skips_onboard_when_validation_required()
    test_realistic_login_settlement_hostname_and_headless_device_inheritance()
    test_post_oauth_auto_pulls_models_and_refreshes_expired_token()
    test_unsupported_client_fallback_and_distinct_classification()
    test_refresh_token_import_exchanges_and_creates_standard_profile()
    test_default_oauth_elf64_extraction_env_override_and_transport_redaction()
    print("OK")
