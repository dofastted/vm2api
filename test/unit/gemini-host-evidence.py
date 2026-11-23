import json
import tempfile
from hashlib import sha256
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("gemini_host", ROOT / "scripts/gemini-host.py")
impl = module_from_spec(spec)
spec.loader.exec_module(impl)

API = "gemini-" + "1" * 24
OAUTH = "gemini-" + "2" * 24
PROFILE = "a" * 32
MODEL = "gemini-3-pro"
PROXY = "socks5h://fixture:private-proxy@192.0.2.11:1080"
KEY = "fixture-api-key-not-real"
OAUTH_TOKEN = "fixture-private-oauth-token"
PROMPT, REPLY = "private prompt", "private reply"
STARTED = "2030-01-01T00:00:00+00:00"
FINISHED = "2030-01-01T00:00:01+00:00"
CANCELLED = "gemini_inference_cancelled"
COMPLETION = {"state": "completed", "text": REPLY, "usage": {"total_tokens": 19}}


class FixtureHost(impl.Host):
    fixture_version = "fixture-1"

    def payload_config(self):
        return self.payload, True, self.public_key, None, self.fixture_version

    def payload_identity(self, source, public_key, digest):
        return digest

    def verify_payload(self, source, public_key, install=False):
        return self.fixture_version

    def recover_network(self, env_dir, slot):
        pass

    def oauth_runtime_issue(self):
        return None


def rejects(callback, status, code=None):
    try:
        callback()
    except impl.Failure as error:
        assert (error.status, error.code) == (status, code)
    else:
        raise AssertionError("host accepted a rejected operation")


def evidence(host, identifier=API):
    return host.request("get", {"id": identifier})["last_inference"]


def bound(host, operation, identifier=API, **fields):
    # Test the host operation without the root-only maintenance lock.
    return host._request(
        operation,
        {
            "id": identifier,
            "proxy_id": host.environments[identifier]["proxy_id"],
            "proxy_url": PROXY,
            **fields,
        },
    )


def start(host, identifier=API):
    return {
        "id": identifier,
        **bound(host, "test-chat", identifier, model=MODEL, prompt=PROMPT),
    }


def failure(code):
    return {"state": "failed", "text": "", "error": {"code": code, "message": REPLY}}


with tempfile.TemporaryDirectory(prefix="gemini-evidence-") as temporary:
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
    records = {
        API: {
            "id": API,
            "name": "API",
            "proxy_id": "first",
            "auth_state": "authorized",
            "auth_method": "api_key",
            "updated_at": STARTED,
            "slot": 0,
        },
        OAUTH: {
            "id": OAUTH,
            "name": "OAuth",
            "proxy_id": "first",
            "auth_state": "authorized",
            "auth_method": "oauth",
            "profile": PROFILE,
            "call_models": [MODEL],
            "updated_at": STARTED,
            "slot": 1,
        },
    }
    state_file = directory / "environments.json"
    state_file.write_text(json.dumps(records))
    (directory / API).mkdir()
    (directory / API / "credential.json").write_text(json.dumps({"api_key": KEY}))
    (directory / OAUTH / PROFILE).mkdir(parents=True)

    with (
        patch.object(
            impl, "check_root_owned"
        ),  # Local temp files need not be root-owned.
        patch.object(
            impl, "read_root_file", side_effect=lambda path, limit: path.read_bytes()
        ),
        patch.object(
            impl, "profile_secrets", return_value=((OAUTH_TOKEN,), b"private token")
        ),
        patch.object(impl, "read_account") as upstream,
        patch.object(impl, "invocation_module") as invocation,
        patch.object(impl, "NativeSession") as native_session,
        patch.object(impl, "ResidentTestChatRun") as native,
        patch.object(impl, "Login") as login,
        patch.object(impl, "now", return_value=STARTED) as clock,
    ):
        host = FixtureHost(args)
        api_worker = invocation.return_value.Invocation
        process = Mock()
        process.poll.return_value = {"state": "running", "text": ""}
        api_worker.return_value = process
        native.return_value = process
        warm_session = Mock()
        warm_session.max_concurrency = 1
        warm_session.proxy_hash = sha256(PROXY.encode()).digest()
        warm_session.is_alive.return_value = True
        warm_session.is_severely_unhealthy.return_value = False
        warm_session._last_health_at = float("inf")
        native_session.return_value = warm_session
        initial = host.request("list", {})["environments"]
        assert all(
            e["runtime_ready"] is False and e["last_inference"] is None for e in initial
        )
        upstream.assert_not_called()
        rejects(lambda: start(host), 409, "gemini_model_unavailable")
        api_worker.assert_not_called()
        assert evidence(host) is None

        upstream.return_value = {
            "state": "ok",
            "models": [MODEL],
            "checked_at": STARTED,
        }
        assert bound(host, "models")["last_inference"] is None
        run = start(host)
        running = {
            "state": "running",
            "model": MODEL,
            "started_at": STARTED,
            "finished_at": None,
            "error_code": None,
        }
        assert evidence(host) == running
        assert evidence(host, OAUTH) is None
        rejects(lambda: start(host), 409, "gemini_operation_busy")
        api_worker.assert_called_once()
        assert evidence(host) == running
        listing = host.request("list", {})["environments"]
        assert listing[0]["last_inference"] == running
        first_digest = sha256(PROXY.encode()).hexdigest()
        assert listing[0]["last_inference_proxy_sha256"] == first_digest
        assert "last_inference_proxy_sha256" not in listing[1]
        process.poll.assert_not_called()
        upstream.assert_called_once()  # Only explicit model discovery did upstream work.

        process.poll.return_value = COMPLETION
        clock.return_value = FINISHED
        assert host.request("test-chat-status", run) == COMPLETION
        completed = {**running, "state": "completed", "finished_at": FINISHED}
        assert evidence(host) == completed
        process.close.assert_called_once()
        rejects(
            lambda: bound(host, "test-chat", model="missing-model", prompt=PROMPT),
            409,
            "gemini_model_unavailable",
        )
        assert evidence(host) == completed
        host.runs[API]["deadline"] = 0
        host.cleanup()
        rejects(
            lambda: host.request("test-chat-status", run), 404, "gemini_run_not_found"
        )
        assert evidence(host) == completed

        explicit = "gemini_native_tty_unavailable"
        native.side_effect = impl.Failure(503, explicit)
        rejects(lambda: start(host, OAUTH), 503, explicit)
        assert evidence(host, OAUTH) == {
            **completed,
            "state": "failed",
            "started_at": FINISHED,
            "error_code": explicit,
        }
        assert evidence(host) == completed
        native.side_effect = None

        for code, state, projected in (
            ("gemini_location_unsupported", "failed", "gemini_location_unsupported"),
            (OAUTH_TOKEN, "failed", None),
            (CANCELLED, "cancelled", CANCELLED),
        ):
            run = start(host, OAUTH)
            process.poll.return_value = failure(code)
            host.cleanup()
            assert evidence(host, OAUTH)["state"] == state
            assert evidence(host, OAUTH)["error_code"] == projected
            assert host.request("test-chat-status", run) == failure(
                code
            )  # Existing wire outcome.
            assert host.request("test-chat-cancel", run) == {"cancelled": True}
            assert evidence(host, OAUTH)["state"] == state

        run = start(host)
        process.poll.return_value = {"state": "running", "text": ""}
        host.runs[API]["deadline"] = 0
        assert (
            host.request("test-chat-status", run)["error"]["code"]
            == "gemini_inference_timeout"
        )
        assert evidence(host)["error_code"] == "gemini_inference_timeout"
        run = start(host)
        rejects(
            lambda: host.request("test-chat-cancel", {**run, "run_id": "wrong"}),
            404,
            "gemini_run_not_found",
        )
        assert evidence(host)["state"] == "running"
        assert host.request("test-chat-cancel", run) == {"cancelled": True}
        cancelled = evidence(host)
        assert (
            cancelled["state"] == "cancelled" and cancelled["error_code"] == CANCELLED
        )
        assert cancelled["finished_at"] == FINISHED
        rejects(
            lambda: host.request("test-chat-status", run), 404, "gemini_run_not_found"
        )

        snapshot = json.dumps(host.request("list", {}))
        for private in (
            KEY,
            OAUTH_TOKEN,
            PROMPT,
            REPLY,
            "private-proxy",
            PROFILE,
            run["run_id"],
            "total_tokens",
            "last_inference_binding",
        ):
            assert private not in snapshot
        assert "last_inference" not in state_file.read_text()
        assert FixtureHost(args).request("get", {"id": API})["last_inference"] is None
        assert evidence(host) == cancelled

        rebound = bound(
            host, "proxy-bind", previous_proxy_id="first", proxy_id="second"
        )
        assert rebound["proxy_id"] == "second" and rebound["last_inference"] is None
        assert evidence(host, OAUTH)["state"] == "cancelled"
        assert bound(host, "models")["last_inference"] is None
        run = start(host)
        # A payload version change invalidates active as well as completed evidence.
        host.fixture_version = "fixture-2"
        assert evidence(host) is None and evidence(host, OAUTH) is None
        host.fixture_version = "fixture-1"
        process.poll.return_value = COMPLETION
        assert host.request("test-chat-status", run) == COMPLETION
        assert (
            evidence(host) is None
        )  # An in-flight old binding cannot restore evidence.

        rotated = PROXY.replace("private-proxy", "rotated-proxy")
        run = {
            "id": API,
            **bound(host, "test-chat", model=MODEL, prompt=PROMPT, proxy_url=rotated),
        }
        assert host.request("test-chat-status", run) == COMPLETION
        assert evidence(host)["state"] == "completed"
        assert (
            host.request("get", {"id": API})["last_inference_proxy_sha256"]
            == sha256(rotated.encode()).hexdigest()
        )
        assert host.environments[API]["updated_at"] == FINISHED
        rediscovered = bound(host, "models")
        assert rediscovered["updated_at"] == FINISHED
        assert rediscovered["last_inference"] is None

        run = start(host, OAUTH)
        assert host.request("test-chat-status", run) == COMPLETION
        assert evidence(host, OAUTH)["state"] == "completed"
        attempt = "b" * 32
        login.return_value.attempt = attempt
        login.return_value.deadline = float("inf")
        login.return_value.proxy_url = PROXY
        login.return_value.challenge.return_value = {"attempt_id": attempt}
        login.return_value.finished.return_value = True
        assert bound(host, "authorize", OAUTH) == {"attempt_id": attempt}
        assert evidence(host, OAUTH) is None
        host.cleanup()
        assert host.request("get", {"id": OAUTH})["auth_state"] == "authorized"
        assert evidence(host, OAUTH) is None
        assert host.environments[OAUTH]["profile"] == attempt

        start(host)
        assert evidence(host)["state"] == "running"
        host._request("delete", {"id": API})
        assert API not in host.last_inference
        assert [e["id"] for e in host.request("list", {})["environments"]] == [OAUTH]
        rejects(lambda: evidence(host), 404)
