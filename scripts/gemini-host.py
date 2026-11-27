import argparse
import base64
import codecs
import errno
import fcntl
import grp
import hashlib
import hmac
import importlib.util
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler
import ipaddress
import json
import os
from pathlib import Path
import pty
import pwd
import queue
import re
import secrets
import select
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import termios
import threading
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit, urlunsplit

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from gemini_agy_patch import (
    AGY_ALLOWED_SHA256S,
    AGY_PATCHED_SHA256,
    AGY_UNPATCHED_SHA256,
    file_sha256 as agy_file_sha256,
    inspect_agy_patch,
)
from gemini_host_apparmor import (
    active_host_root,
    managed_bwrap_entry_configured,
    managed_bwrap_required,
    resolve_bwrap_argv0,
)

ROOT = Path(__file__).resolve().parents[1]
MAX_NETNS_SLOTS = 8
MAX_ENVIRONMENTS = 256
MAX_CONCURRENCY = 64
DEFAULT_ENV_CONCURRENCY = 20
DEFAULT_MAX_SESSIONS = 20
ELIGIBILITY_PROBE_INTERVAL = 180.0
MAX_ACCOUNTS_PER_DAEMON = 256
DEFAULT_ACCOUNTS_PER_DAEMON = 50
SHARD_HEALTH_FAIL_THRESHOLD = 3
SHARD_RESTART_BACKOFF_MIN = 2.0
SHARD_RESTART_BACKOFF_MAX = 60.0
SHARD_ID = re.compile(r"shard-[0-9]{1,4}\Z")
LIFECYCLE_ACTIONS = frozenset({"pause", "resume", "recycle", "reset_circuit"})
SCHEDULING_STRATEGIES = frozenset({"balanced", "fill", "round_robin"})
AUTH_TTL = 300
AUTH_MIN_SETTLE_SECONDS = 3.0
AUTH_SETTLE_SECONDS = 6.0
TERMINAL_TTL = 300
TERMINAL_READ = 16384
TERMINAL_INPUT = 1024
ATTEMPT = re.compile(r"[a-f0-9]{32}\Z")
TOKEN_NAME = "antigravity-oauth-token"
ACCESS_TOKEN = re.compile(r"[A-Za-z0-9._~+/-]{1,4096}={0,2}\Z")
CLI_SETTINGS = {"toolPermission": "strict", "useG1Credits": False}
NATIVE_CLI_SETTINGS = {
    "allowNonWorkspaceAccess": True,
    "useG1Credits": False,
    "verbosity": "high",
    "permissions": {
        "allow": [
            "read_file(/work/.craggemini-media)",
            "read_file(/work/.craggemini-media/*)",
            "read_file(/work/.craggemini-media/**)",
            "read_file(/tmp/craggemini)",
            "read_file(/tmp/craggemini/**)",
        ],
        "deny": [
            "write_file(*)",
            "command(*)",
        ],
    },
}
CLI_MARKER = b"\x02agy-start\x03"
DISPLAY_CSI = re.compile(r"\x1b\[[?=>]?[0-9;:]*[A-HJKSTXcdfhlmnrsu]")
TERMINAL_OAUTH = "gemini_terminal_requires_oauth"
OAUTH_MENU = "> 1. Google OAuth"
OAUTH_OUTPUT = (
    "https://accounts.google.com/",
    "https://antigravity.google/oauth-callback",
    "Enter authorization code",
    "code_challenge=",
)
# agy probes capabilities before painting its first screen, while the browser
# is still waiting for terminal-start. Match xterm's initial DA responses.
STARTUP_DA = {"\x1b[c": b"\x1b[?1;2c", "\x1b[>c": b"\x1b[>0;276;0c"}
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
CODE = re.compile(r"[A-Za-z0-9._~/-]{1,2048}\Z")
API_KEY = re.compile(r"[A-Za-z0-9_-]{20,256}\Z")
OAUTH_ACCESS_TOKEN = re.compile(r"[A-Za-z0-9._~+/-]{1,4096}={0,2}\Z")
OAUTH_REFRESH_TOKEN = re.compile(r"1//[0-9A-Za-z._~+/-]{6,2048}\Z")
OAUTH_AUTH_METHODS = frozenset(
    {
        "consumer",
        "personal_consumer",
        "gcp",
        "business_licensed_enterprise",
        "antigravity_enterprise",
        "enterprise",
        "gemini_cli",
        "geminicli",
        "oauth",
    }
)
OAUTH_CLIENT_KEY = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")
OAUTH_PROJECT_ID = re.compile(r"[A-Za-z0-9._:/-]{1,128}\Z")
WIF_PROVIDER = re.compile(r"[A-Za-z0-9._:/-]{1,512}\Z")
RELEASE_CODE = re.compile(r"CGG1-[A-Za-z0-9_-]{43}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
MANUAL_RELEASE = Path("/etc/vm2api/gemini-release.json")
_NATIVE_ALLOWED_TOP = frozenset(
    {
        "model",
        "contents",
        "stream",
        "systemInstruction",
        "system_instruction",
        "system_prompt_mode",
        "tools",
        "toolConfig",
        "tool_config",
        "generationConfig",
        "generation_config",
        "safetySettings",
        "safety_settings",
        "cachedContent",
        "cached_content",
        "conversation_id",
        "conversationId",
    }
)
_NATIVE_ALLOWED_PART_KEYS = frozenset(
    {
        "text",
        "inlineData",
        "inline_data",
        "fileData",
        "file_data",
        "functionCall",
        "function_call",
        "functionResponse",
        "function_response",
        "thought",
        "thoughtSignature",
        "thought_signature",
    }
)
_NATIVE_SUBSTANTIVE_PART_KEYS = frozenset(
    {
        "inlineData",
        "inline_data",
        "fileData",
        "file_data",
        "functionCall",
        "function_call",
        "functionResponse",
        "function_response",
    }
)
_NATIVE_VALID_ASPECT_RATIOS = frozenset(
    {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
)
_NATIVE_VALID_IMAGE_SIZES = frozenset({"1K", "2K", "4K"})
_NATIVE_ALLOWED_TOOL_KEYS = frozenset(
    {
        "functionDeclarations",
        "function_declarations",
        "googleSearch",
        "google_search",
        "urlContext",
        "url_context",
    }
)
_NATIVE_ILLEGAL_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_NATIVE_CONV_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
_SSE_STREAM_READ_BYTES = 65536
AUTH_LINK = re.compile(
    rb"\x1b\]8;[^;\x1b]*;(https://accounts\.google\.com/o/oauth2/auth\?[^\x07\x1b]{1,4096})(?:\x07|\x1b\\)"
)
AUTH_FAILURE = re.compile(
    rb"(invalid authorization code|failed to exchange|authentication failed)", re.I
)
SYSTEM_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin", "LANG": "C.UTF-8"}
PAYLOAD_FILES = (
    "manifest.json",
    "manifest.sig",
    "agy",
    "craggemini",
    "libagy_bridge.so",
)
CRAG_PAYLOAD_FILES = (
    "manifest.json",
    "agy",
    "craggemini",
    "craggemini.payload.enc",
    "libagy_bridge.so",
    "crag-license-public.pem",
)
LICENSE_ERROR_CODES = frozenset(
    {
        "license_required",
        "license_expired",
        "license_not_yet_valid",
        "license_invalid",
        "license_binding_mismatch",
        "license_payload_key_mismatch",
        "license_unconfigured",
        "gemini_subscription_sync_pending",
    }
)


def extract_permit_payload_key_id(code):
    if not isinstance(code, str):
        return None
    text = code.strip()
    if not text or len(text) > 65536:
        return None
    parts = text.split(".")
    if len(parts) != 3 or parts[0] not in ("CRAGS1", "CRAGL1"):
        return None
    segment = parts[1]
    if not segment:
        return None
    try:
        padded = segment + "=" * (-len(segment) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        claims = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(claims, dict):
        return None
    key_id = claims.get("payload_key_id")
    if isinstance(key_id, str) and SHA256.fullmatch(key_id):
        return key_id
    return None


BWRAP_FATAL_STDERR = re.compile(rb"bwrap:\s+(?!warning\b)", re.I)
BWRAP_BIND_MOUNT_STDERR = re.compile(
    rb"can't find source path|can't bind mount|can't mount proc|"
    rb"failed to (?:open|mount)|no such file or directory|"
    rb"execvp\s+\S+:\s*permission\s+denied",
    re.I,
)


def _bwrap_fatal_stderr(stderr):
    if not isinstance(stderr, str) or not stderr.strip():
        return None
    fatal_lines = []
    for line in stderr.splitlines():
        stripped = line.lstrip()
        lower = stripped.lower()
        if lower.startswith("bwrap:") and not lower.startswith("bwrap: warning"):
            fatal_lines.append(stripped)
    if not fatal_lines:
        return None
    return "\n".join(fatal_lines)


def _classify_bwrap_launch_stderr(stderr, *, host_root=Path("/")):
    fatal = _bwrap_fatal_stderr(stderr)
    if fatal is None:
        return None
    raw = fatal.encode("utf-8", errors="replace")
    if not BWRAP_FATAL_STDERR.search(raw):
        return None
    if BWRAP_BIND_MOUNT_STDERR.search(raw):
        return 503, "gemini_sandbox_unavailable"
    if _apparmor_sandbox_evidence(raw, host_root=host_root):
        return 503, "gemini_sandbox_apparmor_restricted"
    return 503, "gemini_sandbox_unavailable"


def classify_craggemini_license_cli_error(stdout, stderr, *, sync_pending=False):
    if isinstance(stdout, str) and stdout.strip():
        try:
            parsed = json.loads(stdout)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            code = parsed.get("code")
            if isinstance(code, str) and code in LICENSE_ERROR_CODES:
                if code == "license_invalid" and sync_pending:
                    return 503, "gemini_subscription_sync_pending"
                return (503 if code == "gemini_subscription_sync_pending" else 403), code
    text = (stderr or "").lower()
    if "payload key" in text or "unlock the selected encrypted package" in text:
        return 403, "license_payload_key_mismatch"
    if (
        "different instance" in text
        or "different vm" in text
        or "different seat" in text
        or "different host" in text
        or "binding" in text
    ):
        return 403, "license_binding_mismatch"
    if "expired" in text:
        return 403, "license_expired"
    if "not valid yet" in text:
        return 403, "license_not_yet_valid"
    if "unconfigured" in text:
        return 403, "license_unconfigured"
    if (
        "registration code is required" in text
        or "permit or registration code is required" in text
    ):
        return 403, "license_required"
    sandbox = _classify_bwrap_launch_stderr(stderr)
    if sandbox is not None:
        return sandbox
    if sync_pending:
        return 503, "gemini_subscription_sync_pending"
    return 403, "license_invalid"


def reconcile_craggemini_license_status(
    status,
    *,
    expected_payload_key_id=None,
    permit_payload_key_id=None,
    sync_pending=False,
):
    if not isinstance(status, dict):
        return status
    if (
        status.get("valid") is not True
        and status.get("code") == "license_invalid"
        and sync_pending
    ):
        return {
            **status,
            "status": "sync_pending",
            "valid": False,
            "code": "gemini_subscription_sync_pending",
            "sync_pending": True,
            "message": "CRAGGemini host subscription sync is pending.",
        }
    if (
        status.get("valid") is True
        and isinstance(expected_payload_key_id, str)
        and SHA256.fullmatch(expected_payload_key_id)
    ):
        actual_key_id = status.get("payload_key_id") or permit_payload_key_id
        if (
            isinstance(actual_key_id, str)
            and SHA256.fullmatch(actual_key_id)
            and actual_key_id != expected_payload_key_id
        ):
            return {
                **status,
                "status": "invalid",
                "valid": False,
                "code": "license_payload_key_mismatch",
                "payload_key_id": actual_key_id,
                "message": "The CRAGGemini license payload key does not match the installed package.",
            }
    return status
AGY_SHA256 = AGY_UNPATCHED_SHA256
INFERENCE_MODULE = ROOT / "scripts/gemini_host_inference.py"
MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
INFER_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
RUN_TTL = 150
# Idle TTL for burst agy slots above min_warm_slots inside craggemini pool.
# Resident NativeSession & min_warm_slots=1 base agy process are NEVER reaped for idle time.
NATIVE_SESSION_TTL = 600
NATIVE_HEALTH_FAIL_THRESHOLD = 3
NATIVE_HEALTH_POLL_INTERVAL = 15.0
NATIVE_WARM_BACKOFF_MIN = 2.0
NATIVE_WARM_BACKOFF_MAX = 60.0
NATIVE_DEFAULT_MODEL = "gemini-3-flash"
DEFAULT_RUNTIME_POLICY = {
    "strategy": "balanced",
    "accounts_per_daemon": DEFAULT_ACCOUNTS_PER_DAEMON,
    "daemon_fault_isolation": True,
    "max_concurrency_per_account": DEFAULT_ENV_CONCURRENCY,
    "max_sessions_per_account": DEFAULT_MAX_SESSIONS,
    "min_warm_slots": 1,
    "session_idle_ttl_secs": NATIVE_SESSION_TTL,
    "max_queue": 32,
    "queue_timeout_ms": 10000,
    "timeout_ms": 120000,
    "first_byte_timeout_ms": 90000,
    "idle_timeout_ms": 15000,
    "circuit_failure_threshold": 3,
    "circuit_open_ms": 30000,
    "eligibility_probe_interval_secs": int(ELIGIBILITY_PROBE_INTERVAL),
    "sticky_enabled": True,
    "sticky_ttl_secs": 3600,
    "require_shm": True,
    "shm_request_mb": 4,
    "shm_response_mb": 16,
}


def _clamp_policy_int(value, lo, hi, fallback):
    if type(value) is bool or not isinstance(value, (int, float)):
        return fallback
    num = int(round(value))
    return max(lo, min(hi, num))


def normalize_runtime_policy(raw=None, base=None):
    merged = dict(DEFAULT_RUNTIME_POLICY)
    if isinstance(base, dict):
        merged.update(base)
    if not isinstance(raw, dict):
        return merged
    pool = raw.get("pool") if isinstance(raw.get("pool"), dict) else raw
    sticky = raw.get("sticky") if isinstance(raw.get("sticky"), dict) else raw
    shm = raw.get("shm") if isinstance(raw.get("shm"), dict) else raw
    strategy = pool.get("strategy", raw.get("strategy", merged["strategy"]))
    if strategy in SCHEDULING_STRATEGIES:
        merged["strategy"] = strategy
    merged["accounts_per_daemon"] = _clamp_policy_int(
        pool.get("accounts_per_daemon", raw.get("accounts_per_daemon")),
        1,
        MAX_ACCOUNTS_PER_DAEMON,
        merged["accounts_per_daemon"],
    )
    if isinstance(pool.get("daemon_fault_isolation"), bool):
        merged["daemon_fault_isolation"] = pool["daemon_fault_isolation"]
    elif isinstance(raw.get("daemon_fault_isolation"), bool):
        merged["daemon_fault_isolation"] = raw["daemon_fault_isolation"]
    merged["max_concurrency_per_account"] = _clamp_policy_int(
        pool.get("max_concurrency_per_account", raw.get("max_concurrency_per_account")),
        1,
        MAX_CONCURRENCY,
        merged["max_concurrency_per_account"],
    )
    merged["max_sessions_per_account"] = _clamp_policy_int(
        pool.get("max_sessions_per_account", raw.get("max_sessions_per_account")),
        1,
        MAX_CONCURRENCY,
        merged["max_sessions_per_account"],
    )
    raw_probe_interval = pool.get(
        "eligibility_probe_interval_secs", raw.get("eligibility_probe_interval_secs")
    )
    if raw_probe_interval == 0 and type(raw_probe_interval) is int:
        merged["eligibility_probe_interval_secs"] = 0
    elif raw_probe_interval is not None:
        merged["eligibility_probe_interval_secs"] = _clamp_policy_int(
            raw_probe_interval, 30, 3600, merged["eligibility_probe_interval_secs"]
        )
    merged["min_warm_slots"] = min(
        merged["max_concurrency_per_account"],
        _clamp_policy_int(
            pool.get("min_warm_slots", raw.get("min_warm_slots")),
            0,
            16,
            merged["min_warm_slots"],
        ),
    )
    raw_ttl = pool.get("session_idle_ttl_secs", raw.get("session_idle_ttl_secs"))
    if raw_ttl == 0 and type(raw_ttl) is int:
        merged["session_idle_ttl_secs"] = 0
    elif raw_ttl is not None:
        merged["session_idle_ttl_secs"] = _clamp_policy_int(
            raw_ttl, 10, 86400, merged["session_idle_ttl_secs"]
        )
    merged["max_queue"] = _clamp_policy_int(
        pool.get("max_queue", raw.get("max_queue")), 0, 64, merged["max_queue"]
    )
    merged["queue_timeout_ms"] = _clamp_policy_int(
        pool.get("queue_timeout_ms", raw.get("queue_timeout_ms")),
        100,
        600000,
        merged["queue_timeout_ms"],
    )
    merged["timeout_ms"] = _clamp_policy_int(
        pool.get("timeout_ms", raw.get("timeout_ms")),
        100,
        600000,
        merged["timeout_ms"],
    )
    merged["first_byte_timeout_ms"] = _clamp_policy_int(
        pool.get("first_byte_timeout_ms", raw.get("first_byte_timeout_ms")),
        100,
        600000,
        merged["first_byte_timeout_ms"],
    )
    merged["idle_timeout_ms"] = _clamp_policy_int(
        pool.get("idle_timeout_ms", raw.get("idle_timeout_ms")),
        100,
        600000,
        merged["idle_timeout_ms"],
    )
    merged["circuit_failure_threshold"] = _clamp_policy_int(
        pool.get("circuit_failure_threshold", raw.get("circuit_failure_threshold")),
        0,
        20,
        merged["circuit_failure_threshold"],
    )
    merged["circuit_open_ms"] = _clamp_policy_int(
        pool.get("circuit_open_ms", raw.get("circuit_open_ms")),
        1000,
        600000,
        merged["circuit_open_ms"],
    )
    if isinstance(sticky.get("enabled"), bool):
        merged["sticky_enabled"] = sticky["enabled"]
    elif isinstance(raw.get("sticky_enabled"), bool):
        merged["sticky_enabled"] = raw["sticky_enabled"]
    sticky_ttl = sticky.get("ttl_seconds", raw.get("sticky_ttl_secs"))
    if sticky_ttl is not None:
        merged["sticky_ttl_secs"] = _clamp_policy_int(
            sticky_ttl, 0, 604800, merged["sticky_ttl_secs"]
        )
    if isinstance(shm.get("require_shm"), bool):
        merged["require_shm"] = shm["require_shm"]
    elif isinstance(raw.get("require_shm"), bool):
        merged["require_shm"] = raw["require_shm"]
    merged["shm_request_mb"] = _clamp_policy_int(
        shm.get("request_mb", raw.get("shm_request_mb")),
        1,
        64,
        merged["shm_request_mb"],
    )
    merged["shm_response_mb"] = _clamp_policy_int(
        shm.get("response_mb", raw.get("shm_response_mb")),
        1,
        64,
        merged["shm_response_mb"],
    )
    return merged


def runtime_policy_to_kernel_patch(policy):
    pol = normalize_runtime_policy(policy)
    return {
        "strategy": pol["strategy"],
        "max_accounts": pol["accounts_per_daemon"],
        "sticky_enabled": pol["sticky_enabled"],
        "sticky_ttl_secs": pol["sticky_ttl_secs"],
        "require_shm": pol["require_shm"],
        "circuit_failure_threshold": pol["circuit_failure_threshold"],
        "circuit_open_ms": pol["circuit_open_ms"],
    }


# The kernel understands these scheduling / SHM keys only from 0.4.5 on. #1704 began
# emitting them while deploy/payload.json still pinned 0.4.4, so every release from
# v1.4.193 shipped a host that hands its own pinned payload a config that payload
# rejects: the worker exits before the handshake and the request fails as a bridge
# timeout (#1729).
#
# The boundary is the payload version, not a capability list. The pinned 0.4.4
# manifest already declares shm_ring_v2, shm_dispatch_v1, gateway_policy_v1 and
# live_control_v1, so capabilities do not describe which config keys it parses.
# Unlike the constant that drifted in #1677, this is not a second copy of the pin:
# it is the version a feature needs, so moving the pin forward lifts the gate on
# its own.
#
# Act only on a version we positively read as older than the minimum. An absent or
# unparseable version keeps today's behaviour instead of degrading: payload_failure()
# nulls payload_version, and treating that as "too old" would silently drop sharding
# and the SHM sizes on a healthy 0.4.5 host, trading the reported break for a quieter
# one.
KERNEL_POLICY_MIN_PAYLOAD = (0, 4, 5, 1)

KERNEL_POLICY_FIELDS = (
    "shm_request_bytes",
    "shm_response_bytes",
    "strategy",
    "max_accounts",
    "sticky_enabled",
    "sticky_ttl_secs",
    "require_shm",
    "circuit_failure_threshold",
    "circuit_open_ms",
)

_PAYLOAD_VERSION_RE = re.compile(r"\A(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?\Z")


def _parse_payload_version(version):
    """Order a payload version, with a prerelease sorting below its own release."""
    if not isinstance(version, str):
        return None
    match = _PAYLOAD_VERSION_RE.fullmatch(version.strip())
    if not match:
        return None
    return (
        int(match[1]),
        int(match[2]),
        int(match[3]),
        0 if match[4] else 1,
    )


def kernel_policy_rejected_by_payload(version):
    """True only for a version read as predating KERNEL_POLICY_MIN_PAYLOAD."""
    parsed = _parse_payload_version(version)
    return parsed is not None and parsed < KERNEL_POLICY_MIN_PAYLOAD


def strip_unsupported_kernel_policy(kernel_cfg, version):
    """Drop policy keys a payload known to predate 0.4.5 would reject."""
    if not kernel_policy_rejected_by_payload(version):
        return kernel_cfg
    for field in KERNEL_POLICY_FIELDS:
        kernel_cfg.pop(field, None)
    return kernel_cfg
BLOCKING_ACCOUNT_ELIGIBILITIES = frozenset(
    {
        "verification_required",
        "location_unsupported",
        "client_unsupported",
        "ineligible",
    }
)


ADVISORY_SESSION_DIAGNOSTICS = frozenset({"gemini_client_unsupported"})


def session_diagnostic(session, *, final=False, include_advisory=False):
    diag = getattr(session, "native_diagnostic", None)
    if diag is None:
        return None
    if not include_advisory:
        try:
            code = diag.poll(final=final, include_advisory=False)
        except TypeError:
            code = diag.poll(final=final)
        return None if code in ADVISORY_SESSION_DIAGNOSTICS else code
    return diag.poll(final=final)
MAX_INFER_BODY = 12 * 1024 * 1024
NATIVE_RUNTIME_ROOT = Path("/run/vm2api-gemini-native")
FULL_CAPABILITIES = (
    "streaming",
    "multi_turn",
    "system_instruction",
    "tools",
    "generation_config",
    "thinking",
    "multimodal",
    "full_gemini_api",
)
NATIVE_CAPABILITIES = (
    "streaming",
    "native_tui",
    "multi_turn",
    "system_instruction",
    "tools",
    "generation_config",
    "thinking",
    "multimodal",
)
# Fixed categories only: process output and exception details are not inventory data.
INFERENCE_ERROR_CODES = frozenset(
    {
        "gemini_account_ineligible",
        "gemini_account_verification_required",
        "gemini_api_key_invalid",
        "gemini_client_unsupported",
        "gemini_inference_bad_input",
        "gemini_inference_cancelled",
        "gemini_inference_failed",
        "gemini_inference_invalid_output",
        "gemini_inference_output_limit",
        "gemini_inference_start_failed",
        "gemini_inference_timeout",
        "gemini_inference_tool_blocked",
        "gemini_location_unsupported",
        "gemini_model_unavailable",
        "gemini_models_empty",
        "gemini_native_bridge_timeout",
        "gemini_native_config_invalid",
        "gemini_native_tty_unavailable",
        "gemini_native_worker_unavailable",
        "gemini_oauth_required",
        "gemini_proxy_error",
        "gemini_quota_exhausted",
        *LICENSE_ERROR_CODES,
    }
)

_TRUSTED_MODULES = {}
_TRUSTED_MODULES_LOCK = threading.Lock()


def _load_trusted_module(name, path):
    check_root_owned(path)
    info = path.lstat()
    identity = (
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_ctime_ns,
        info.st_mtime_ns,
    )
    with _TRUSTED_MODULES_LOCK:
        cached = _TRUSTED_MODULES.get(name)
        if cached is not None and cached[0] == identity:
            return cached[1]
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _TRUSTED_MODULES[name] = (identity, module)
        return module


def invocation_module():
    return _load_trusted_module("gemini_host_inference", INFERENCE_MODULE)


SANDBOX_PROBE_OK_TTL = 300.0
SANDBOX_PROBE_FAIL_TTL = 15.0
SANDBOX_PROBE_TIMEOUT = 3.0
SANDBOX_PROBE_STDERR_LIMIT = 4096
SANDBOX_APPARMOR_PROFILE = "vm2api-gemini"
SANDBOX_APPARMOR_STDERR = re.compile(
    rb"(?:uid_map|permission denied|operation not permitted)", re.I
)
SANDBOX_ERROR_CODES = frozenset(
    {
        "gemini_sandbox_apparmor_restricted",
        "gemini_sandbox_unavailable",
    }
)
HOST_RESOURCE_ERROR_CODES = frozenset({"gemini_host_resource_exhausted"})

_LICENSE_HOST_RESOURCE_ERRNOS = frozenset({errno.EMFILE, errno.ENFILE})


def classify_craggemini_license_host_error(exc):
    if isinstance(exc, OSError) and exc.errno in _LICENSE_HOST_RESOURCE_ERRNOS:
        return 503, "gemini_host_resource_exhausted"
    if isinstance(exc, subprocess.SubprocessError):
        for err in (exc.__cause__, exc.__context__):
            if isinstance(err, OSError) and err.errno in _LICENSE_HOST_RESOURCE_ERRNOS:
                return 503, "gemini_host_resource_exhausted"
    return None
SAFE_AUTH_REASON = re.compile(
    r"\A(?:timeout|os_error|failed|exited|exit_code=-?[0-9]{1,5}|signal=[0-9]{1,3})\Z"
)

AUTH_FAILURE_STAGES = frozenset(
    {
        "network_prepare",
        "relay_start",
        "proxy_probe",
        "egress_start",
        "sandbox_denied",
        "cli_launch",
        "cli_early_exit",
        "challenge_wait",
    }
)


class Failure(Exception):
    def __init__(self, status, code=None, stage=None, reason=None, message=None):
        self.status = status
        self.code = code
        self.stage = stage if stage in AUTH_FAILURE_STAGES else None
        self.reason = (
            reason
            if isinstance(reason, str) and SAFE_AUTH_REASON.fullmatch(reason)
            else None
        )
        self.message = (
            re.sub(r"\s+", " ", message).strip()[:512]
            if isinstance(message, str) and message.strip()
            else None
        )


def _read_bounded_text(path, limit=256):
    try:
        with open(path, "rb") as stream:
            return stream.read(limit).decode("utf-8", errors="replace").strip()
    except OSError:
        return None


def _apparmor_sandbox_evidence(stderr_bytes=b"", *, host_root=Path("/")):
    enabled = _read_bounded_text(
        host_root / "sys/module/apparmor/parameters/enabled"
    )
    if enabled not in {"Y", "1", "yes"}:
        return False
    restricted = _read_bounded_text(
        host_root / "proc/sys/kernel/apparmor_restrict_unprivileged_userns"
    )
    if restricted != "1":
        return False
    current = _read_bounded_text(host_root / "proc/self/attr/apparmor/current")
    if current is None:
        current = _read_bounded_text(host_root / "proc/self/attr/current")
    lacks_profile = False
    if current is not None:
        parts = current.split()
        profile_token = parts[0] if parts else ""
        lacks_profile = (
            profile_token == "unconfined"
            or profile_token != SANDBOX_APPARMOR_PROFILE
        )
    stderr_match = bool(
        stderr_bytes and SANDBOX_APPARMOR_STDERR.search(stderr_bytes)
    )
    return lacks_profile or stderr_match


def _bwrap_tool_available():
    if shutil.which("bwrap", path=SYSTEM_ENV["PATH"]):
        return True
    entry = Path(resolve_bwrap_argv0(host_root=active_host_root()))
    return entry.is_file() and os.access(entry, os.X_OK)


def _sandbox_probe_command(uid, *, true_bin=None):
    if true_bin is None:
        true_bin = "/usr/bin/true" if os.path.exists("/usr/bin/true") else "/bin/true"
    return [
        "setpriv",
        "--reuid",
        str(uid),
        "--regid",
        str(uid),
        "--clear-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        resolve_bwrap_argv0(host_root=active_host_root()),
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--die-with-parent",
        "--clearenv",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind-try",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind-try",
        "/bin",
        "/bin",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--",
        true_bin,
    ]


def _run_bounded_probe(
    argv,
    *,
    timeout=SANDBOX_PROBE_TIMEOUT,
    stderr_limit=SANDBOX_PROBE_STDERR_LIMIT,
):
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=SYSTEM_ENV,
        start_new_session=True,
    )
    stderr_buf = bytearray()
    deadline = time.monotonic() + timeout
    timed_out = False
    try:
        stderr_fd = None
        if proc.stderr is not None:
            try:
                stderr_fd = proc.stderr.fileno()
            except (AttributeError, OSError, ValueError):
                stderr_fd = None
        if stderr_fd is not None:
            os.set_blocking(stderr_fd, False)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                ready, _, _ = select.select([stderr_fd], [], [], min(0.1, remaining))
                if ready:
                    try:
                        chunk = os.read(stderr_fd, 4096)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        break
                    if len(stderr_buf) < stderr_limit:
                        stderr_buf.extend(chunk[: stderr_limit - len(stderr_buf)])
                elif proc.poll() is not None:
                    while True:
                        try:
                            chunk = os.read(stderr_fd, 4096)
                        except BlockingIOError:
                            break
                        if not chunk:
                            break
                        if len(stderr_buf) < stderr_limit:
                            stderr_buf.extend(chunk[: stderr_limit - len(stderr_buf)])
                    break
        if not timed_out:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                rc = proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                timed_out = True
                rc = None
        else:
            rc = None
        if timed_out:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
            return None, b""
        if stderr_fd is None and proc.stderr is not None:
            raw = proc.stderr.read(stderr_limit)
            if isinstance(raw, str):
                raw = raw.encode("utf-8", errors="replace")
            if raw:
                stderr_buf.extend(raw[:stderr_limit])
        return rc, bytes(stderr_buf)
    finally:
        if proc.stderr is not None:
            try:
                proc.stderr.close()
            except OSError:
                pass


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def env_concurrency(env, default=DEFAULT_ENV_CONCURRENCY):
    value = env.get("max_concurrency") if isinstance(env, dict) else None
    if type(value) is int and 1 <= value <= MAX_CONCURRENCY:
        return value
    if type(default) is int and 1 <= default <= MAX_CONCURRENCY:
        return default
    return DEFAULT_ENV_CONCURRENCY


def env_hostname(env):
    identifier = env.get("id") if isinstance(env, dict) else None
    if not isinstance(identifier, str) or not identifier:
        return "ws-default"
    digest = hashlib.sha256(f"vm2api-gemini-host:{identifier}".encode("utf-8")).hexdigest()
    return f"ws-{digest[:8]}"


def verify_proxy_sha256(body, proxy_url):
    if "proxy_sha256" not in body or body["proxy_sha256"] is None:
        return
    expected = body["proxy_sha256"]
    actual = hashlib.sha256(proxy_url.encode()).hexdigest()
    if (
        not isinstance(expected, str)
        or not SHA256.fullmatch(expected)
        or not hmac.compare_digest(expected, actual)
    ):
        raise Failure(409, "gemini_proxy_calibration_mismatch")


NATIVE_MODULE = ROOT / "scripts/gemini_host_native.py"


def native_module():
    return _load_trusted_module("gemini_host_native", NATIVE_MODULE)


def account_command(uid, method, profile=None):
    return [
        "setpriv",
        "--reuid",
        str(uid),
        "--regid",
        str(uid),
        "--clear-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        sys.executable,
        "-I",
        str(ROOT / "scripts/gemini_host_account.py"),
        method,
        *([str(profile)] if profile is not None else []),
    ]


OAUTH_CLIENT_ENV_KEYS = (
    "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID",
    "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET",
    "KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID",
    "KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET",
    "KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_ID",
    "KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_SECRET",
    "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_ID",
    "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_SECRET",
    "KIN_GEMINI_OAUTH_WIF_CLIENT_ID",
)
_AGY_DEFAULT_OAUTH_CLIENT_IDS = {
    "consumer": "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    "cloud": "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com",
    "enterprise": "1098991175725-mdu1oe5cbbe1ckggsebobh94toiap657.apps.googleusercontent.com",
}
_AGY_OAUTH_SECRET_RE = re.compile(rb"GOCSPX-[A-Za-z0-9_-]{28}\Z")
_AGY_LEA_RE = re.compile(
    rb"[\x48\x4c]\x8d[\x05\x0d\x15\x1d\x25\x2d\x35\x3d](.{4})", re.DOTALL
)
_AGY_OAUTH_CACHE = {}
_AGY_OAUTH_CACHE_LOCK = threading.Lock()


def _extract_agy_oauth_clients(agy_path):
    """Extract default OAuth client ID/secret pairs from the installed verified agy ELF64 binary.

    Go concatenates .rodata string literals without NUL terminators, so on x86_64 secrets are
    paired via RIP-relative LEA references in .text; non-x86_64 ELF64 binaries fall back to
    strictly bounded .rodata adjacency.
    """
    if agy_path is None:
        return {}
    path = Path(agy_path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return {}
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 64 <= info.st_size <= 512 * 1024 * 1024:
            return {}
        cache_key = (str(path), info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size)
        with _AGY_OAUTH_CACHE_LOCK:
            cached = _AGY_OAUTH_CACHE.get(cache_key)
            if cached is not None:
                return dict(cached)
        with os.fdopen(fd, "rb") as stream:
            fd = None
            hdr = stream.read(64)
            if len(hdr) < 64 or hdr[:4] != b"\x7fELF" or hdr[4] != 2 or hdr[5] != 1:
                result = {}
            else:
                e_machine = struct.unpack_from("<H", hdr, 18)[0]
                e_shoff = struct.unpack_from("<Q", hdr, 40)[0]
                e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", hdr, 58)
                result = {}
                if (
                    e_shoff > 0
                    and e_shentsize >= 64
                    and 0 < e_shnum <= 4096
                    and e_shstrndx < e_shnum
                    and e_shoff + e_shentsize * e_shnum <= info.st_size
                ):
                    stream.seek(e_shoff)
                    sh_table = stream.read(e_shentsize * e_shnum)
                    sections = []
                    for idx in range(e_shnum):
                        off = idx * e_shentsize
                        sh_name = struct.unpack_from("<I", sh_table, off)[0]
                        sh_addr, sh_offset, sh_size = struct.unpack_from("<QQQ", sh_table, off + 16)
                        sections.append((sh_name, sh_addr, sh_offset, sh_size))
                    _, _, str_off, str_size = sections[e_shstrndx]
                    if str_off + str_size <= info.st_size and str_size <= 16 * 1024 * 1024:
                        stream.seek(str_off)
                        shstr = stream.read(str_size)
                        named = {}
                        for sh_name, sh_addr, sh_offset, sh_size in sections:
                            if sh_name < len(shstr):
                                end = shstr.find(b"\x00", sh_name)
                                name = shstr[sh_name : end if end >= 0 else len(shstr)]
                                if name in (b".text", b".rodata"):
                                    named[name] = (sh_addr, sh_offset, sh_size)
                        if b".rodata" in named:
                            ro_addr, ro_off, ro_size = named[b".rodata"]
                            if ro_off + ro_size <= info.st_size:
                                stream.seek(ro_off)
                                rodata = stream.read(ro_size)
                                id_vas = {}
                                id_ro_positions = {}
                                for kind, cid in _AGY_DEFAULT_OAUTH_CLIENT_IDS.items():
                                    needle = cid.encode("ascii")
                                    pos = rodata.find(needle)
                                    while pos >= 0:
                                        id_vas[ro_addr + pos] = kind
                                        id_ro_positions.setdefault(kind, []).append(
                                            (pos, len(needle))
                                        )
                                        pos = rodata.find(needle, pos + 1)
                                sec_vas = {}
                                sec_ro_positions = []
                                pos = rodata.find(b"GOCSPX-")
                                while pos >= 0:
                                    cand = rodata[pos : pos + 35]
                                    if _AGY_OAUTH_SECRET_RE.fullmatch(cand):
                                        sec_str = cand.decode("ascii")
                                        sec_vas[ro_addr + pos] = sec_str
                                        sec_ro_positions.append((pos, sec_str))
                                    pos = rodata.find(b"GOCSPX-", pos + 1)
                                if (
                                    e_machine == 62
                                    and b".text" in named
                                    and id_vas
                                    and sec_vas
                                ):
                                    text_addr, text_off, text_size = named[b".text"]
                                    if text_off + text_size <= info.st_size:
                                        stream.seek(text_off)
                                        text_data = stream.read(text_size)
                                        id_refs = {}
                                        sec_refs = []
                                        for match in _AGY_LEA_RE.finditer(text_data):
                                            disp = struct.unpack_from("<i", match.group(1))[0]
                                            target_va = text_addr + match.start() + 7 + disp
                                            kind = id_vas.get(target_va)
                                            if kind is not None:
                                                id_refs.setdefault(kind, []).append(match.start())
                                            else:
                                                sec_val = sec_vas.get(target_va)
                                                if sec_val is not None:
                                                    sec_refs.append((match.start(), sec_val))
                                        for kind, positions in id_refs.items():
                                            best = None
                                            for cp in positions:
                                                for sp, sec_val in sec_refs:
                                                    dist = abs(sp - cp)
                                                    if dist <= 256 and (best is None or dist < best[0]):
                                                        best = (dist, sec_val)
                                            if best is not None:
                                                result[kind] = (
                                                    _AGY_DEFAULT_OAUTH_CLIENT_IDS[kind],
                                                    best[1],
                                                )
                                elif (
                                    (e_machine != 62 or b".text" not in named)
                                    and id_ro_positions
                                    and sec_ro_positions
                                ):
                                    for kind, entries in id_ro_positions.items():
                                        best = None
                                        for id_pos, id_len in entries:
                                            id_end = id_pos + id_len
                                            for sec_pos, sec_val in sec_ro_positions:
                                                gap = sec_pos - id_end
                                                if 0 <= gap <= 64 and (
                                                    best is None or gap < best[0]
                                                ):
                                                    best = (gap, sec_val)
                                        if best is not None:
                                            result[kind] = (
                                                _AGY_DEFAULT_OAUTH_CLIENT_IDS[kind],
                                                best[1],
                                            )
        with _AGY_OAUTH_CACHE_LOCK:
            if len(_AGY_OAUTH_CACHE) >= 8:
                _AGY_OAUTH_CACHE.clear()
            _AGY_OAUTH_CACHE[cache_key] = dict(result)
        return result
    except OSError:
        return {}
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def _resolve_host_oauth_clients(agy_path=None):
    env_cfg = {
        key: os.environ[key].strip()
        for key in OAUTH_CLIENT_ENV_KEYS
        if isinstance(os.environ.get(key), str) and os.environ[key].strip()
    }
    extracted = _extract_agy_oauth_clients(agy_path) if agy_path is not None else {}
    resolved = {}
    for kind, id_key, sec_key in (
        (
            "consumer",
            "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID",
            "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET",
        ),
        (
            "cloud",
            "KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID",
            "KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET",
        ),
        (
            "enterprise",
            "KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_ID",
            "KIN_GEMINI_OAUTH_ENTERPRISE_CLIENT_SECRET",
        ),
    ):
        env_id = env_cfg.get(id_key)
        env_sec = env_cfg.get(sec_key)
        if env_id:
            resolved[id_key] = env_id
            if env_sec:
                resolved[sec_key] = env_sec
        else:
            pair = extracted.get(kind)
            if pair:
                resolved[id_key] = pair[0]
                resolved[sec_key] = env_sec or pair[1]
    if env_cfg.get("KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_ID"):
        resolved["KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_ID"] = env_cfg[
            "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_ID"
        ]
        if env_cfg.get("KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_SECRET"):
            resolved["KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_SECRET"] = env_cfg[
                "KIN_GEMINI_OAUTH_GEMINICLI_CLIENT_SECRET"
            ]
    if env_cfg.get("KIN_GEMINI_OAUTH_WIF_CLIENT_ID"):
        resolved["KIN_GEMINI_OAUTH_WIF_CLIENT_ID"] = env_cfg[
            "KIN_GEMINI_OAUTH_WIF_CLIENT_ID"
        ]
    return resolved


def read_account(
    uid,
    proxy_url,
    method,
    api_key=None,
    profile=None,
    oauth_token=None,
    *,
    timeout=17,
    agy_path=None,
):
    payload = {"proxy_url": proxy_url, "api_key": api_key, "oauth_token": oauth_token}
    if method in ("oauth_refresh_import", "oauth", "oauth-models"):
        oauth_clients = _resolve_host_oauth_clients(agy_path=agy_path)
        if oauth_clients:
            payload["oauth_clients"] = oauth_clients
    try:
        result = subprocess.run(
            account_command(uid, method, profile),
            input=json.dumps(payload).encode(),
            check=True,
            timeout=timeout,
            capture_output=True,
            env=SYSTEM_ENV,
        )
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"state": "error", "checked_at": now()}


def private_json(target, contents):
    staging = target.with_name(f".{target.name}.{secrets.token_hex(8)}")
    try:
        with os.fdopen(
            os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
        ) as output:
            json.dump(contents, output)
            output.flush()
            os.fsync(output.fileno())
        staging.replace(target)
        descriptor = os.open(target.parent, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        staging.unlink(missing_ok=True)


def check_root_owned(target):
    for entry in (target, *target.parents):
        info = entry.lstat()
        if info.st_uid != 0 or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
            raise RuntimeError(
                "Gemini service code, configuration and payload must be root-owned"
            )


def read_root_file(path, limit):
    check_root_owned(path)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(path, flags), "rb") as data:
        info = os.fstat(data.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o022
            or not 0 < info.st_size <= limit
        ):
            raise ValueError("Invalid Gemini file")
        value = data.read(limit + 1)
        if not 0 < len(value) <= limit:
            raise ValueError("Invalid Gemini file size")
        return value


def read_release_verifier(path):
    value = json.loads(read_root_file(path, 1024))
    if (
        not isinstance(value, dict)
        or set(value) != {"manifest_sha256", "code_sha256"}
        or any(
            not isinstance(v, str) or not SHA256.fullmatch(v) for v in value.values()
        )
    ):
        raise ValueError("Invalid Gemini release verifier")
    return value


_DNS_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_ALLOWED_PROXY_SCHEMES = frozenset({"socks5h", "socks5", "http"})


def _is_disallowed_ipv4(address):
    return (
        address.is_loopback
        or address.is_unspecified
        or address.is_multicast
        or address.is_link_local
        or address == ipaddress.IPv4Address("255.255.255.255")
    )


def proxy_config(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise Failure(400)
    try:
        url = urlsplit(value)
        scheme = (url.scheme or "").lower()
        host = url.hostname
        port = url.port
        if port is None and scheme == "http":
            port = 80
        if (
            scheme not in _ALLOWED_PROXY_SCHEMES
            or not host
            or len(host) > 253
            or not port
            or not 1 <= port <= 65535
            or url.path not in ("", "/")
            or url.fragment
            or url.query
        ):
            raise ValueError()
        try:
            ip_obj = ipaddress.ip_address(host)
        except ValueError:
            ip_obj = None
        if ip_obj is not None:
            if not isinstance(ip_obj, ipaddress.IPv4Address) or _is_disallowed_ipv4(
                ip_obj
            ):
                raise ValueError()
            resolved_host = str(ip_obj)
        else:
            lower = host.lower()
            if (
                lower == "localhost"
                or lower.endswith(".localhost")
                or lower.endswith(".localdomain")
                or lower.endswith(".")
                or ".." in lower
            ):
                raise ValueError()
            labels = lower.split(".")
            if labels[-1].isdigit() or not all(
                _DNS_LABEL_RE.fullmatch(label) for label in labels
            ):
                raise ValueError()
            resolved_host = lower
    except (ValueError, TypeError) as error:
        raise Failure(400) from error
    return resolved_host, str(port)


def _is_ipv4_literal(host):
    try:
        ipaddress.IPv4Address(host)
        return True
    except ValueError:
        return False


def _resolve_proxy_ipv4(host, port):
    if _is_ipv4_literal(host):
        return host
    try:
        infos = socket.getaddrinfo(
            host, int(port), family=socket.AF_INET, type=socket.SOCK_STREAM
        )
    except OSError as err:
        raise Failure(503, "gemini_proxy_error", stage="network_prepare") from err
    ips = [sockaddr[0] for *_, sockaddr in infos if sockaddr]
    if not ips:
        raise Failure(503, "gemini_proxy_error", stage="network_prepare")
    for ip_str in ips:
        try:
            addr = ipaddress.IPv4Address(ip_str)
        except ValueError as err:
            raise Failure(503, "gemini_proxy_error", stage="network_prepare") from err
        if _is_disallowed_ipv4(addr):
            raise Failure(503, "gemini_proxy_error", stage="network_prepare")
    return ips[0]


def _ensure_traversable_dir(path):
    """Self-heal env/profile directories created with 0700 under UMask=0077 to 0711."""
    if path is None:
        return
    try:
        info = path.lstat()
    except OSError:
        return
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        return
    if info.st_uid != os.geteuid():
        return
    if (info.st_mode & 0o7777) != 0o711:
        try:
            os.chmod(path, 0o711)
        except OSError:
            pass


def normalize_egress_options(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    if raw.get("domain_forward") is True:
        out["domain_forward"] = True
    raw_empty = raw.get("dns_empty_types")
    if isinstance(raw_empty, list):
        cleaned = sorted({int(t) for t in raw_empty if type(t) is int and 1 <= t <= 65535})
        if cleaned:
            out["dns_empty_types"] = cleaned
    raw_dns = raw.get("dns_upstream")
    if isinstance(raw_dns, str):
        dns = raw_dns.strip()
        if dns and len(dns) <= 1024 and not any(ch in dns for ch in "\r\n\x00"):
            out["dns_upstream"] = dns
    return out


def egress_fingerprint(proxy_url, egress_options=None):
    opts = normalize_egress_options(egress_options)
    if not opts:
        return hashlib.sha256(proxy_url.encode()).digest()
    encoded = json.dumps(
        {"proxy_url": proxy_url, "egress_options": opts},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).digest()


def _session_egress_key(session):
    key = getattr(session, "egress_key", None)
    return key if isinstance(key, (bytes, bytearray)) else session.proxy_hash


def _host_resolv_conf():
    fallback = "nameserver 1.1.1.1\noptions timeout:2 attempts:2\n"
    try:
        with open("/etc/resolv.conf", "rb") as stream:
            raw = stream.read(4096)
        text = raw.decode("utf-8", errors="ignore")
        if any(line.strip().startswith("nameserver ") for line in text.splitlines()):
            return text if text.endswith("\n") else text + "\n"
    except OSError:
        pass
    return fallback


def profile_secrets(profile, uid, *, include_raw=False):
    """Open only beneath a root-owned profile, without traversing symlinks."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = None
    try:
        fd = os.open(profile, flags)
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o022:
            return None
        for part in ("home", ".gemini", "antigravity-cli"):
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != uid or info.st_mode & 0o077:
                return None
        token_fd = os.open(
            TOKEN_NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
        )
        with os.fdopen(token_fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != uid
                or info.st_mode & 0o077
                or info.st_nlink != 1
                or not 0 < info.st_size <= 16384
            ):
                return None
            raw = stream.read(16385)
        value = json.loads(raw) if len(raw) <= 16384 else None
        credential = value.get("token") if isinstance(value, dict) else None
        if not isinstance(credential, dict):
            return None
        access = credential.get("access_token")
        if not isinstance(access, str) or not ACCESS_TOKEN.fullmatch(access):
            return None
        secrets = tuple(
            value
            for value in (
                access,
                credential.get("refresh_token"),
                credential.get("id_token"),
            )
            if isinstance(value, str) and 1 <= len(value) <= 16384 and value.isascii()
        )
        return (secrets, raw) if include_raw else secrets
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        if fd is not None:
            os.close(fd)


EGRESS_EXEC = """\
import ctypes, os, signal, sys
if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != int(sys.argv[1]):
    sys.exit(125)
os.execv(sys.argv[2], sys.argv[2:])
"""

# The helper binds all three listeners before accepting traffic. A passive check
# inside the bound netns does not create a connection on its transparent port.
RELAY_EXEC = """\
import asyncio, ctypes, ipaddress, os, signal, socket, sys

if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != int(sys.argv[1]):
    sys.exit(125)

LISTEN_HOST = sys.argv[2]
LISTEN_PORT = int(sys.argv[3])
ALLOWED_PEER = sys.argv[4]
TARGET_HOST = sys.argv[5]
TARGET_PORT = int(sys.argv[6])
MAX_CONNS = 256
active = 0


def _allowed_ipv4(ip_text):
    try:
        addr = ipaddress.IPv4Address(ip_text)
    except ValueError:
        return False
    return not (
        addr.is_loopback
        or addr.is_unspecified
        or addr.is_multicast
        or addr.is_link_local
        or addr == ipaddress.IPv4Address("255.255.255.255")
    )


async def resolve_target_ip():
    try:
        addr = ipaddress.IPv4Address(TARGET_HOST)
        if not _allowed_ipv4(str(addr)):
            raise OSError("disallowed relay target IP")
        return str(addr)
    except ValueError:
        pass
    loop = asyncio.get_running_loop()
    infos = await asyncio.wait_for(
        loop.getaddrinfo(TARGET_HOST, TARGET_PORT, family=socket.AF_INET, type=socket.SOCK_STREAM),
        timeout=5.0,
    )
    ips = [sockaddr[0] for _, _, _, _, sockaddr in infos if sockaddr]
    if not ips or not all(_allowed_ipv4(ip) for ip in ips):
        raise OSError("disallowed relay target IP")
    return ips[0]


async def pipe(src, dst):
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
            dst.write(data)
            await dst.drain()
    except (OSError, asyncio.CancelledError):
        pass
    finally:
        try:
            if dst.can_write_eof():
                dst.write_eof()
        except OSError:
            pass


async def handle(client_reader, client_writer):
    global active
    peer = client_writer.get_extra_info("peername")
    if not peer or peer[0] != ALLOWED_PEER or active >= MAX_CONNS:
        client_writer.close()
        return
    active += 1
    up_writer = None
    try:
        target_ip = await resolve_target_ip()
        up_reader, up_writer = await asyncio.wait_for(
            asyncio.open_connection(target_ip, TARGET_PORT), timeout=15.0
        )
        t1 = asyncio.create_task(pipe(client_reader, up_writer))
        t2 = asyncio.create_task(pipe(up_reader, client_writer))
        await asyncio.gather(t1, t2)
    except (OSError, asyncio.TimeoutError, asyncio.CancelledError):
        pass
    finally:
        active -= 1
        for writer in (up_writer, client_writer):
            if writer is not None:
                try:
                    writer.close()
                except OSError:
                    pass


async def main():
    server = await asyncio.start_server(
        handle,
        host=LISTEN_HOST,
        port=LISTEN_PORT,
        family=socket.AF_INET,
        reuse_address=True,
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, OSError):
            pass
    async with server:
        await stop.wait()


asyncio.run(main())
"""


def slot_network_addrs(slot):
    base = 4 * int(slot)
    return f"198.18.252.{base + 1}", f"198.18.252.{base + 2}"


def pick_free_relay_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("0.0.0.0", 0))
        return probe.getsockname()[1]


def rewrite_proxy_endpoint(proxy_url, host, port):
    parsed = urlsplit(proxy_url)
    userinfo, sep, _ = parsed.netloc.rpartition("@")
    netloc = f"{userinfo}@{host}:{port}" if sep else f"{host}:{port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


def host_tcp_listening(ip, port, uid):
    try:
        addr_hex = "%08X:%04X" % (struct.unpack("=I", socket.inet_aton(ip))[0], int(port))
        uid_str = str(uid)
        with open("/proc/net/tcp", encoding="ascii") as table:
            next(table, None)
            for line in table:
                row = line.split()
                if len(row) > 7 and row[1] == addr_hex and row[3] == "0A" and row[7] == uid_str:
                    return True
    except OSError:
        return False
    return False


EGRESS_READY = """\
import sys
for proto, port, state in [('tcp', 1080, '0A'), ('tcp', 1053, '0A'), ('udp', 1053, '07')]:
    with open('/proc/net/' + proto) as table:
        rows = (line.split() for line in list(table)[1:])
        if not any(row[1] == '0100007F:%04X' % port and row[3] == state
                   and row[7] == sys.argv[1] for row in rows):
            sys.exit(1)
"""

TERMINAL_EXEC = """\
import os, sys
os.write(1, b'\\x02agy-start\\x03')
os.execv(sys.argv[1], sys.argv[1:])
"""

VT_EXEC = """import os,sys
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.write(fd,str(os.getpid()).encode('ascii'))
os.close(fd)
os.execvpe(sys.argv[2],sys.argv[2:],os.environ)
"""


class _Spawner:
    """Single long-lived thread that forks managed child processes so Linux
    PR_SET_PDEATHSIG fires only when gemini-host exits, never when an HTTP
    worker thread from ThreadingUnixStreamServer terminates."""

    def __init__(self):
        self._queue = queue.Queue()
        self._thread = threading.Thread(
            target=self._loop, name="gemini-spawner", daemon=True
        )
        self._thread.start()

    def _loop(self):
        while True:
            fn, result_q = self._queue.get()
            try:
                result_q.put((True, fn()))
            except BaseException as exc:
                result_q.put((False, exc))

    def call(self, fn):
        if threading.current_thread() is self._thread:
            return fn()
        result_q = queue.Queue(maxsize=1)
        self._queue.put((fn, result_q))
        ok, value = result_q.get()
        if ok:
            return value
        raise value


class Agy:
    def __init__(
        self, host, environment, proxy_url, profile=None, size=(180, 40), *, egress_options=None
    ):
        self.host = host
        self.environment = environment
        self.slot = environment["slot"] % MAX_NETNS_SLOTS
        self.uid = host.uid_base + self.slot
        self.attempt = secrets.token_hex(16)
        dirname = self.attempt if profile is None else "terminal-" + self.attempt
        self.directory = host.directory / environment["id"] / dirname
        self.profile = profile
        self.owns_directory = False
        self.pid = None
        self._exit_status = None
        self.terminal = None
        self.egress = None
        self.egress_relay = None
        self.network_lock = None
        self._network_lease = None
        address, port = proxy_config(proxy_url)
        self.network = [str(self.slot), str(host.egress_uid), address, port]
        self.namespace = f"vm2agy{self.slot}"
        self.proxy_hash = hashlib.sha256(proxy_url.encode()).digest()
        self.egress_options = normalize_egress_options(egress_options)
        self.egress_key = egress_fingerprint(proxy_url, self.egress_options)
        self.proxy_url = proxy_url
        try:
            self.start(proxy_url, size)
        except BaseException:
            self.close()
            raise

    def start(self, proxy_url, size):
        self.directory.mkdir(mode=0o711)
        self.owns_directory = True
        self.directory.chmod(0o711)
        self.directory.parent.chmod(0o711)
        if self.profile is not None:
            _ensure_traversable_dir(self.profile)
        home = (self.profile or self.directory) / "home"
        work = self.directory / "work"
        work.mkdir(mode=0o700)
        os.chown(work, self.uid, self.uid)
        if self.profile is None:
            self.initialize_home(home)
        hostname = env_hostname(self.environment)
        files = {
            "resolv.conf": "nameserver 1.1.1.1\noptions timeout:2 attempts:2\n",
            "passwd": f"agy:x:{self.uid}:{self.uid}:Antigravity:/home/agy:/bin/sh\n",
            "group": f"agy:x:{self.uid}:\n",
            "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files dns\n",
            "hosts": f"127.0.0.1 localhost {hostname}\n::1 localhost\n",
        }
        identity = []
        for name, contents in files.items():
            target = self.directory / name
            target.write_text(contents, encoding="ascii")
            target.chmod(0o644)
            identity += ["--ro-bind", str(target), "/etc/" + name]
        machine_id = self.host.ensure_env_machine_id(self.environment)
        identity += ["--ro-bind", str(machine_id), "/etc/machine-id"]
        if hasattr(self.host, "acquire_slot_network"):
            lease = self.host.acquire_slot_network(
                self.slot,
                self.directory.parent,
                self.network,
                self.environment["proxy_id"],
                proxy_url,
                self.proxy_hash,
                self.launch_args,
                **({"egress_options": self.egress_options} if self.egress_options else {}),
            )
            self._network_lease = lease
            self.network_lock = lease["lock"]
            self.egress = lease["egress"]
            self.egress_relay = lease.get("relay")
        else:
            effective_proxy_url = proxy_url
            target_host, target_port = self.network[2], self.network[3]
            if not _is_ipv4_literal(target_host):
                if hasattr(self.host, "_start_egress_relay"):
                    gateway, guest = slot_network_addrs(self.slot)
                    relay_port = pick_free_relay_port()
                    self.network = [
                        str(self.slot),
                        str(self.host.egress_uid),
                        gateway,
                        str(relay_port),
                    ]
                    effective_proxy_url = rewrite_proxy_endpoint(
                        proxy_url, gateway, relay_port
                    )
                    config = self.directory / "egress.json"
                    private_json(
                        config,
                        {
                            "proxy_id": self.environment["proxy_id"],
                            "proxy_url": effective_proxy_url,
                            "listen_tcp": "127.0.0.1:1080",
                            "listen_dns": "127.0.0.1:1053",
                            **self.egress_options,
                        },
                    )
                    os.chown(config, self.host.egress_uid, self.host.egress_uid)
                    try:
                        self.network_lock = self.host.start_network(
                            self.directory, self.network
                        )
                    except (Failure, OSError, subprocess.SubprocessError) as err:
                        raise Failure(
                            503, getattr(err, "code", None), stage="network_prepare"
                        ) from err
                    try:
                        self.egress_relay = self.host._start_egress_relay(
                            gateway, guest, relay_port, target_host, target_port
                        )
                    except (Failure, OSError, subprocess.SubprocessError) as err:
                        raise Failure(
                            503, getattr(err, "code", None), stage="relay_start"
                        ) from err
                else:
                    resolved_ip = _resolve_proxy_ipv4(target_host, target_port)
                    self.network[2] = resolved_ip
                    effective_proxy_url = rewrite_proxy_endpoint(
                        proxy_url, resolved_ip, target_port
                    )
                    config = self.directory / "egress.json"
                    private_json(
                        config,
                        {
                            "proxy_id": self.environment["proxy_id"],
                            "proxy_url": effective_proxy_url,
                            "listen_tcp": "127.0.0.1:1080",
                            "listen_dns": "127.0.0.1:1053",
                            **self.egress_options,
                        },
                    )
                    os.chown(config, self.host.egress_uid, self.host.egress_uid)
                    try:
                        self.network_lock = self.host.start_network(
                            self.directory, self.network
                        )
                    except (Failure, OSError, subprocess.SubprocessError) as err:
                        raise Failure(
                            503, getattr(err, "code", None), stage="network_prepare"
                        ) from err
            else:
                config = self.directory / "egress.json"
                private_json(
                    config,
                    {
                        "proxy_id": self.environment["proxy_id"],
                        "proxy_url": effective_proxy_url,
                        "listen_tcp": "127.0.0.1:1080",
                        "listen_dns": "127.0.0.1:1053",
                        **self.egress_options,
                    },
                )
                os.chown(config, self.host.egress_uid, self.host.egress_uid)
                try:
                    self.network_lock = self.host.start_network(
                        self.directory, self.network
                    )
                except (Failure, OSError, subprocess.SubprocessError) as err:
                    raise Failure(
                        503, getattr(err, "code", None), stage="network_prepare"
                    ) from err
            try:
                subprocess.run(
                    self.launch_args(self.host.egress_uid)
                    + [
                        sys.executable,
                        "-I",
                        "-c",
                        "import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 2).close()",
                        *self.network[2:],
                    ],
                    check=True,
                    timeout=3,
                    env=SYSTEM_ENV,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except (Failure, OSError, subprocess.SubprocessError) as err:
                raise Failure(503, getattr(err, "code", None), stage="proxy_probe") from err
            try:
                spawn = getattr(self.host, "spawn", lambda fn: fn())
                self.egress = spawn(
                    lambda: subprocess.Popen(
                        self.launch_args(self.host.egress_uid)
                        + [
                            sys.executable,
                            "-I",
                            "-c",
                            EGRESS_EXEC,
                            str(os.getpid()),
                            str(self.host.egress),
                            "--config",
                            str(config),
                        ],
                        env=SYSTEM_ENV,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                )
                self.wait_egress()
            except (Failure, OSError, subprocess.SubprocessError) as err:
                raise Failure(503, getattr(err, "code", None), stage="egress_start") from err
        sandbox = [
            resolve_bwrap_argv0(host_root=active_host_root()),
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--hostname",
            hostname,
            "--die-with-parent",
            "--clearenv",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind-try",
            "/lib",
            "/lib",
            "--ro-bind-try",
            "/lib64",
            "/lib64",
            "--ro-bind-try",
            "/bin",
            "/bin",
            "--ro-bind-try",
            "/etc/ssl/certs",
            "/etc/ssl/certs",
            *identity,
            "--ro-bind",
            str(self.host.payload / "agy"),
            "/opt/agy",
            "--bind",
            str(home),
            "/home/agy",
            "--bind",
            str(work),
            "/work",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--chdir",
            "/work",
            "--setenv",
            "HOME",
            "/home/agy",
            "--setenv",
            "USER",
            "agy",
            "--setenv",
            "LOGNAME",
            "agy",
            "--setenv",
            "SHELL",
            "/bin/sh",
            "--setenv",
            "XDG_CONFIG_HOME",
            "/home/agy/.config",
            "--setenv",
            "XDG_CACHE_HOME",
            "/home/agy/.cache",
            "--setenv",
            "PWD",
            "/work",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "TERM",
            "xterm-256color",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "AGY_CLI_DISABLE_AUTO_UPDATE",
            "true",
        ]
        try:
            self.launch_cli(self.launch_args(self.uid) + sandbox, size)
        except Failure as err:
            if err.stage is None:
                raise Failure(err.status, err.code, stage="cli_launch") from err
            raise
        except (OSError, subprocess.SubprocessError) as err:
            raise Failure(503, stage="cli_launch") from err

    def initialize_home(self, home):
        settings = home / ".gemini" / "antigravity-cli"
        for private in (home, home / ".gemini", settings):
            private.mkdir(mode=0o700)
            os.chown(private, self.uid, self.uid)
        private_json(settings / "settings.json", CLI_SETTINGS)
        os.chown(settings / "settings.json", self.uid, self.uid)

    def launch_cli(self, argv, size):
        argv += [
            "--setenv",
            "SSH_TTY",
            "/dev/tty",
            "--setenv",
            "SSH_CONNECTION",
            "127.0.0.1 12345 127.0.0.1 22",
            "--",
        ]
        if self.profile is not None:
            argv += ["/usr/bin/python3", "-I", "-c", TERMINAL_EXEC]
        argv += ["/opt/agy", "--mode", "plan"]
        def _fork_pty():
            pid, terminal = pty.fork()
            if pid == 0:
                try:
                    os.umask(0o077)
                    fcntl.ioctl(
                        0, termios.TIOCSWINSZ, struct.pack("HHHH", size[1], size[0], 0, 0)
                    )
                    if self.profile is not None:
                        with open(os.devnull, "wb") as quiet:
                            os.dup2(quiet.fileno(), 2)
                    os.execvpe(argv[0], argv, SYSTEM_ENV)
                finally:
                    os._exit(125)
            return pid, terminal

        spawn = getattr(self.host, "spawn", lambda fn: fn())
        self.pid, self.terminal = spawn(_fork_pty)
        os.set_blocking(self.terminal, False)

    def wait_egress(self):
        deadline = time.monotonic() + 3
        probe = self.launch_args(self.host.egress_uid) + [
            sys.executable,
            "-I",
            "-c",
            EGRESS_READY,
            str(self.host.egress_uid),
        ]
        while self.egress.poll() is None and time.monotonic() < deadline:
            result = subprocess.run(
                probe,
                timeout=1,
                env=SYSTEM_ENV,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if result.returncode == 0 and self.egress.poll() is None:
                return
            time.sleep(0.05)
        raise Failure(503)

    def launch_args(self, uid):
        return [
            "ip",
            "netns",
            "exec",
            self.namespace,
            "setpriv",
            "--reuid",
            str(uid),
            "--regid",
            str(uid),
            "--clear-groups",
            "--no-new-privs",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--bounding-set=-all",
        ]

    def alive(self):
        relay = getattr(self, "egress_relay", None)
        relay_ok = relay is None or relay.poll() is None
        return bool(self.pid and self.egress.poll() is None and relay_ok and not self.exited())

    def poll_exit_status(self):
        cached = getattr(self, "_exit_status", None)
        if cached is not None:
            return cached
        if not self.pid:
            return None
        try:
            info = os.waitid(
                os.P_PID, self.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT
            )
        except ChildProcessError:
            return None
        if info is None:
            return None
        if info.si_code == os.CLD_EXITED:
            status = {"exit_code": int(info.si_status)}
        elif info.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
            status = {"signal": int(info.si_status)}
        else:
            status = {"status": int(info.si_status)}
        self._exit_status = status
        return status

    def exited(self):
        # WNOWAIT leaves the PID reserved until close() has signalled its group.
        return self.poll_exit_status() is not None

    def close(self, preserve=False):
        if self.pid:
            # Capture real child exit code/signal before sending SIGTERM/SIGKILL.
            self.poll_exit_status()
            if preserve and not self.exited():
                for sig_fn in (
                    lambda: os.killpg(self.pid, signal.SIGTERM),
                    lambda: os.kill(self.pid, signal.SIGTERM),
                ):
                    try:
                        sig_fn()
                    except ProcessLookupError:
                        pass
                grace_deadline = time.monotonic() + 1.5
                while time.monotonic() < grace_deadline and not self.exited():
                    time.sleep(0.05)
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # forkpty's child may not have become group leader yet.
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
            self.pid = None
        if self.terminal is not None:
            os.close(self.terminal)
            self.terminal = None
        lease = getattr(self, "_network_lease", None)
        if lease is not None:
            self._network_lease = None
            self.egress = None
            self.egress_relay = None
            self.network_lock = None
            self.host.release_slot_network(self.slot, lease)
        else:
            if self.egress is not None:
                if self.egress.poll() is None:
                    self.egress.kill()
                self.egress.wait(timeout=5)
                self.egress = None
            relay = getattr(self, "egress_relay", None)
            if relay is not None:
                if relay.poll() is None:
                    relay.kill()
                relay.wait(timeout=5)
                self.egress_relay = None
            if self.network_lock is not None:
                try:
                    self.host.stop_network(self.directory, self.network, self.network_lock)
                finally:
                    os.close(self.network_lock)
                    self.network_lock = None
        if self.owns_directory:
            if preserve:
                for name in (
                    "egress.json",
                    "resolv.conf",
                    "passwd",
                    "group",
                    "nsswitch.conf",
                    "hosts",
                ):
                    (self.directory / name).unlink(missing_ok=True)
                shutil.rmtree(self.directory / "work")
            else:
                shutil.rmtree(self.directory)
            self.owns_directory = False


class Headless(Agy):
    def __init__(self, host, environment, proxy_url, auth, args, prompt, *, egress_options=None):
        self.invocation = None
        self.credentials, self.token_bytes = auth
        self.args, self.prompt = args, prompt
        super().__init__(host, environment, proxy_url, egress_options=egress_options)

    def _copy_profile_file(self, src, dst, mode=0o600):
        try:
            fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_uid != self.uid
                    or not 0 < info.st_size <= 4096
                ):
                    return
                raw = stream.read(4097)
            if not 0 < len(raw) <= 4096:
                return
            dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chown(dst.parent, self.uid, self.uid)
            dst.write_bytes(raw)
            os.chmod(dst, mode)
            os.chown(dst, self.uid, self.uid)
        except OSError:
            pass

    def initialize_home(self, home):
        super().initialize_home(home)
        settings = home / ".gemini" / "antigravity-cli"
        private_json(
            settings / "settings.json",
            {
                **CLI_SETTINGS,
                "permissions": {
                    "deny": [
                        "read_file(*)",
                        "write_file(*)",
                        "command(*)",
                        "mcp(*)",
                        "read_url(*)",
                        "execute_url(*)",
                    ]
                },
            },
        )
        os.chown(settings / "settings.json", self.uid, self.uid)
        # Preserve the authorized profile's device installation_id & cached project
        # so Google sees the exact same client device rather than a fresh blank install.
        profile_name = self.environment.get("profile")
        if isinstance(profile_name, str) and profile_name:
            src_cli = (
                self.host.directory
                / self.environment["id"]
                / profile_name
                / "home"
                / ".gemini"
                / "antigravity-cli"
            )
            self._copy_profile_file(
                src_cli / "installation_id", settings / "installation_id"
            )
            self._copy_profile_file(
                src_cli / "cache" / "default_project_id.txt",
                settings / "cache" / "default_project_id.txt",
            )
            self._copy_profile_file(
                src_cli / "cache" / "onboarding.json",
                settings / "cache" / "onboarding.json",
            )
        token = settings / TOKEN_NAME
        token.write_bytes(self.token_bytes)
        os.chown(token, self.uid, self.uid)
        self.token_bytes = None

    def launch_cli(self, argv, size):
        spawn = getattr(self.host, "spawn", lambda fn: fn())
        self.invocation = spawn(
            lambda: invocation_module().Invocation(
                argv + ["--", "/opt/agy", *self.args],
                SYSTEM_ENV,
                self.prompt,
                secrets=self.credentials,
            )
        )

    def poll(self):
        if self.egress.poll() is not None:
            return {
                "state": "failed",
                "text": "",
                "error": {
                    "code": "gemini_proxy_error",
                    "message": "Gemini egress stopped",
                },
            }
        return self.invocation.poll()

    def close(self, preserve=False):
        try:
            if self.invocation is not None:
                self.invocation.close()
        finally:
            super().close(preserve)


def native_process_identity(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    tty = int(fields[4])
    start = int(fields[19])
    pgid = int(fields[2])
    if tty == 0 or ((tty >> 8) & 0xFFF) in (2, 3, *range(128, 144)):
        raise Failure(503, "gemini_native_tty_unavailable")
    return pgid, start


def read_native_tui_pid(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o077
            or not 1 <= info.st_size <= 16
        ):
            raise Failure(503, "gemini_native_tty_unavailable")
        raw = os.read(descriptor, 17)
        if len(raw) != info.st_size or not raw.isdigit():
            raise Failure(503, "gemini_native_tty_unavailable")
        return int(raw)
    finally:
        os.close(descriptor)


class NativeAgy(Agy):
    def __init__(self, host, environment, proxy_url, auth, model, prompt, *, egress_options=None):
        self.credentials, _ = auth
        self.model, self.prompt = model, prompt
        self.max_concurrency = env_concurrency(environment)
        # Unify ALL resident NativeSessions (max_concurrency >= 1) onto managed CRAGGemini pool mode:
        # eliminates openvt VT exhaustion, decouples craggemini from single agy crashes, and enables
        # resident min_warm_slots + live /model switching.
        self.pool_mode = prompt is None
        self.native_dir = None
        self._owns_native_dir = False
        self.native_token = None
        self.native_tui = None
        self.native_tui_pid = None
        self.native_tui_pgid = None
        self.native_tui_start = None
        self.native_invocation = None
        self.native_diagnostic = None
        # CLI onboarding and project state belong to the authorized profile, not the token alone.
        profile = host.directory / environment["id"] / environment["profile"]
        super().__init__(host, environment, proxy_url, profile=profile, egress_options=egress_options)

    def launch_cli(self, argv, size):
        short_name = f"s{getattr(self, 'slot', 0)}-{self.attempt[:12]}"
        self.native_dir, self._owns_native_dir = self.host._allocate_native_dir(
            self.uid, self.directory / "native", short_name
        )
        self.native_token = secrets.token_hex(32)
        license_dir = self.host.ensure_env_license_dir(self.environment)
        native_module_impl = native_module()
        agy_args = [
            "--dangerously-skip-permissions",
            "--add-dir",
            "/work",
            "--model",
            self.model,
            "--settings",
            json.dumps(NATIVE_CLI_SETTINGS, separators=(",", ":")),
            "--log-file",
            "/tmp/craggemini/" + native_module_impl.ELIGIBILITY_LOG_FILE,
        ]
        pol = normalize_runtime_policy(getattr(self.host, "runtime_policy", None))
        kernel_cfg = {
            "run_dir": "/tmp/craggemini",
            "internal_token": self.native_token,
            "session_id": self.attempt,
            "model": self.model,
            "agy_sha256": self.host.installed_agy_sha256(),
            "timeout_ms": pol["timeout_ms"],
            "first_byte_timeout_ms": pol["first_byte_timeout_ms"],
            "idle_timeout_ms": pol["idle_timeout_ms"],
            "queue_timeout_ms": pol["queue_timeout_ms"],
            "max_queue": max(pol["max_queue"], self.max_concurrency * 2)
            if self.pool_mode
            else 1,
            "shm_request_bytes": pol["shm_request_mb"] * 1024 * 1024,
            "shm_response_bytes": pol["shm_response_mb"] * 1024 * 1024,
            "strategy": pol["strategy"],
            "max_accounts": 1,
            "sticky_enabled": pol["sticky_enabled"],
            "sticky_ttl_secs": pol["sticky_ttl_secs"],
            "require_shm": pol["require_shm"],
            "circuit_failure_threshold": pol["circuit_failure_threshold"],
            "circuit_open_ms": pol["circuit_open_ms"],
            "vm_id": self.environment["id"],
            "license_dir": "/run/kin/crag-license",
            "host_license_dir": "/run/kin/crag-host",
        }
        if self.pool_mode:
            # Inside vm2agy<slot>, kin-egress enforces kernel-level fail-closed SOCKS5 routing
            # under a separate UID; pass only the proxy_sha256 digest (never raw credentials).
            kernel_cfg.update(
                {
                    "agy_bin": "/opt/agy",
                    "bridge_so": "/opt/libagy_bridge.so",
                    "verify_agy_sha256": True,
                    "require_proxy_calibration": False,
                    "accounts": [
                        {
                            "account_id": self.environment["id"],
                            "env_id": self.environment["id"],
                            "agy_home": "/home/agy",
                            "work_dir": "/work",
                            "run_dir": "/tmp/craggemini/acc",
                            "proxy_id": self.environment["proxy_id"],
                            "proxy_sha256": hashlib.sha256(
                                self.proxy_url.encode()
                            ).hexdigest(),
                            "netns_transparent_egress": True,
                            "max_concurrency": self.max_concurrency,
                            "min_warm_slots": min(
                                self.max_concurrency, pol["min_warm_slots"]
                            ),
                            "session_idle_ttl_secs": pol["session_idle_ttl_secs"],
                            "model": self.model,
                            "agy_args": agy_args,
                            "oauth_proxy_required": True,
                            "enabled": True,
                        }
                    ],
                }
            )
        config = self.native_dir / "kernel.json"
        strip_unsupported_kernel_policy(
            kernel_cfg, getattr(self.host, "payload_version", None)
        )
        private_json(config, kernel_cfg)
        os.chown(config, self.uid, self.uid)
        self.native_diagnostic = native_module_impl.EligibilityDiagnostic(
            self.native_dir, self.uid
        )

        crag_mounts = [
            "--dir",
            "/run",
            "--dir",
            "/run/kin",
            "--dir",
            "/run/kin/crag-license",
            "--bind",
            str(license_dir),
            "/run/kin/crag-license",
        ]
        if self.host.crag_host_dir is not None and self.host.crag_host_dir.is_dir():
            crag_mounts.extend(
                [
                    "--dir",
                    "/run/kin/crag-host",
                    "--ro-bind",
                    str(self.host.crag_host_dir),
                    "/run/kin/crag-host",
                ]
            )
        if self.host.payload_mode == "crag_subscription":
            crag_mounts.extend(
                [
                    "--ro-bind",
                    str(self.host.payload / "craggemini.payload.enc"),
                    "/opt/craggemini.payload.enc",
                    "--ro-bind",
                    str(self.host.payload / "manifest.json"),
                    "/opt/manifest.json",
                    "--ro-bind",
                    str(self.host.payload / "crag-license-public.pem"),
                    "/opt/crag-license-public.pem",
                ]
            )

        argv.extend(
            [
                *crag_mounts,
                "--ro-bind",
                str(self.host.payload / "craggemini"),
                "/opt/craggemini",
                "--ro-bind",
                str(self.host.payload / "libagy_bridge.so"),
                "/opt/libagy_bridge.so",
                "--dir",
                "/tmp/craggemini",
                "--bind",
                str(self.native_dir),
                "/tmp/craggemini",
                "--setenv",
                "SSH_CONNECTION",
                "127.0.0.1 12345 127.0.0.1 22",
                "--setenv",
                "CRAGGEMINI_SESSION_ID",
                self.attempt,
                "--ro-bind",
                str(NATIVE_MODULE),
                "/opt/gemini_host_native.py",
                "--",
                "/usr/bin/python3",
                "-I",
                "/opt/gemini_host_native.py",
                "--launch-native",
                "/opt/agy",
                *agy_args,
            ]
        )
        self.native_exit_reader = native_module_impl.read_launcher_exit_detail
        spawn = getattr(self.host, "spawn", lambda fn: fn())
        if self.pool_mode:
            # Multi-process CRAGGemini pool allocates per-slot PTYs and pidfd execution guards
            # inside the sandbox, so no host Linux virtual console is needed.
            try:
                self.native_tui = spawn(
                    lambda: subprocess.Popen(
                        argv,
                        env=SYSTEM_ENV,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                )
            except OSError:
                raise Failure(503, "gemini_native_worker_unavailable") from None
            self.pid = self.native_tui.pid
            return
        try:
            lock, vt = native_module_impl.query_free_vt(
                self.host.directory / "native-vt.lock"
            )
        except (native_module_impl.NativeFailure, OSError) as error:
            code = getattr(error, "code", "gemini_native_tty_unavailable")
            raise Failure(503, code) from None
        try:
            self.native_tui = spawn(
                lambda: subprocess.Popen(
                    [
                        "openvt",
                        "-c",
                        str(vt),
                        "-w",
                        "--",
                        sys.executable,
                        "-I",
                        "-c",
                        VT_EXEC,
                        str(self.directory / "tui.pid"),
                        *argv,
                    ],
                    env=SYSTEM_ENV,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            )
            pid_path = self.directory / "tui.pid"
            pid_deadline = time.monotonic() + 5
            while not pid_path.exists() and self.native_tui.poll() is None:
                if time.monotonic() >= pid_deadline:
                    raise Failure(503, "gemini_native_tty_unavailable")
                time.sleep(0.02)
            if self.native_tui.poll() is not None or not pid_path.exists():
                raise Failure(503, "gemini_native_tty_unavailable")
            self.native_tui_pid = read_native_tui_pid(pid_path)
            self.native_tui_pgid, self.native_tui_start = native_process_identity(
                self.native_tui_pid
            )
        except OSError:
            raise Failure(503, "gemini_native_tty_unavailable") from None
        finally:
            os.close(lock)
        self.pid = self.native_tui_pid
        if self.prompt is not None:
            try:
                self.native_invocation = native_module_impl.NativeInvocation(
                    {
                        "socket": str(self.native_dir / "kernel.sock"),
                        "token": self.native_token,
                        "model": self.model,
                        "request_id": self.attempt,
                        "prompt": self.prompt,
                        "startup_timeout": 45,
                        "launcher_uid": self.uid,
                    },
                    secrets=self.credentials,
                )
            except native_module_impl.NativeFailure as error:
                raise Failure(503, error.code) from None
            self.prompt = None
            self.credentials = ()

    def poll(self):
        if self.egress.poll() is not None:
            return {
                "state": "failed",
                "text": "",
                "error": {
                    "code": "gemini_proxy_error",
                    "message": "Gemini egress stopped",
                },
            }
        result = self.native_invocation.poll()
        if result["state"] == "completed":
            if hasattr(self.native_diagnostic, "clear_advisory"):
                self.native_diagnostic.clear_advisory()
            return result
        wrapper_exited = self.native_tui is None or self.native_tui.poll() is not None
        terminal = wrapper_exited or result["state"] != "running"
        diagnostic = session_diagnostic(
            self, final=terminal, include_advisory=terminal
        )
        if diagnostic is not None:
            return {
                "state": "failed",
                "text": "",
                "error": {"code": diagnostic},
            }
        if result["state"] != "running":
            return result
        if wrapper_exited:
            return {
                "state": "failed",
                "text": "",
                "error": {"code": self.early_exit_code()},
            }
        return result

    def read_exit_detail(self):
        if self.native_dir is None:
            return None
        reader = getattr(self, "native_exit_reader", None)
        if reader is None:
            reader = native_module().read_launcher_exit_detail
        outcome = reader(self.native_dir, self.uid)
        if outcome is None:
            return None
        return (
            (outcome[0], outcome[1], outcome[2])
            if len(outcome) >= 3
            else (outcome[0], outcome[1], None)
        )

    def early_exit_code(self):
        outcome = self.read_exit_detail()
        if outcome is None:
            return "gemini_native_worker_unavailable"
        reason = outcome[2] if len(outcome) >= 3 else None
        if reason == "invalid_config":
            return "gemini_native_config_invalid"
        if reason is None:
            return "gemini_native_worker_unavailable"
        try:
            return native_module().launcher_exit_code(outcome)
        except Failure:
            return "gemini_native_worker_unavailable"

    def close(self, preserve=False):
        wrapper_status = self.native_tui.poll() if self.native_tui is not None else None
        try:
            if self.native_invocation is not None:
                self.native_invocation.close()
        finally:
            try:
                if self.native_tui_pid and self.native_tui_start is not None:
                    try:
                        current = native_process_identity(self.native_tui_pid)
                        if current == (self.native_tui_pgid, self.native_tui_start):
                            os.killpg(self.native_tui_pgid, signal.SIGKILL)
                    except (OSError, ValueError, Failure):
                        pass
                if self.native_tui is not None:
                    self._stop_process_group(self.native_tui)
                    self.native_tui = None
                    outcome = self.read_exit_detail()
                    if outcome is not None:
                        child, status, reason = outcome
                        kind = "exit_code" if status >= 0 else "signal"
                        reason_text = f" reason={reason}" if reason else ""
                        print(
                            f"Gemini native child={child} {kind}={abs(status)}{reason_text}",
                            file=sys.stderr,
                        )
                    elif wrapper_status is not None:
                        kind = "exit_code" if wrapper_status >= 0 else "signal"
                        wrapper_kind = (
                            "pool" if getattr(self, "pool_mode", False) else "openvt"
                        )
                        print(
                            f"Gemini native wrapper={wrapper_kind} {kind}={abs(wrapper_status)} child_record=missing",
                            file=sys.stderr,
                        )
                    else:
                        wrapper_kind = (
                            "pool" if getattr(self, "pool_mode", False) else "openvt"
                        )
                        print(
                            f"Gemini native wrapper={wrapper_kind} status=running_before_cleanup child_record=missing",
                            file=sys.stderr,
                        )
            finally:
                self.pid = None
                self.native_tui_pid = None
                self.credentials = ()
                self.prompt = None
                try:
                    if self.native_diagnostic is not None:
                        self.native_diagnostic.close()
                finally:
                    try:
                        if (
                            getattr(self, "_owns_native_dir", False)
                            and self.native_dir is not None
                        ):
                            shutil.rmtree(self.native_dir, ignore_errors=True)
                            self._owns_native_dir = False
                    finally:
                        super().close(preserve)

    @staticmethod
    def _stop_process_group(process):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


class NativeSession(NativeAgy):
    """Resident, reusable CRAGGemini native-worker session (unified pool mode)."""

    def __init__(self, host, environment, proxy_url, auth, model, *, egress_options=None):
        super().__init__(host, environment, proxy_url, auth, model, None, egress_options=egress_options)
        self.last_used = time.monotonic()
        self._health_failures = 0
        self._ever_ready = False
        self._last_health = None
        self._last_health_at = 0.0

    @property
    def socket_path(self):
        return str(self.native_dir / "kernel.sock")

    def is_alive(self):
        egress_relay = getattr(self, "egress_relay", None)
        return (
            self.egress is not None
            and self.egress.poll() is None
            and (egress_relay is None or egress_relay.poll() is None)
            and self.native_tui is not None
            and self.native_tui.poll() is None
        )

    def health(self, timeout=0.5):
        if not self.is_alive():
            self._last_health = None
            self._health_failures = NATIVE_HEALTH_FAIL_THRESHOLD
            return None
        status = native_module().worker_status(
            self.socket_path, self.native_token, timeout=timeout
        )
        self._last_health = status
        self._last_health_at = time.monotonic()
        if (
            isinstance(status, dict)
            and status.get("ready") is True
            and status.get("needs_recovery") is not True
        ):
            self._health_failures = 0
            self._ever_ready = True
        else:
            self._health_failures += 1
        return status

    def is_ready(self, *, timeout=0.5):
        if session_diagnostic(self) is not None:
            return False
        status = self.health(timeout=timeout)
        return bool(
            status
            and status.get("ready") is True
            and status.get("needs_recovery") is not True
            and session_diagnostic(self) is None
        )

    def is_severely_unhealthy(self):
        if not self.is_alive() or session_diagnostic(self) is not None:
            return True
        if isinstance(self._last_health, dict):
            if self._last_health.get("needs_recovery") is True:
                return True
            if self._last_health.get("ok") is False:
                return True
        return self._health_failures >= NATIVE_HEALTH_FAIL_THRESHOLD

    def open_stream(
        self,
        request_id,
        body_obj,
        *,
        model=None,
        gateway_policy=None,
        restart_resume=False,
    ):
        native_mod = native_module()
        if not self.is_alive():
            raise native_mod.launcher_exit_failure(self.read_exit_detail())
        effective_model = model or self.model
        skip_probe = bool(
            getattr(self, "_ever_ready", False)
            and self.is_alive()
            and not self.is_severely_unhealthy()
        )
        stream = native_mod.open_worker_stream(
            self.socket_path,
            self.native_token,
            effective_model,
            request_id,
            body_obj,
            startup_timeout=45,
            gateway_policy=gateway_policy,
            restart_resume=restart_resume,
            diagnostic=self.native_diagnostic,
            is_alive=self.is_alive,
            exit_reader=self.read_exit_detail,
            skip_ready_probe=skip_probe,
        )
        self._ever_ready = True
        self._health_failures = 0
        self.host._expose_direct_socket(self)
        return stream

    def cancel_turn(self, request_id):
        try:
            return native_module().cancel_worker_request(
                self.socket_path, self.native_token, request_id
            )
        except OSError:
            return False

    def apply_policy(self, policy):
        if not self.is_alive():
            return False
        pol = normalize_runtime_policy(
            policy, base=getattr(self.host, "runtime_policy", None)
        )
        patch = runtime_policy_to_kernel_patch(pol)
        patch["max_accounts"] = 1
        status, _ = native_module().worker_json_request(
            self.socket_path, self.native_token, "PUT", "/internal/v1/policy", patch
        )
        if status != 200:
            return False
        if getattr(self, "pool_mode", False):
            env_id = self.environment["id"]
            conc = max(
                int(getattr(self, "max_concurrency", env_concurrency(self.environment)) or 1),
                1,
            )
            scale_status, _ = native_module().worker_json_request(
                self.socket_path,
                self.native_token,
                "POST",
                f"/internal/v1/accounts/{env_id}/scale",
                {
                    "runnable_slots": conc,
                    "max_concurrency": conc,
                    "min_warm_slots": min(conc, pol["min_warm_slots"]),
                    "idle_ttl_secs": pol["session_idle_ttl_secs"],
                },
                timeout=5.0,
            )
            return scale_status == 200
        return True

    def account_lifecycle(self, account_id, action):
        if not self.is_alive() or action not in LIFECYCLE_ACTIONS:
            return None
        status, data = native_module().worker_json_request(
            self.socket_path,
            self.native_token,
            "POST",
            f"/internal/v1/accounts/{account_id}/lifecycle",
            {"action": action},
        )
        return data if status == 200 else None


class CragDaemonShard:
    """Single CRAGGemini daemon shard supervising up to accounts_per_daemon (default 50)
    OAuth accounts with per-account LocalProxyBridge isolation and per-slot memfd SHM rings."""

    def __init__(self, host, shard_id, initial_members, policy=None):
        self.host = host
        self.shard_id = shard_id
        self.uid = host.egress_uid
        self.attempt = secrets.token_hex(16)
        self.policy = normalize_runtime_policy(
            policy if policy is not None else getattr(host, "runtime_policy", None)
        )
        self.directory = host.directory / "_shards" / f"{shard_id}-{self.attempt[:12]}"
        self.accounts_root = self.directory / "accounts"
        self.native_dir = None
        self._owns_native_dir = False
        self.native_token = secrets.token_hex(32)
        self.process = None
        self.members = {}
        self.started_at = now()
        self.last_used = time.monotonic()
        self._health_failures = 0
        self._ever_ready = False
        self._last_health = None
        self._last_health_at = 0.0
        self._lock = threading.RLock()
        try:
            self._start(initial_members)
        except BaseException:
            self.close()
            raise

    @property
    def socket_path(self):
        return str(self.native_dir / "kernel.sock")

    @staticmethod
    def _agy_args_for(model):
        return [
            "--dangerously-skip-permissions",
            "--add-dir",
            "/accounts",
            "--model",
            model,
            "--settings",
            json.dumps(NATIVE_CLI_SETTINGS, separators=(",", ":")),
        ]

    def _stage_account_files(self, env, auth):
        env_id = env["id"]
        acc_root = self.accounts_root / env_id
        home = acc_root / "home"
        work = acc_root / "work"
        settings_dir = home / ".gemini" / "antigravity-cli"
        for directory in (acc_root, home, home / ".gemini", settings_dir, work):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chown(directory, self.uid, self.uid)
        private_json(settings_dir / "settings.json", NATIVE_CLI_SETTINGS)
        os.chown(settings_dir / "settings.json", self.uid, self.uid)
        profile_name = env.get("profile")
        if isinstance(profile_name, str) and profile_name:
            src_cli = (
                self.host.directory
                / env_id
                / profile_name
                / "home"
                / ".gemini"
                / "antigravity-cli"
            )
            src_uid = self.host.env_uid(env)
            for rel in (
                "installation_id",
                "cache/default_project_id.txt",
                "cache/onboarding.json",
            ):
                src = src_cli / rel
                dst = settings_dir / rel
                try:
                    fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    with os.fdopen(fd, "rb") as stream:
                        info = os.fstat(stream.fileno())
                        if (
                            stat.S_ISREG(info.st_mode)
                            and info.st_uid == src_uid
                            and 0 < info.st_size <= 4096
                        ):
                            raw = stream.read(4097)
                            if 0 < len(raw) <= 4096:
                                dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                                os.chown(dst.parent, self.uid, self.uid)
                                dst.write_bytes(raw)
                                os.chmod(dst, 0o600)
                                os.chown(dst, self.uid, self.uid)
                except OSError:
                    pass
        token_bytes = auth[1] if isinstance(auth, tuple) and len(auth) > 1 else None
        if isinstance(token_bytes, (bytes, bytearray)) and token_bytes:
            token_path = settings_dir / TOKEN_NAME
            token_path.write_bytes(token_bytes)
            os.chmod(token_path, 0o600)
            os.chown(token_path, self.uid, self.uid)
        self._sync_account_license_files(env)
        return f"/accounts/{env_id}/home", f"/accounts/{env_id}/work"

    def _sync_account_license_files(self, env):
        if getattr(self.host, "payload_mode", None) != "crag_subscription":
            return
        env_id = env["id"]
        dst_dir = self.accounts_root / env_id / "crag-license"
        dst_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(dst_dir, self.uid, self.uid)
        src_dir = self.host.directory / env_id / "crag-license"
        for name in ("device.json", "registration.code"):
            src = src_dir / name
            dst = dst_dir / name
            raw = None
            try:
                fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as stream:
                    info = os.fstat(stream.fileno())
                    if stat.S_ISREG(info.st_mode) and 0 < info.st_size <= 65536:
                        data = stream.read(65537)
                        if 0 < len(data) <= 65536:
                            raw = data
            except OSError:
                raw = None
            if raw is None:
                try:
                    if dst.exists() or dst.is_symlink():
                        dst.unlink()
                except OSError:
                    pass
                continue
            try:
                if dst.is_file() and not dst.is_symlink() and dst.read_bytes() == raw:
                    os.chmod(dst, 0o600)
                    os.chown(dst, self.uid, self.uid)
                    continue
            except OSError:
                pass
            staging = dst_dir / f".{name}.{secrets.token_hex(6)}"
            try:
                with os.fdopen(
                    os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                    "wb",
                ) as out:
                    out.write(raw)
                    out.flush()
                    os.fsync(out.fileno())
                os.chown(staging, self.uid, self.uid)
                os.chmod(staging, 0o600)
                staging.replace(dst)
            finally:
                staging.unlink(missing_ok=True)

    def sync_account_license(self, env):
        with self._lock:
            self._sync_account_license_files(env)

    def _account_binding_payload(self, env, proxy_url, model):
        env_id = env["id"]
        conc = max(env_concurrency(env), 1)
        min_warm = min(conc, self.policy["min_warm_slots"])
        payload = {
            "account_id": env_id,
            "env_id": env_id,
            "agy_home": f"/accounts/{env_id}/home",
            "work_dir": f"/accounts/{env_id}/work",
            "run_dir": f"/tmp/craggemini/acc-{env_id}",
            "proxy_id": env["proxy_id"],
            "proxy_url": proxy_url,
            "proxy_sha256": hashlib.sha256(proxy_url.encode()).hexdigest(),
            "netns_transparent_egress": False,
            "max_concurrency": conc,
            "min_warm_slots": min_warm,
            "session_idle_ttl_secs": self.policy["session_idle_ttl_secs"],
            "model": model,
            "agy_args": self._agy_args_for(model),
            "oauth_proxy_required": True,
            "enabled": True,
        }
        if getattr(self.host, "payload_mode", None) == "crag_subscription":
            payload["vm_id"] = env_id
            payload["license_dir"] = f"/accounts/{env_id}/crag-license"
        return payload

    def _start(self, initial_members):
        shards_parent = self.directory.parent
        shards_parent.mkdir(mode=0o711, exist_ok=True)
        shards_parent.chmod(0o711)
        self.directory.mkdir(mode=0o711)
        self.directory.chmod(0o711)
        self.accounts_root.mkdir(mode=0o700)
        os.chown(self.accounts_root, self.uid, self.uid)

        short_name = f"sh-{self.shard_id}-{self.attempt[:10]}"
        self.native_dir, self._owns_native_dir = self.host._allocate_native_dir(
            self.uid, self.directory / "native", short_name
        )

        accounts_cfg = []
        default_model = NATIVE_DEFAULT_MODEL
        boot_license_env_id = None
        for member in initial_members:
            if len(member) >= 5:
                env, proxy_url, auth, model, raw_egress_opts = member[:5]
            else:
                env, proxy_url, auth, model = member[:4]
                raw_egress_opts = None
            egress_opts = normalize_egress_options(raw_egress_opts)
            egress_key = egress_fingerprint(proxy_url, egress_opts)
            self._stage_account_files(env, auth)
            effective_model = model or self.host._initial_session_model(env)
            default_model = effective_model
            # Note: CRAGGemini AccountBindingConfig enforces #[serde(deny_unknown_fields)],
            # so egress_options are tracked in host shard metadata/egress_key rather than
            # injected as unknown JSON keys into kernel.json.
            accounts_cfg.append(
                self._account_binding_payload(env, proxy_url, effective_model)
            )
            self.members[env["id"]] = {
                "proxy_id": env["proxy_id"],
                "proxy_hash": hashlib.sha256(proxy_url.encode()).digest(),
                "egress_key": egress_key,
                "egress_options": egress_opts,
                "max_concurrency": env_concurrency(env),
                "model": effective_model,
            }
            if getattr(self.host, "payload_mode", None) == "crag_subscription":
                reg = self.accounts_root / env["id"] / "crag-license" / "registration.code"
                if boot_license_env_id is None or reg.is_file():
                    if boot_license_env_id is None or not (
                        self.accounts_root / boot_license_env_id / "crag-license" / "registration.code"
                    ).is_file():
                        boot_license_env_id = env["id"]

        pol = self.policy
        kernel_vm_id = (
            boot_license_env_id
            if getattr(self.host, "payload_mode", None) == "crag_subscription"
            and boot_license_env_id
            else self.shard_id
        )
        kernel_license_dir = (
            f"/accounts/{boot_license_env_id}/crag-license"
            if getattr(self.host, "payload_mode", None) == "crag_subscription"
            and boot_license_env_id
            else "/run/kin/crag-license"
        )
        kernel_cfg = {
            "run_dir": "/tmp/craggemini",
            "internal_token": self.native_token,
            "session_id": self.attempt,
            "model": default_model,
            "agy_sha256": self.host.installed_agy_sha256(),
            "timeout_ms": pol["timeout_ms"],
            "first_byte_timeout_ms": pol["first_byte_timeout_ms"],
            "idle_timeout_ms": pol["idle_timeout_ms"],
            "queue_timeout_ms": pol["queue_timeout_ms"],
            "max_queue": max(pol["max_queue"], 16),
            "shm_request_bytes": pol["shm_request_mb"] * 1024 * 1024,
            "shm_response_bytes": pol["shm_response_mb"] * 1024 * 1024,
            "strategy": pol["strategy"],
            "max_accounts": pol["accounts_per_daemon"],
            "sticky_enabled": pol["sticky_enabled"],
            "sticky_ttl_secs": pol["sticky_ttl_secs"],
            "require_shm": pol["require_shm"],
            "circuit_failure_threshold": pol["circuit_failure_threshold"],
            "circuit_open_ms": pol["circuit_open_ms"],
            "agy_bin": "/opt/agy",
            "bridge_so": "/opt/libagy_bridge.so",
            "verify_agy_sha256": True,
            "strict_unique_proxy": False,
            "require_proxy_calibration": False,
            "vm_id": kernel_vm_id,
            "license_dir": kernel_license_dir,
            "host_license_dir": "/run/kin/crag-host",
            "accounts": accounts_cfg,
        }
        config_path = self.native_dir / "kernel.json"
        private_json(config_path, kernel_cfg)
        os.chown(config_path, self.uid, self.uid)

        license_dir = self.directory / "crag-license"
        license_dir.mkdir(mode=0o700)
        os.chown(license_dir, self.uid, self.uid)

        hostname = f"ws-{self.shard_id}"
        identity_files = {
            "resolv.conf": _host_resolv_conf(),
            "passwd": f"agy:x:{self.uid}:{self.uid}:Antigravity:/accounts:/bin/sh\n",
            "group": f"agy:x:{self.uid}:\n",
            "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files dns\n",
            "hosts": f"127.0.0.1 localhost {hostname}\n::1 localhost\n",
        }
        identity = []
        for name, contents in identity_files.items():
            target = self.directory / name
            target.write_text(contents, encoding="utf-8")
            target.chmod(0o644)
            identity += ["--ro-bind", str(target), "/etc/" + name]

        crag_mounts = [
            "--dir",
            "/run",
            "--dir",
            "/run/kin",
            "--dir",
            "/run/kin/crag-license",
            "--bind",
            str(license_dir),
            "/run/kin/crag-license",
        ]
        if self.host.crag_host_dir is not None and self.host.crag_host_dir.is_dir():
            crag_mounts.extend(
                [
                    "--dir",
                    "/run/kin/crag-host",
                    "--ro-bind",
                    str(self.host.crag_host_dir),
                    "/run/kin/crag-host",
                ]
            )
        if self.host.payload_mode == "crag_subscription":
            crag_mounts.extend(
                [
                    "--ro-bind",
                    str(self.host.payload / "craggemini.payload.enc"),
                    "/opt/craggemini.payload.enc",
                    "--ro-bind",
                    str(self.host.payload / "manifest.json"),
                    "/opt/manifest.json",
                    "--ro-bind",
                    str(self.host.payload / "crag-license-public.pem"),
                    "/opt/crag-license-public.pem",
                ]
            )

        argv = [
            "setpriv",
            "--reuid",
            str(self.uid),
            "--regid",
            str(self.uid),
            "--clear-groups",
            "--no-new-privs",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--bounding-set=-all",
            resolve_bwrap_argv0(host_root=active_host_root()),
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--hostname",
            hostname,
            "--die-with-parent",
            "--clearenv",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind-try",
            "/lib",
            "/lib",
            "--ro-bind-try",
            "/lib64",
            "/lib64",
            "--ro-bind-try",
            "/bin",
            "/bin",
            "--ro-bind-try",
            "/etc/ssl/certs",
            "/etc/ssl/certs",
            *identity,
            *crag_mounts,
            "--ro-bind",
            str(self.host.payload / "agy"),
            "/opt/agy",
            "--ro-bind",
            str(self.host.payload / "craggemini"),
            "/opt/craggemini",
            "--ro-bind",
            str(self.host.payload / "libagy_bridge.so"),
            "/opt/libagy_bridge.so",
            "--dir",
            "/accounts",
            "--bind",
            str(self.accounts_root),
            "/accounts",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--dir",
            "/tmp/craggemini",
            "--bind",
            str(self.native_dir),
            "/tmp/craggemini",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "TERM",
            "xterm-256color",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "AGY_CLI_DISABLE_AUTO_UPDATE",
            "true",
            "--setenv",
            "CRAGGEMINI_SESSION_ID",
            self.attempt,
            "--ro-bind",
            str(NATIVE_MODULE),
            "/opt/gemini_host_native.py",
            "--",
            "/usr/bin/python3",
            "-I",
            "/opt/gemini_host_native.py",
            "--launch-native",
            "/opt/agy",
        ]
        spawn = getattr(self.host, "spawn", lambda fn: fn())
        try:
            self.process = spawn(
                lambda: subprocess.Popen(
                    argv,
                    env=SYSTEM_ENV,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            )
        except OSError:
            raise Failure(503, "gemini_native_worker_unavailable") from None

    def is_alive(self):
        return self.process is not None and self.process.poll() is None

    def health(self, timeout=0.5):
        if not self.is_alive():
            self._last_health = None
            self._health_failures = SHARD_HEALTH_FAIL_THRESHOLD
            return None
        status = native_module().worker_status(
            self.socket_path, self.native_token, timeout=timeout
        )
        self._last_health = status
        self._last_health_at = time.monotonic()
        if (
            isinstance(status, dict)
            and status.get("ready") is True
            and status.get("needs_recovery") is not True
        ):
            self._health_failures = 0
            self._ever_ready = True
        else:
            self._health_failures += 1
        return status

    def is_severely_unhealthy(self):
        if not self.is_alive():
            return True
        if isinstance(self._last_health, dict):
            if self._last_health.get("needs_recovery") is True:
                return True
            if self._last_health.get("ok") is False:
                return True
        return self._health_failures >= SHARD_HEALTH_FAIL_THRESHOLD

    def apply_policy(self, policy):
        with self._lock:
            self.policy = normalize_runtime_policy(policy, base=self.policy)
            if not self.is_alive():
                return False
            patch = runtime_policy_to_kernel_patch(self.policy)
            status, _ = native_module().worker_json_request(
                self.socket_path, self.native_token, "PUT", "/internal/v1/policy", patch
            )
            if status != 200:
                return False
            all_ok = True
            for env_id, meta in list(self.members.items()):
                conc = max(int(meta.get("max_concurrency") or 1), 1)
                scale_status, _ = native_module().worker_json_request(
                    self.socket_path,
                    self.native_token,
                    "POST",
                    f"/internal/v1/accounts/{env_id}/scale",
                    {
                        "runnable_slots": conc,
                        "max_concurrency": conc,
                        "min_warm_slots": min(conc, self.policy["min_warm_slots"]),
                        "idle_ttl_secs": self.policy["session_idle_ttl_secs"],
                    },
                    timeout=5.0,
                )
                if scale_status != 200:
                    all_ok = False
            return all_ok

    def sync_account(self, env, proxy_url, auth, model=None, *, egress_options=None):
        with self._lock:
            if not self.is_alive():
                raise Failure(503, "gemini_native_worker_unavailable")
            env_id = env["id"]
            proxy_hash = hashlib.sha256(proxy_url.encode()).digest()
            egress_opts = normalize_egress_options(egress_options)
            egress_key = egress_fingerprint(proxy_url, egress_opts)
            desired_conc = env_concurrency(env)
            effective_model = model or self.host._initial_session_model(env)
            self._stage_account_files(env, auth)
            existing = self.members.get(env_id)
            if existing is None:
                payload = self._account_binding_payload(env, proxy_url, effective_model)
                payload["auto_calibrate"] = False
                status, _ = native_module().worker_json_request(
                    self.socket_path,
                    self.native_token,
                    "POST",
                    "/internal/v1/accounts",
                    payload,
                    timeout=10.0,
                )
                if status != 200:
                    raise Failure(503, "gemini_native_worker_unavailable")
                self.members[env_id] = {
                    "proxy_id": env["proxy_id"],
                    "proxy_hash": proxy_hash,
                    "egress_key": egress_key,
                    "egress_options": egress_opts,
                    "max_concurrency": desired_conc,
                    "model": effective_model,
                }
                return True
            existing_egress_key = existing.get("egress_key", existing["proxy_hash"])
            if existing["proxy_id"] != env["proxy_id"] or not secrets.compare_digest(
                existing_egress_key, egress_key
            ):
                status, _ = native_module().worker_json_request(
                    self.socket_path,
                    self.native_token,
                    "POST",
                    f"/internal/v1/accounts/{env_id}/proxy",
                    {
                        "proxy_id": env["proxy_id"],
                        "proxy_url": proxy_url,
                        "proxy_sha256": hashlib.sha256(proxy_url.encode()).hexdigest(),
                        "auto_calibrate": False,
                    },
                    timeout=10.0,
                )
                if status != 200:
                    raise Failure(503, "gemini_native_worker_unavailable")
                existing["proxy_id"] = env["proxy_id"]
                existing["proxy_hash"] = proxy_hash
                existing["egress_key"] = egress_key
                existing["egress_options"] = egress_opts
            if existing["max_concurrency"] != desired_conc:
                status, _ = native_module().worker_json_request(
                    self.socket_path,
                    self.native_token,
                    "POST",
                    f"/internal/v1/accounts/{env_id}/scale",
                    {
                        "runnable_slots": desired_conc,
                        "max_concurrency": desired_conc,
                        "min_warm_slots": min(
                            desired_conc, self.policy["min_warm_slots"]
                        ),
                        "idle_ttl_secs": self.policy["session_idle_ttl_secs"],
                    },
                    timeout=10.0,
                )
                if status == 200:
                    existing["max_concurrency"] = desired_conc
            return True

    def remove_account(self, env_id):
        with self._lock:
            self.members.pop(env_id, None)
            if self.is_alive():
                native_module().worker_json_request(
                    self.socket_path,
                    self.native_token,
                    "DELETE",
                    f"/internal/v1/accounts/{env_id}",
                    timeout=5.0,
                )
            acc_dir = self.accounts_root / env_id
            if acc_dir.exists():
                shutil.rmtree(acc_dir, ignore_errors=True)

    def account_lifecycle(self, env_id, action):
        if action not in LIFECYCLE_ACTIONS or not self.is_alive():
            return None
        status, data = native_module().worker_json_request(
            self.socket_path,
            self.native_token,
            "POST",
            f"/internal/v1/accounts/{env_id}/lifecycle",
            {"action": action},
            timeout=10.0,
        )
        return data if status == 200 else None

    def read_exit_detail(self):
        if self.native_dir is None:
            return None
        return native_module().read_launcher_exit_detail(self.native_dir, self.uid)

    def early_exit_code(self):
        return native_module().launcher_exit_code(self.read_exit_detail())

    def open_stream(
        self,
        env_id,
        request_id,
        body_obj,
        *,
        model=None,
        gateway_policy=None,
        restart_resume=False,
    ):
        native_mod = native_module()
        if not self.is_alive():
            raise native_mod.launcher_exit_failure(self.read_exit_detail())
        self.last_used = time.monotonic()
        effective_model = model or NATIVE_DEFAULT_MODEL
        skip_probe = bool(
            getattr(self, "_ever_ready", False)
            and self.is_alive()
            and not self.is_severely_unhealthy()
        )
        stream = native_mod.open_worker_stream(
            self.socket_path,
            self.native_token,
            effective_model,
            request_id,
            body_obj,
            startup_timeout=45,
            gateway_policy=gateway_policy,
            restart_resume=restart_resume,
            account_id=env_id,
            is_alive=self.is_alive,
            exit_reader=self.read_exit_detail,
            skip_ready_probe=skip_probe,
        )
        self._ever_ready = True
        self._health_failures = 0
        self.host._expose_direct_socket(self)
        return stream

    def cancel_turn(self, env_id, request_id):
        try:
            return native_module().cancel_worker_request(
                self.socket_path, self.native_token, request_id, account_id=env_id
            )
        except OSError:
            return False

    def status_view(self, fault_meta=None):
        health = self.health(timeout=0.35) if self.is_alive() else None
        pool = health.get("pool") if isinstance(health, dict) and isinstance(health.get("pool"), dict) else {}
        return {
            "shard_id": self.shard_id,
            "kind": "shard",
            "alive": self.is_alive(),
            "ready": bool(isinstance(health, dict) and health.get("ready") is True),
            "pid": self.process.pid if self.process is not None else None,
            "started_at": self.started_at,
            "capacity": self.policy["accounts_per_daemon"],
            "account_count": len(self.members),
            "account_ids": sorted(self.members.keys()),
            "active_slots": int(pool.get("active_slots") or 0),
            "idle_slots": int(pool.get("idle_slots") or 0),
            "total_slots": int(pool.get("total_slots") or 0),
            "circuit_open_accounts": int(pool.get("circuit_open_accounts") or 0),
            "shm_enabled": bool(self.policy.get("require_shm", True)),
            "shm_ring_stats": pool.get("shm_ring_stats") or None,
            "policy": pool.get("policy") or runtime_policy_to_kernel_patch(self.policy),
            "accounts": pool.get("accounts") if isinstance(pool.get("accounts"), list) else [],
            "fault_isolated": bool(fault_meta and fault_meta.get("isolated")),
            "restart_count": int(fault_meta.get("restarts", 0)) if fault_meta else 0,
        }

    def close(self):
        with self._lock:
            try:
                if self.process is not None:
                    NativeAgy._stop_process_group(self.process)
                    self.process = None
                    outcome = self.read_exit_detail()
                    if outcome is not None:
                        child, status, reason = outcome
                        kind = "exit_code" if status >= 0 else "signal"
                        reason_text = f" reason={reason}" if reason else ""
                        print(
                            f"Gemini native shard={self.shard_id} child={child} {kind}={abs(status)}{reason_text}",
                            file=sys.stderr,
                        )
            finally:
                try:
                    if getattr(self, "_owns_native_dir", False) and self.native_dir is not None:
                        shutil.rmtree(self.native_dir, ignore_errors=True)
                        self._owns_native_dir = False
                finally:
                    if self.directory.exists():
                        shutil.rmtree(self.directory, ignore_errors=True)


class ResidentTestChatRun:
    """Runs a panel test-chat turn directly on the resident NativeSession without restarting it."""

    def __init__(self, session, model, prompt, credentials):
        self.session = session
        self.model = model
        self._request_id = f"test-{secrets.token_hex(12)}"
        self._done = False
        invocation_request = {
            "socket": session.socket_path,
            "token": session.native_token,
            "model": model,
            "request_id": self._request_id,
            "prompt": prompt,
        }
        session_uid = getattr(session, "uid", None)
        if type(session_uid) is int and session_uid >= 0:
            invocation_request["launcher_uid"] = session_uid
        self._invocation = native_module().NativeInvocation(
            invocation_request,
            secrets=credentials,
        )

    def poll(self):
        diagnostic = session_diagnostic(self.session, include_advisory=False)
        if diagnostic is not None:
            self._done = True
            return {"state": "failed", "text": "", "error": {"code": diagnostic}}
        result = self._invocation.poll()
        if result["state"] != "running":
            self._done = True
            self.session.last_used = time.monotonic()
            if result["state"] == "completed":
                diag = getattr(self.session, "native_diagnostic", None)
                if diag is not None and hasattr(diag, "clear_advisory"):
                    diag.clear_advisory()
            elif result["state"] == "failed" and self.session.native_diagnostic is not None:
                final_diag = self.session.native_diagnostic.poll(final=True)
                if final_diag is not None:
                    return {"state": "failed", "text": "", "error": {"code": final_diag}}
            return result
        if not self.session.is_alive():
            self._done = True
            code = (
                self.session.early_exit_code()
                if hasattr(self.session, "early_exit_code")
                else "gemini_native_worker_unavailable"
            )
            return {
                "state": "failed",
                "text": "",
                "error": {"code": code},
            }
        return result

    def close(self):
        try:
            if not self._done:
                self.session.cancel_turn(self._request_id)
        finally:
            if self._invocation is not None:
                self._invocation.close()
                self._invocation = None


class Login(Agy):
    def __init__(self, host, environment, proxy_url, *, egress_options=None):
        self.deadline = time.monotonic() + AUTH_TTL
        self.sent = False
        self.state = None
        self.buffer = b""
        self.token_seen_at = None
        super().__init__(host, environment, proxy_url, egress_options=egress_options)

    @staticmethod
    def _format_exit_reason(exit_status):
        if not isinstance(exit_status, dict):
            return None
        if "exit_code" in exit_status:
            return f"exit_code={exit_status['exit_code']}"
        if "signal" in exit_status:
            return f"signal={exit_status['signal']}"
        return None

    def _wait_exit_status(self, timeout=0.2):
        status = self.poll_exit_status()
        if status is not None or not self.pid:
            return status
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            time.sleep(0.01)
            status = self.poll_exit_status()
            if status is not None:
                return status
        return None

    def _classify_early_exit(self, exit_status):
        # Never expose or log self.buffer / PTY output.
        reason = self._format_exit_reason(exit_status) or "exited"
        probe = getattr(self.host, "probe_sandbox", None)
        sandbox_issue = probe(force=True) if callable(probe) else None
        if sandbox_issue in SANDBOX_ERROR_CODES:
            return Failure(503, sandbox_issue, stage="sandbox_denied", reason=reason)
        return Failure(503, stage="cli_early_exit", reason=reason)

    def read(self, timeout):
        if not self.alive():
            exit_status = self.poll_exit_status()
            raise Failure(
                503, reason=self._format_exit_reason(exit_status) or "exited"
            )
        if select.select([self.terminal], [], [], timeout)[0]:
            try:
                data = os.read(self.terminal, 16384)
            except BlockingIOError:
                return
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                exit_status = self._wait_exit_status(0.2)
                raise Failure(
                    409, reason=self._format_exit_reason(exit_status) or "exited"
                )
            self.buffer = (self.buffer + data)[-65536:]

    def challenge(self):
        selected = False
        deadline = time.monotonic() + 8
        try:
            while time.monotonic() < deadline:
                self.read(0.1)
                if not selected and b"> 1. Google OAuth" in self.buffer:
                    os.write(self.terminal, b"\r")
                    selected = True
                match = AUTH_LINK.search(self.buffer)
                if selected and match:
                    url = match.group(1).decode("ascii")
                    self.state = parse_qs(urlsplit(url).query).get("state", [None])[0]
                    return {
                        "attempt_id": self.attempt,
                        "url": url,
                    }
        except Failure as err:
            if err.stage is not None:
                raise
            exit_status = self._wait_exit_status(0.2)
            if exit_status is not None or not self.alive():
                raise self._classify_early_exit(exit_status) from err
            raise Failure(
                err.status, err.code, stage="challenge_wait", reason=err.reason
            ) from err
        except OSError as err:
            exit_status = self._wait_exit_status(0.2)
            if exit_status is not None or not self.alive():
                raise self._classify_early_exit(exit_status) from err
            raise Failure(503, stage="challenge_wait", reason="os_error") from err
        exit_status = self.poll_exit_status()
        if exit_status is not None or not self.alive():
            raise self._classify_early_exit(exit_status)
        raise Failure(503, stage="challenge_wait", reason="timeout")

    def submit(self, code, state, proxy_url):
        if (
            self.sent
            or not CODE.fullmatch(code)
            or (
                state is not None
                and (not self.state or not secrets.compare_digest(self.state, state))
            )
            or not secrets.compare_digest(
                self.proxy_hash, hashlib.sha256(proxy_url.encode()).digest()
            )
        ):
            raise Failure(409)
        self.buffer = b""
        written = os.write(self.terminal, code.encode("ascii") + b"\r")
        if written != len(code) + 1:
            raise Failure(503)
        self.sent = True

    def _project_cache_ready(self):
        cache_file = (
            self.directory
            / "home"
            / ".gemini"
            / "antigravity-cli"
            / "cache"
            / "default_project_id.txt"
        )
        try:
            fd = os.open(cache_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != self.uid:
                    return False
                return bool(stream.read(256).strip())
        except OSError:
            return False

    def finished(self):
        if self.sent and profile_secrets(self.directory, self.uid):
            now_mono = time.monotonic()
            if self.token_seen_at is None:
                self.token_seen_at = now_mono
            try:
                self.read(0)
            except Failure:
                return True
            elapsed = now_mono - self.token_seen_at
            # Let agy finish its official post-login initialization sequence
            # (loadCodeAssist, fetchAvailableModels, FetchConfig/experiments, cache flush)
            # before gracefully terminating it. Never cut it off on .config/antigravity,
            # which agy already creates before OAuth login starts.
            if (
                not self.alive()
                or elapsed >= AUTH_SETTLE_SECONDS
                or (elapsed >= AUTH_MIN_SETTLE_SECONDS and self._project_cache_ready())
            ):
                return True
            return False
        self.read(0)
        if self.sent and AUTH_FAILURE.search(self.buffer):
            raise Failure(409)
        return False


class Display:
    def __init__(self):
        self.decode = codecs.getincrementaldecoder("utf-8")("ignore")
        self.state = "text"
        self.csi = ""
        self.tail = ""

    def screen(self, raw, credentials, startup_replies=None):
        out = []
        for char in self.decode.decode(raw):
            if self.state in ("string", "string-escape"):
                if char in "\x07\x9c" or self.state == "string-escape" and char == "\\":
                    self.state = "text"
                else:
                    self.state = "string-escape" if char == "\x1b" else "string"
            elif self.state == "escape":
                if char == "[":
                    self.csi = "\x1b["
                    self.state = "csi"
                elif char in "]P_^X":
                    self.state = "string"
                else:
                    self.state = "escape" if char == "\x1b" else "text"
            elif self.state == "csi":
                if "@" <= char <= "~":
                    command = self.csi + char
                    if startup_replies is not None and command in STARTUP_DA:
                        reply = startup_replies.pop(command, b"")
                        if reply:
                            startup_replies[None] += reply
                    elif self.csi and DISPLAY_CSI.fullmatch(command):
                        out.append(command)
                    self.state = "text"
                elif char == "\x1b":
                    self.state = "escape"
                elif self.csi and len(self.csi) < 64:
                    self.csi += char
                else:
                    self.csi = ""
            elif char in "\x90\x98\x9d\x9e\x9f":
                self.state = "string"
            elif char == "\x1b":
                self.state = "escape"
            elif char in "\r\n\t\b" or char >= " " and not "\x7f" <= char <= "\x9f":
                out.append(char)

        text = self.tail + "".join(out)
        plain = DISPLAY_CSI.sub("", text)
        keep = 0
        markers = credentials + OAUTH_OUTPUT
        if startup_replies is not None:
            # After startup the same menu text can come from a prompt or model.
            markers += (OAUTH_MENU,)
        for marker in markers:
            if marker in plain:
                raise Failure(409, TERMINAL_OAUTH if marker == OAUTH_MENU else None)
            # Hold potential fragments across PTY reads and ANSI styling.
            start = max(0, len(plain) - len(marker) + 1)
            while True:
                pos = plain.find(marker[0], start)
                if pos < 0 or len(plain) - pos <= keep:
                    break
                if marker.startswith(plain[pos:]):
                    keep = len(plain) - pos
                    break
                start = pos + 1
        split = len(text)
        if keep:
            split = len(plain) - keep
            for match in DISPLAY_CSI.finditer(text):
                if match.start() > split:
                    break
                split += len(match[0])
        self.tail = text[split:]
        if len(self.tail) > TERMINAL_READ:
            raise Failure(409)
        return text[:split].encode("utf-8")


def terminal_size(body, required=False):
    if not required and "cols" not in body and "rows" not in body:
        return None
    cols, rows = body.get("cols"), body.get("rows")
    if (
        type(cols) is not int
        or type(rows) is not int
        or not (10 <= cols <= 500 and 5 <= rows <= 200)
    ):
        raise Failure(400)
    return cols, rows


class Terminal(Agy):
    def __init__(
        self,
        host,
        environment,
        proxy_url,
        profile,
        size,
        session_id,
        credentials,
        *,
        egress_options=None,
    ):
        self.session_id = session_id
        self.size = size
        self.display = Display()
        self.input = bytearray()
        self.output = bytearray()
        self.credentials = credentials
        super().__init__(host, environment, proxy_url, profile, size, egress_options=egress_options)
        try:
            self.await_start()
        except BaseException:
            self.close()
            raise
        self.deadline = time.monotonic() + TERMINAL_TTL

    def await_start(self):
        deadline = time.monotonic() + 8
        startup_replies = {**STARTUP_DA, None: b""}
        painted = False
        ready_at = None
        pending = b""
        while time.monotonic() < deadline:
            if not self.alive():
                raise Failure(503)
            self.flush_input()
            if ready_at is not None and painted and time.monotonic() >= ready_at:
                return
            if len(self.output) >= TERMINAL_READ:
                time.sleep(0.05)
                continue
            if not select.select([self.terminal], [], [], 0.05)[0]:
                continue
            try:
                raw = os.read(self.terminal, 4096)
            except BlockingIOError:
                continue
            if not raw:
                raise Failure(503)
            if ready_at is None:
                pending += raw
                _, match, raw = pending.partition(CLI_MARKER)
                if not match:
                    pending = pending[-len(CLI_MARKER) :]
                    continue
                # Catch exec/loader failures immediately after sandbox setup.
                ready_at = time.monotonic() + 0.5
            rendered = self.display.screen(raw, self.credentials, startup_replies)
            self.input += startup_replies[None]
            startup_replies[None] = b""
            painted = painted or bool(
                DISPLAY_CSI.sub("", rendered.decode("utf-8")).strip()
            )
            self.output += rendered
        raise Failure(503)

    def live_profile(self):
        current = profile_secrets(self.profile, self.uid)
        if not current:
            return False
        # Keep prior credential generations while filtering buffered PTY output.
        self.credentials = tuple(dict.fromkeys(current + self.credentials))[:12]
        return True

    def relay(self, new_input, size):
        if not self.alive() or not self.live_profile():
            raise Failure(409)
        if len(self.input) + len(new_input) > TERMINAL_INPUT * 4:
            raise Failure(429, "gemini_terminal_conflict")
        if size and size != self.size:
            fcntl.ioctl(
                self.terminal,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", size[1], size[0], 0, 0),
            )
            self.size = size
            self.deadline = time.monotonic() + TERMINAL_TTL
        if new_input:
            self.input += new_input
            self.deadline = time.monotonic() + TERMINAL_TTL
        self.flush_input()
        if len(self.output) < TERMINAL_READ:
            try:
                raw = os.read(self.terminal, TERMINAL_READ)
            except BlockingIOError:
                raw = None
            if raw == b"":
                raise Failure(409)
            if raw:
                self.output += self.display.screen(raw, self.credentials)
        chunk = self.output[:TERMINAL_READ]
        del self.output[:TERMINAL_READ]
        return base64.b64encode(chunk).decode("ascii")

    def flush_input(self):
        if self.input:
            try:
                del self.input[: os.write(self.terminal, self.input)]
            except BlockingIOError:
                pass


class Host:
    def __init__(self, args):
        self.directory = args.state
        self.payload = args.payload
        self.payload_source = args.payload_source
        self.public_key = args.public_key
        self.default_public_key = args.default_public_key
        self.default_release = args.default_release_verifier
        self.manual_release = args.release_verifier or MANUAL_RELEASE
        self.manual_release_optional = args.release_verifier is None
        self.activation = self.directory / "release-activation.json"
        self.verified_payload = None
        self.payload_version = None
        self.payload_state = "not_configured"
        self.payload_mode = "legacy_release"
        self.payload_issue = None
        self.crag_host_dir = getattr(args, "crag_host_dir", None)
        self.socket_path = getattr(args, "socket", None)
        self.gateway_group = getattr(args, "gateway_group", None)
        self.gateway_gid = None
        if isinstance(self.gateway_group, str) and self.gateway_group:
            try:
                self.gateway_gid = grp.getgrnam(self.gateway_group).gr_gid
            except KeyError:
                self.gateway_gid = None
        self.egress = args.egress
        self.uid_base = args.uid_base
        self.egress_uid = args.uid_base + MAX_NETNS_SLOTS
        self.state_file = self.directory / "environments.json"
        self.policy_file = self.directory / "runtime-policy.json"
        self.lock = threading.RLock()
        self._spawner = _Spawner()
        self.pending = {}
        self.terminals = {}
        self.runs = {}
        self.native_sessions = {}
        self.daemon_shards = {}
        self._shard_locks = {}
        self._shard_faults = {}
        self._account_shard_map = {}
        self._session_locks = {}
        self._slot_networks = {}
        self._network_lease_lock = threading.Lock()
        self._sandbox_probe_lock = threading.Lock()
        self._sandbox_probe_cache = None
        self._runtime_proxies = {}
        self._warm_backoff = {}
        self._warming = set()
        self.active_infers = {}
        self.last_inference = {}
        self.runtime_policy = self._load_runtime_policy()
        self.network_scope = os.stat("/proc/self/ns/net").st_ino
        self.environments = (
            json.loads(self.state_file.read_bytes()) if self.state_file.exists() else {}
        )
        _ensure_traversable_dir(self.directory)
        if (
            not isinstance(self.environments, dict)
            or len(self.environments) > MAX_ENVIRONMENTS
        ):
            raise RuntimeError("invalid Gemini host state")
        changed = False
        slots = set()
        for identifier, env in self.environments.items():
            if (
                not re.fullmatch(r"gemini-[0-9a-f]{24}", identifier)
                or env["id"] != identifier
            ):
                raise RuntimeError("invalid Gemini environment identity")
            slot = env["slot"]
            profile = env.get("profile")
            if (
                type(slot) is not int
                or not 0 <= slot < MAX_ENVIRONMENTS
                or slot in slots
                or (profile is not None and not re.fullmatch(r"[a-f0-9]{32}", profile))
            ):
                raise RuntimeError("invalid Gemini environment slot or profile")
            slots.add(slot)
            if env["auth_state"] == "authorizing":
                env["auth_state"] = "reauth_required"
                env["updated_at"] = now()
                changed = True
            env_dir = self.directory / identifier
            if env_dir.exists():
                check_root_owned(env_dir)
                self._heal_env_dir_perms(env)
                self.recover_network(env_dir, slot)
                for stale in env_dir.iterdir():
                    name = (
                        stale.name[9:]
                        if stale.name.startswith("terminal-")
                        else stale.name
                    )
                    if (
                        stale.name != profile
                        and (
                            ATTEMPT.fullmatch(name)
                            or re.fullmatch(r"\.net-[a-f0-9]{16}", stale.name)
                        )
                    ):
                        check_root_owned(stale)
                        if stale.is_dir():
                            shutil.rmtree(stale)
        if changed:
            self.save()
        if NATIVE_RUNTIME_ROOT.exists():
            try:
                check_root_owned(NATIVE_RUNTIME_ROOT)
                os.chmod(NATIVE_RUNTIME_ROOT, 0o711)
                for stale in NATIVE_RUNTIME_ROOT.iterdir():
                    if stale.is_dir() and (
                        re.fullmatch(r"s[0-9]+-[a-f0-9]{8,16}", stale.name)
                        or re.fullmatch(r"sh-shard-[0-9]+-[a-f0-9]{8,16}", stale.name)
                    ):
                        shutil.rmtree(stale, ignore_errors=True)
            except (OSError, RuntimeError):
                pass
        direct_root = self._direct_runtime_root()
        if direct_root is not None and direct_root.exists():
            try:
                check_root_owned(direct_root)
                os.chmod(direct_root, 0o711)
                for stale in direct_root.iterdir():
                    if stale.is_dir() and (
                        re.fullmatch(r"s[0-9]+-[a-f0-9]{8,16}", stale.name)
                        or re.fullmatch(r"sh-shard-[0-9]+-[a-f0-9]{8,16}", stale.name)
                    ):
                        shutil.rmtree(stale, ignore_errors=True)
            except (OSError, RuntimeError):
                pass
        stale_shards = self.directory / "_shards"
        if stale_shards.is_dir():
            try:
                check_root_owned(stale_shards)
                shutil.rmtree(stale_shards, ignore_errors=True)
            except (OSError, RuntimeError):
                pass
        self.inspect_payload()

    def env_uid(self, env):
        return self.uid_base + (env["slot"] % MAX_NETNS_SLOTS)

    def _direct_runtime_root(self):
        sock = getattr(self, "socket_path", None)
        if isinstance(sock, Path):
            return sock.parent / "d"
        return None

    def _allocate_native_dir(self, uid, fallback_candidate, short_name):
        direct_root = self._direct_runtime_root()
        gateway_gid = getattr(self, "gateway_gid", None)
        if (
            direct_root is not None
            and gateway_gid is not None
            and os.geteuid() == 0
            and len(str(direct_root / short_name / "kernel.sock").encode("utf-8")) <= 96
        ):
            # 0o711 lets both gateway_gid and unprivileged bwrap worker UIDs traverse
            # direct_root without listing sibling directories; native_dir starts as
            # 0o700 (uid:uid) so craggemini Config::validate() accepts run_dir, then
            # _expose_direct_socket() opens 0o710 (uid:gateway_gid) once ready.
            direct_root.mkdir(mode=0o711, exist_ok=True)
            os.chown(direct_root, 0, gateway_gid)
            os.chmod(direct_root, 0o711)
            check_root_owned(direct_root)
            native_dir = direct_root / short_name
            native_dir.mkdir(mode=0o700)
            os.chown(native_dir, uid, uid)
            os.chmod(native_dir, 0o700)
            return native_dir, True
        if len(str(fallback_candidate / "kernel.sock").encode("utf-8")) > 96:
            NATIVE_RUNTIME_ROOT.mkdir(mode=0o711, exist_ok=True)
            os.chmod(NATIVE_RUNTIME_ROOT, 0o711)
            check_root_owned(NATIVE_RUNTIME_ROOT)
            native_dir = NATIVE_RUNTIME_ROOT / short_name
            owns = True
        else:
            native_dir = fallback_candidate
            owns = False
        native_dir.mkdir(mode=0o700)
        os.chown(native_dir, uid, uid)
        return native_dir, owns

    def _expose_direct_socket(self, worker):
        sock_str = getattr(worker, "socket_path", None)
        if not isinstance(sock_str, str) or not sock_str:
            return False
        sock = Path(sock_str)
        try:
            info = sock.lstat()
        except OSError:
            return False
        if not stat.S_ISSOCK(info.st_mode):
            return False
        gateway_gid = getattr(self, "gateway_gid", None)
        if os.geteuid() == 0:
            expected_uid = getattr(worker, "uid", info.st_uid)
            if info.st_uid != expected_uid:
                return False
            if gateway_gid is not None:
                direct_root = self._direct_runtime_root()
                allowed_roots = {
                    root for root in (direct_root, NATIVE_RUNTIME_ROOT) if root is not None
                }
                parent = sock.parent
                if parent.parent not in allowed_roots:
                    return False
                try:
                    parent_info = parent.lstat()
                    if (
                        not stat.S_ISDIR(parent_info.st_mode)
                        or parent_info.st_uid != expected_uid
                    ):
                        return False
                    os.chown(parent, expected_uid, gateway_gid)
                    os.chmod(parent, 0o710)
                    os.chown(sock, info.st_uid, gateway_gid)
                    os.chmod(sock, 0o660)
                except OSError:
                    return False
        return True

    def _sync_shard_account_license(self, env):
        shard_id = getattr(self, "_account_shard_map", {}).get(env["id"])
        if not shard_id:
            return
        shard = getattr(self, "daemon_shards", {}).get(shard_id)
        if shard is not None and env["id"] in shard.members:
            try:
                shard.sync_account_license(env)
            except OSError:
                pass

    def _load_runtime_policy(self):
        try:
            if self.policy_file.exists():
                raw = json.loads(read_root_file(self.policy_file, 32768))
                return normalize_runtime_policy(raw)
        except (OSError, RuntimeError, ValueError):
            pass
        return dict(DEFAULT_RUNTIME_POLICY)

    def _save_runtime_policy(self):
        private_json(self.policy_file, self.runtime_policy)

    def _use_sharded_daemon(self):
        # Each crag_subscription environment has its own per-environment /etc/machine-id
        # bound into its device.json and registration.code, while CragDaemonShard runs
        # inside a single shared bwrap rootfs without per-account /etc/machine-id
        # isolation. Always use per-account NativeSession pools under crag_subscription.
        if getattr(self, "payload_mode", None) == "crag_subscription":
            return False
        # The shard path is new in #1704 and has no pre-0.4.5 shape: its kernel config
        # carries the keys KERNEL_POLICY_FIELDS gates, and stripping them would hand an
        # older payload a config that parses but no longer describes the sharding the
        # host intends. Refuse the path instead and fall back to the per-account
        # NativeSession, which is the same fallback crag_subscription already takes.
        if kernel_policy_rejected_by_payload(getattr(self, "payload_version", None)):
            return False
        return (
            int(
                self.runtime_policy.get(
                    "accounts_per_daemon", DEFAULT_ACCOUNTS_PER_DAEMON
                )
            )
            > 1
        )

    def _shard_lock(self, shard_id):
        with self.lock:
            lock = self._shard_locks.get(shard_id)
            if lock is None:
                lock = threading.Lock()
                self._shard_locks[shard_id] = lock
            return lock

    def _shard_id_for_account(self, identifier):
        per_daemon = max(
            1,
            int(
                self.runtime_policy.get(
                    "accounts_per_daemon", DEFAULT_ACCOUNTS_PER_DAEMON
                )
            ),
        )
        existing = self._account_shard_map.get(identifier)
        if existing is not None:
            shard = self.daemon_shards.get(existing)
            if shard is None or len(shard.members) < per_daemon or identifier in shard.members:
                return existing
        oauth_ids = sorted(
            env_id
            for env_id, env in self.environments.items()
            if env.get("auth_method", "oauth") == "oauth"
        )
        try:
            rank = oauth_ids.index(identifier)
        except ValueError:
            rank = len(oauth_ids)
        shard_id = f"shard-{rank // per_daemon}"
        self._account_shard_map[identifier] = shard_id
        return shard_id

    def _is_shard_isolated(self, shard_id):
        meta = self._shard_faults.get(shard_id)
        if not meta:
            return False
        return time.monotonic() < meta.get("isolated_until", 0.0)

    def _record_shard_fault(self, shard_id):
        meta = self._shard_faults.setdefault(
            shard_id, {"failures": 0, "restarts": 0, "isolated_until": 0.0}
        )
        meta["failures"] += 1
        delay = min(
            SHARD_RESTART_BACKOFF_MAX,
            SHARD_RESTART_BACKOFF_MIN * (2 ** min(meta["failures"] - 1, 5)),
        )
        if self.runtime_policy.get("daemon_fault_isolation", True):
            meta["isolated_until"] = time.monotonic() + delay
        return meta

    def _clear_shard_fault(self, shard_id):
        meta = self._shard_faults.get(shard_id)
        if meta:
            meta["failures"] = 0
            meta["isolated_until"] = 0.0

    def _stop_shard(self, shard_id):
        shard = self.daemon_shards.pop(shard_id, None)
        if shard is not None:
            shard.close()

    def _remove_account_from_shard(self, identifier):
        shard_id = self._account_shard_map.pop(identifier, None)
        if shard_id is None:
            return
        shard = self.daemon_shards.get(shard_id)
        if shard is not None:
            try:
                shard.remove_account(identifier)
            except OSError:
                pass

    def apply_runtime_policy(self, raw_policy):
        if raw_policy is not None and not isinstance(raw_policy, dict):
            raise Failure(400)
        prev_per_daemon = int(
            self.runtime_policy.get("accounts_per_daemon", DEFAULT_ACCOUNTS_PER_DAEMON)
        )
        self.runtime_policy = normalize_runtime_policy(
            raw_policy, base=self.runtime_policy
        )
        self._save_runtime_policy()
        updated = 0
        total = 0
        for shard in list(self.daemon_shards.values()):
            total += 1
            if shard.apply_policy(self.runtime_policy):
                updated += 1
        for session in list(self.native_sessions.values()):
            total += 1
            if session.apply_policy(self.runtime_policy):
                updated += 1
        if (
            prev_per_daemon != self.runtime_policy["accounts_per_daemon"]
            and not self._use_sharded_daemon()
        ):
            for shard_id in list(self.daemon_shards):
                if not any(
                    self.active_infers.get(acc_id)
                    for acc_id in self.daemon_shards[shard_id].members
                ):
                    self._stop_shard(shard_id)
            self._account_shard_map.clear()
        return {
            "ok": True,
            "shards_updated": updated,
            "shards_total": total,
            "policy": dict(self.runtime_policy),
        }

    def daemon_status(self):
        shards = []
        total_accounts = 0
        total_active = 0
        total_idle = 0
        agg_shm = {
            "requests_total": 0,
            "responses_total": 0,
            "request_bytes_total": 0,
            "response_bytes_total": 0,
            "crc_errors_total": 0,
            "backpressure_waits_total": 0,
        }
        has_shm = False

        def _merge_shm(stats):
            nonlocal has_shm
            if not isinstance(stats, dict):
                return
            has_shm = True
            for key in agg_shm:
                val = stats.get(key)
                if isinstance(val, int) and val >= 0:
                    agg_shm[key] += val

        now_mono = time.monotonic()
        for shard_id, shard in sorted(self.daemon_shards.items()):
            fault = self._shard_faults.get(shard_id)
            fault_view = {
                "isolated": bool(fault and now_mono < fault.get("isolated_until", 0.0)),
                "restarts": fault.get("restarts", 0) if fault else 0,
            }
            view = shard.status_view(fault_meta=fault_view)
            shards.append(view)
            total_accounts += view["account_count"]
            total_active += view["active_slots"]
            total_idle += view["idle_slots"]
            _merge_shm(view.get("shm_ring_stats"))

        for env_id, session in sorted(self.native_sessions.items()):
            health = session.health(timeout=0.35) if session.is_alive() else None
            pool = (
                health.get("pool")
                if isinstance(health, dict) and isinstance(health.get("pool"), dict)
                else {}
            )
            shm_stats = pool.get("shm_ring_stats") or None
            _merge_shm(shm_stats)
            active_slots = int(pool.get("active_slots") or 0)
            idle_slots = int(pool.get("idle_slots") or 0)
            total_slots = int(pool.get("total_slots") or 0)
            shards.append(
                {
                    "shard_id": f"acct-{env_id[-8:]}",
                    "kind": "per_account",
                    "alive": session.is_alive(),
                    "ready": bool(isinstance(health, dict) and health.get("ready") is True),
                    "pid": session.native_tui.pid
                    if getattr(session, "native_tui", None) is not None
                    else None,
                    "capacity": 1,
                    "account_count": 1,
                    "account_ids": [env_id],
                    "active_slots": active_slots,
                    "idle_slots": idle_slots,
                    "total_slots": total_slots,
                    "circuit_open_accounts": int(pool.get("circuit_open_accounts") or 0),
                    "shm_enabled": bool(self.runtime_policy.get("require_shm", True)),
                    "shm_ring_stats": shm_stats,
                    "policy": pool.get("policy")
                    or runtime_policy_to_kernel_patch(self.runtime_policy),
                    "accounts": pool.get("accounts")
                    if isinstance(pool.get("accounts"), list)
                    else [],
                    "fault_isolated": False,
                    "restart_count": 0,
                }
            )
            total_accounts += 1
            total_active += active_slots
            total_idle += idle_slots

        oauth_envs = sum(
            1
            for env in self.environments.values()
            if env.get("auth_method", "oauth") == "oauth"
            and env.get("auth_state") == "authorized"
        )
        use_sharded = self._use_sharded_daemon()
        per_daemon = int(
            self.runtime_policy.get("accounts_per_daemon", DEFAULT_ACCOUNTS_PER_DAEMON)
        )
        effective_per_daemon = per_daemon if use_sharded else 1
        planned_shards = (
            (oauth_envs + effective_per_daemon - 1) // effective_per_daemon
            if oauth_envs > 0
            else 0
        )
        return {
            "mode": "sharded" if use_sharded else "per_account",
            "accounts_per_daemon": per_daemon,
            "daemon_fault_isolation": bool(
                self.runtime_policy.get("daemon_fault_isolation", True)
            ),
            "policy": dict(self.runtime_policy),
            "planned_shards": planned_shards,
            "authorized_oauth_accounts": oauth_envs,
            "total_accounts": total_accounts,
            "total_active_slots": total_active,
            "total_idle_slots": total_idle,
            "shm_ring_stats": agg_shm if has_shm else None,
            "shards": shards,
        }

    def daemon_action(self, body):
        action = body.get("action")
        if action == "restart_shard":
            shard_id = body.get("shard_id")
            if not isinstance(shard_id, str) or not SHARD_ID.fullmatch(shard_id):
                raise Failure(400)
            shard = self.daemon_shards.get(shard_id)
            if shard is not None:
                if any(self.active_infers.get(acc_id) for acc_id in shard.members):
                    raise Failure(409, "gemini_operation_busy")
                self._stop_shard(shard_id)
            meta = self._shard_faults.setdefault(
                shard_id, {"failures": 0, "restarts": 0, "isolated_until": 0.0}
            )
            meta["failures"] = 0
            meta["isolated_until"] = 0.0
            meta["restarts"] += 1
            return {"ok": True, "action": "restart_shard", "shard_id": shard_id}
        if action == "rebalance":
            restarted = 0
            for shard_id, shard in list(self.daemon_shards.items()):
                if any(self.active_infers.get(acc_id) for acc_id in shard.members):
                    continue
                self._stop_shard(shard_id)
                restarted += 1
            self._account_shard_map.clear()
            self._shard_faults.clear()
            return {"ok": True, "action": "rebalance", "restarted_shards": restarted}
        if action == "account_lifecycle":
            account_id = body.get("account_id")
            lifecycle_action = body.get("lifecycle_action")
            if (
                not isinstance(account_id, str)
                or account_id not in self.environments
                or lifecycle_action not in LIFECYCLE_ACTIONS
            ):
                raise Failure(400)
            shard_id = self._account_shard_map.get(account_id)
            shard = self.daemon_shards.get(shard_id) if shard_id else None
            if shard is not None and shard.is_alive():
                result = shard.account_lifecycle(account_id, lifecycle_action)
                if result is None:
                    raise Failure(503, "gemini_native_worker_unavailable")
                return {
                    "ok": True,
                    "action": "account_lifecycle",
                    "account_id": account_id,
                    "lifecycle_action": lifecycle_action,
                    "result": result,
                }
            session = self.native_sessions.get(account_id)
            if session is not None and session.is_alive():
                result = session.account_lifecycle(account_id, lifecycle_action)
                if result is None:
                    raise Failure(503, "gemini_native_worker_unavailable")
                return {
                    "ok": True,
                    "action": "account_lifecycle",
                    "account_id": account_id,
                    "lifecycle_action": lifecycle_action,
                    "result": result,
                }
            raise Failure(409, "gemini_native_worker_unavailable")
        raise Failure(400)

    def _acquire_shard_for_account(self, ctx):
        identifier = ctx["identifier"]
        egress_opts = normalize_egress_options(ctx.get("egress_options"))
        with self.lock:
            shard_id = self._shard_id_for_account(identifier)
            if self._is_shard_isolated(shard_id):
                return None, shard_id
        with self._shard_lock(shard_id):
            with self.lock:
                self._remember_runtime_proxy(ctx["env"], ctx["proxy_url"], egress_opts)
                if self._is_shard_isolated(shard_id):
                    return None, shard_id
                shard = self.daemon_shards.get(shard_id)
                if shard is not None and (
                    not shard.is_alive() or shard.is_severely_unhealthy()
                ):
                    self._stop_shard(shard_id)
                    shard = None
            try:
                if shard is None:
                    shard = CragDaemonShard(
                        self,
                        shard_id,
                        [
                            (
                                ctx["env"],
                                ctx["proxy_url"],
                                ctx["auth"],
                                ctx["model"],
                                egress_opts,
                            )
                        ],
                        policy=self.runtime_policy,
                    )
                    with self.lock:
                        self.daemon_shards[shard_id] = shard
                else:
                    shard.sync_account(
                        ctx["env"],
                        ctx["proxy_url"],
                        ctx["auth"],
                        model=ctx["model"],
                        egress_options=egress_opts,
                    )
                return shard, shard_id
            except (Failure, OSError, subprocess.SubprocessError):
                with self.lock:
                    self._stop_shard(shard_id)
                    self._record_shard_fault(shard_id)
                    if self.runtime_policy.get("daemon_fault_isolation", True):
                        return None, shard_id
                raise

    def spawn(self, fn):
        return self._spawner.call(fn)

    @staticmethod
    def is_crag_encrypted_payload(source):
        try:
            raw = read_root_file(source / "manifest.json", 65536)
            manifest = json.loads(raw)
        except (OSError, RuntimeError, ValueError):
            return False
        auth = manifest.get("authorization") if isinstance(manifest, dict) else None
        return (
            isinstance(manifest, dict)
            and manifest.get("family") == "crag"
            and manifest.get("encrypted") is True
            and isinstance(auth, dict)
            and auth.get("product") == "craggemini"
        )

    def verify_payload(self, source, public_key, install=False):
        check_root_owned(source)
        check_root_owned(public_key)
        members = (
            CRAG_PAYLOAD_FILES
            if self.is_crag_encrypted_payload(source)
            else PAYLOAD_FILES
        )
        for name in members:
            check_root_owned(source / name)
        output = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/install-gemini-payload.mjs"),
                "--source",
                str(source),
                "--public-key",
                str(public_key),
                *(["--dest", str(self.payload)] if install else ["--check"]),
            ],
            check=True,
            timeout=35,
            env=SYSTEM_ENV,
            capture_output=True,
            text=True,
        ).stdout
        version = re.fullmatch(
            r"Gemini payload ([a-zA-Z0-9.-]+) (?:verified|installed)\n", output
        )
        if not version:
            raise RuntimeError("Unexpected Gemini installer response")
        return version[1]

    def release_verifier(self, path, optional=False):
        try:
            return read_release_verifier(path)
        except FileNotFoundError:
            if optional:
                return None
            raise Failure(503, "gemini_release_not_configured") from None
        except (OSError, RuntimeError, ValueError, RecursionError):
            raise Failure(503, "gemini_release_invalid") from None

    def payload_config(self):
        installed = self.payload.exists() or self.payload.is_symlink()
        source = self.payload if installed else self.payload_source
        if source is None or not source.is_dir():
            raise Failure(503, "gemini_payload_source_missing")
        encrypted = self.is_crag_encrypted_payload(source)
        members = CRAG_PAYLOAD_FILES if encrypted else PAYLOAD_FILES
        if any(not (source / name).is_file() for name in members):
            raise Failure(503, "gemini_payload_incomplete")
        if installed and any(
            not os.access(source / name, os.X_OK) for name in ("agy", "craggemini")
        ):
            raise Failure(503, "gemini_payload_incomplete")
        digest = hashlib.sha256(
            read_root_file(source / "manifest.json", 65536 if encrypted else 8192)
        ).hexdigest()
        if encrypted:
            public_key = (
                self.public_key
                if self.public_key.is_file()
                else source / "crag-license-public.pem"
            )
            if not public_key.is_file():
                raise Failure(503, "gemini_public_key_missing")
            check_root_owned(public_key)
            self._payload_mode = "crag_subscription"
            return source, installed, public_key, None, digest
        default = (
            self.release_verifier(self.default_release)
            if self.default_release
            else None
        )
        # The shell pins the default verifier. A different manifest must never
        # be validated with the staged default key, even as a fallback.
        if default is not None and digest == default["manifest_sha256"]:
            public_key, verifier = self.default_public_key, default
        else:
            public_key = self.public_key
            verifier = self.release_verifier(
                self.manual_release, self.manual_release_optional
            )
            if verifier is not None:
                # Only a genuinely unconfigured legacy install is exempt.
                self.manual_release_optional = False
                if digest != verifier["manifest_sha256"]:
                    raise Failure(409, "gemini_release_payload_mismatch")
        if not public_key.is_file():
            raise Failure(503, "gemini_public_key_missing")
        check_root_owned(public_key)
        self._payload_mode = "legacy_release"
        return source, installed, public_key, verifier, digest

    def payload_identity(self, source, public_key, digest):
        members = (
            CRAG_PAYLOAD_FILES
            if self.is_crag_encrypted_payload(source)
            else PAYLOAD_FILES
        )
        # Hash large binaries only on first use or when a trusted input changes.
        files = (public_key, source, *(source / name for name in members))
        stats = (entry.lstat() for entry in files)
        identities = tuple(
            (
                s.st_dev,
                s.st_ino,
                s.st_mode,
                s.st_uid,
                s.st_size,
                s.st_ctime_ns,
                s.st_mtime_ns,
            )
            for s in stats
        )
        return (source, public_key, digest, identities)

    def release_activated(self, verifier):
        try:
            return read_release_verifier(self.activation) == verifier
        except (OSError, RuntimeError, ValueError, RecursionError):
            return False

    def _inspect_installed_agy(self):
        payload_dir = getattr(self, "payload", None)
        if payload_dir is None:
            return None, {
                "state": "missing",
                "arch": None,
                "offset": None,
                "gate": None,
                "error": "payload path unavailable",
            }
        agy_path = Path(payload_dir) / "agy"
        try:
            info = agy_path.lstat()
        except OSError:
            return None, {
                "state": "missing",
                "arch": None,
                "offset": None,
                "gate": None,
                "error": "file not found",
            }
        if not stat.S_ISREG(info.st_mode):
            return None, {
                "state": "unknown",
                "arch": None,
                "offset": None,
                "gate": None,
                "error": "not a regular file",
            }
        stat_key = (
            info.st_dev,
            info.st_ino,
            info.st_size,
            info.st_ctime_ns,
            info.st_mtime_ns,
        )
        cached = getattr(self, "_agy_inspect_cache", None)
        if cached is not None and cached[0] == stat_key:
            return cached[1], cached[2]
        patch_info = inspect_agy_patch(agy_path)
        try:
            digest = agy_file_sha256(agy_path)
        except (OSError, ValueError):
            digest = None
        self._agy_inspect_cache = (stat_key, digest, patch_info)
        return digest, patch_info

    def installed_agy_sha256(self):
        digest, _ = self._inspect_installed_agy()
        if isinstance(digest, str) and digest in AGY_ALLOWED_SHA256S:
            return digest
        return AGY_SHA256

    def agy_patch_status(self):
        _, patch_info = self._inspect_installed_agy()
        return patch_info

    def _log_agy_patch_status(self):
        _, patch_info = self._inspect_installed_agy()
        cache = getattr(self, "_agy_inspect_cache", None)
        log_key = (cache[0] if cache is not None else None, patch_info["state"])
        if getattr(self, "_agy_patch_logged_key", None) == log_key:
            return
        self._agy_patch_logged_key = log_key
        state = patch_info["state"]
        if state == "patched":
            print(
                f"Gemini agy CLI eligibility patch verified (patched @ 0x{patch_info['offset']:x})",
                file=sys.stderr,
            )
        elif state == "unpatched":
            print(
                "WARNING: Gemini agy CLI eligibility patch is NOT applied; run maintenance repair or prepare-gemini",
                file=sys.stderr,
            )
        elif state == "unknown":
            print(
                f"WARNING: Gemini agy CLI eligibility patch status unknown ({patch_info.get('error') or 'unrecognized binary'})",
                file=sys.stderr,
            )

    def load_payload(
        self, *, materialize=False, verify_again=False, legacy_install=False
    ):
        try:
            self._payload_mode = "legacy_release"
            source, installed, public_key, verifier, digest = self.payload_config()
            mode = self._payload_mode
            install = not installed and (
                materialize or (legacy_install and verifier is None)
            )
            version = None
            if installed or install:
                identity = self.payload_identity(source, public_key, digest)
                if install:
                    check_root_owned(self.payload.parent)
                cached = None if verify_again else self.verified_payload
                if not install and cached is not None and identity == cached[0]:
                    version = cached[1]
                else:
                    version = self.verify_payload(source, public_key, install=install)
                    if install:
                        target_digest = hashlib.sha256(
                            read_root_file(
                                self.payload / "manifest.json",
                                65536 if mode == "crag_subscription" else 8192,
                            )
                        ).hexdigest()
                        if target_digest != digest:
                            raise RuntimeError(
                                "Gemini manifest changed during installation"
                            )
                        identity = self.payload_identity(
                            self.payload, public_key, digest
                        )
                    elif (
                        self.payload_identity(source, public_key, digest) != identity
                    ):
                        raise RuntimeError("Gemini payload changed during verification")
                    self.verified_payload = (identity, version)
                self.payload_state = (
                    "installed"
                    if verifier is None or self.release_activated(verifier)
                    else "awaiting_redemption"
                )
            elif verifier is None:
                self.payload_state = "install_on_create"
            else:
                raise Failure(503, "gemini_payload_not_installed")
            self.payload_mode = mode
            self.set_payload_version(version)
            self.payload_issue = None
            if self.payload_state in ("installed", "awaiting_redemption"):
                self._log_agy_patch_status()
            return verifier
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            if self.payload_issue != "gemini_payload_invalid":
                print(
                    "Gemini payload installation or verification failed",
                    file=sys.stderr,
                )
            self.payload_failure("gemini_payload_invalid")
            raise Failure(503, "gemini_payload_invalid") from None
        except Failure as error:
            self.payload_failure(error.code)
            raise

    def payload_failure(self, code):
        self.payload_issue = code
        self.payload_state = (
            "not_configured"
            if code
            in (
                "gemini_payload_source_missing",
                "gemini_payload_incomplete",
                "gemini_public_key_missing",
                "gemini_payload_not_installed",
            )
            else "invalid"
        )
        self.set_payload_version(None)
        self.verified_payload = None

    def set_payload_version(self, version):
        if version != self.payload_version:
            self.last_inference.clear()
            self.payload_version = version

    def inspect_payload(self):
        try:
            self.load_payload()
        except Failure:
            pass  # Inventory remains available for diagnosis even if not usable.

    def ensure_payload(self, *, legacy_install=True):
        self.load_payload(legacy_install=legacy_install)
        if self.payload_state == "awaiting_redemption":
            raise Failure(403, "gemini_release_redemption_required")
        if self.payload_state != "installed":
            raise Failure(503, "gemini_payload_not_installed")

    def redeem_payload(self, code):
        if not isinstance(code, str) or not RELEASE_CODE.fullmatch(code):
            raise Failure(400, "gemini_release_code_invalid")
        verifier = self.load_payload()
        if verifier is None:
            raise Failure(503, "gemini_release_not_configured")
        if not hmac.compare_digest(
            hashlib.sha256(code.encode("ascii")).hexdigest(), verifier["code_sha256"]
        ):
            raise Failure(400, "gemini_release_code_invalid")
        private_json(self.activation, verifier)
        self.payload_state = "installed"
        return {"kernel_version": self.payload_version}

    def _run_sandbox_probe(self):
        if not shutil.which("setpriv", path=SYSTEM_ENV["PATH"]) or not _bwrap_tool_available():
            return "gemini_sandbox_unavailable"
        host_root = active_host_root()
        if managed_bwrap_required(host_root=host_root) and not managed_bwrap_entry_configured(
            host_root=host_root
        ):
            return "gemini_sandbox_apparmor_restricted"
        argv = _sandbox_probe_command(self.uid_base)
        try:
            rc, stderr_bytes = _run_bounded_probe(argv)
        except OSError:
            return "gemini_sandbox_unavailable"
        if rc == 0:
            return None
        if rc is not None and _apparmor_sandbox_evidence(stderr_bytes):
            return "gemini_sandbox_apparmor_restricted"
        return "gemini_sandbox_unavailable"

    def probe_sandbox(self, *, force=False):
        lock = getattr(self, "_sandbox_probe_lock", None)
        if lock is None:
            lock = threading.Lock()
            self._sandbox_probe_lock = lock
        with lock:
            cached = getattr(self, "_sandbox_probe_cache", None)
            now_mono = time.monotonic()
            if not force and cached is not None:
                checked_at, cached_issue = cached
                ttl = (
                    SANDBOX_PROBE_OK_TTL
                    if cached_issue is None
                    else SANDBOX_PROBE_FAIL_TTL
                )
                if now_mono - checked_at < ttl:
                    return cached_issue
            issue = self._run_sandbox_probe()
            self._sandbox_probe_cache = (time.monotonic(), issue)
            return issue

    def oauth_runtime_issue(self):
        if any(
            not shutil.which(tool, path=SYSTEM_ENV["PATH"])
            for tool in ("ip", "nft", "setpriv", "curl", "openvt")
        ) or not _bwrap_tool_available():
            return "gemini_oauth_tools_missing"
        try:
            check_root_owned(self.egress)
            if not self.egress.is_file() or not os.access(self.egress, os.X_OK):
                raise RuntimeError("Gemini egress helper is not executable")
        except (OSError, RuntimeError):
            return "gemini_egress_unavailable"
        try:
            if Path("/proc/sys/net/ipv4/ip_forward").read_text().strip() != "1":
                return "gemini_ipv4_forwarding_unavailable"
        except OSError:
            print("Gemini OAuth could not read IPv4 forwarding state", file=sys.stderr)
            return "gemini_ipv4_forwarding_unavailable"
        return self.probe_sandbox()

    def ensure_oauth_runtime(self, *, refresh_on_failure=False):
        self.ensure_payload()
        lock = getattr(self, "_sandbox_probe_lock", None)
        if lock is not None:
            with lock:
                cached = getattr(self, "_sandbox_probe_cache", None)
                if refresh_on_failure or (cached is not None and cached[1] is not None):
                    self._sandbox_probe_cache = None
        else:
            cached = getattr(self, "_sandbox_probe_cache", None)
            if refresh_on_failure or (cached is not None and cached[1] is not None):
                self._sandbox_probe_cache = None
        issue = self.oauth_runtime_issue()
        if issue:
            raise Failure(503, issue)

    def save(self):
        private_json(self.state_file, self.environments)

    def network(self, action, network, lock):
        argv = ["bash", str(ROOT / "scripts/gemini-host-egress.sh"), action, *network]
        # A timed-out setup must not leave e.g. a child nft/iptables mutating
        # network state after our cleanup. The helper retains the slot lock if
        # the daemon is killed while the setup transaction is still running.
        with subprocess.Popen(
            argv,
            env=SYSTEM_ENV,
            pass_fds=(lock,),
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ) as child:
            try:
                status = child.wait(timeout=12)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                raise
            if status:
                raise subprocess.CalledProcessError(status, argv)

    def network_paths(self, slot):
        runtime = Path("/run/vm2api-gemini-networks")
        runtime.mkdir(mode=0o700, exist_ok=True)
        check_root_owned(runtime)
        path = runtime / f"{self.network_scope}-{slot}"
        return path.with_suffix(".lock"), path.with_suffix(".json")

    def lock_network(self, slot):
        path, journal = self.network_paths(slot)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd, journal
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def namespace_identity(slot):
        try:
            info = Path(f"/run/netns/vm2agy{slot}").stat()
        except FileNotFoundError:
            return None
        return [info.st_dev, info.st_ino]

    @staticmethod
    def network_inventory(*argv):
        return subprocess.check_output(
            argv, timeout=3, env=SYSTEM_ENV, stderr=subprocess.DEVNULL
        )

    def start_network(self, directory, network):
        slot = network[0]
        prefix = f"vm2agy{slot}"
        self.recover_network(directory.parent, slot)
        lock, journal = self.lock_network(slot)
        try:
            # Check the same names as the existing setup helper *before*
            # recording an intent to create them. Never reclaim collisions.
            if (
                self.namespace_identity(slot) is not None
                or any(
                    row.get("ifname") == prefix + "h"
                    for row in json.loads(
                        self.network_inventory("ip", "-j", "link", "show")
                    )
                )
                or f"table inet {prefix}".encode()
                in self.network_inventory("nft", "list", "tables").splitlines()
                or (
                    shutil.which("iptables", path=SYSTEM_ENV["PATH"])
                    and any(
                        line in (f"-N VM2API-AGY-{slot}".encode(), f"-N VM2API-AGY-IN-{slot}".encode())
                        for line in self.network_inventory("iptables", "-w", "3", "-S").splitlines()
                    )
                )
            ):
                raise Failure(503)
            record = {
                "directory": str(directory),
                "uid": self.egress_uid,
                "namespace": None,
            }
            private_json(journal, record)
            try:
                self.network("start", network, lock)
                record["namespace"] = self.namespace_identity(slot)
                if record["namespace"] is None:
                    raise Failure(503)
                private_json(journal, record)
            except BaseException:
                self.stop_network(directory, network, lock)
                raise
            return lock
        except BaseException:
            os.close(lock)
            raise

    def stop_network(self, directory, network, lock):
        slot = network[0]
        _, journal = self.network_paths(slot)
        if not journal.exists():
            return
        record = json.loads(journal.read_bytes())
        if record["directory"] != str(directory) or record["uid"] != self.egress_uid:
            return
        bound = self.namespace_identity(slot)
        if record["namespace"] is None or bound is None or bound == record["namespace"]:
            self.network("stop", network, lock)
        journal.unlink()

    def recover_network(self, env_dir, slot):
        _, journal = self.network_paths(slot)
        try:
            if Path(json.loads(journal.read_bytes())["directory"]).parent != env_dir:
                return
        except FileNotFoundError:
            return
        lock, journal = self.lock_network(slot)
        try:
            if journal.exists():
                directory = Path(json.loads(journal.read_bytes())["directory"])
                if directory.parent == env_dir:
                    self.stop_network(
                        directory,
                        [str(slot), str(self.egress_uid), "192.0.2.1", "1080"],
                        lock,
                    )
        finally:
            os.close(lock)

    def cancel(self, identifier):
        if identifier in self.pending:
            self.pending[identifier].close()
            del self.pending[identifier]

    def stop_terminal(self, identifier):
        terminal = self.terminals.pop(identifier, None)
        if terminal:
            terminal.close()
            self._schedule_warm_locked(identifier, force=True)

    def _host_egress_argv(self):
        return [
            "setpriv",
            "--reuid",
            str(self.egress_uid),
            "--regid",
            str(self.egress_uid),
            "--clear-groups",
            "--no-new-privs",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--bounding-set=-all",
        ]

    def _start_egress_relay(self, gateway, guest, relay_port, target_host, target_port):
        spawn = getattr(self, "spawn", lambda fn: fn())
        relay = spawn(
            lambda: subprocess.Popen(
                self._host_egress_argv()
                + [
                    sys.executable,
                    "-I",
                    "-c",
                    RELAY_EXEC,
                    str(os.getpid()),
                    gateway,
                    str(relay_port),
                    guest,
                    target_host,
                    str(target_port),
                ],
                env=SYSTEM_ENV,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )
        deadline = time.monotonic() + 3
        while relay.poll() is None and time.monotonic() < deadline:
            if host_tcp_listening(gateway, relay_port, self.egress_uid):
                return relay
            time.sleep(0.05)
        if relay.poll() is None:
            relay.kill()
        try:
            relay.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        raise Failure(503, stage="relay_start")

    def _probe_egress_target(
        self, target_host, target_port, relay_gateway, relay_port, launch_args_fn
    ):
        target_probe_code = (
            "import ipaddress, socket, sys\n"
            "host, port = sys.argv[1], int(sys.argv[2])\n"
            "def ok(ip):\n"
            "    a = ipaddress.IPv4Address(ip)\n"
            "    return not (a.is_loopback or a.is_unspecified or a.is_multicast "
            "or a.is_link_local or a == ipaddress.IPv4Address('255.255.255.255'))\n"
            "infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)\n"
            "ips = [s[0] for *_, s in infos if s]\n"
            "if not ips or not all(ok(ip) for ip in ips):\n"
            "    raise SystemExit(2)\n"
            "socket.create_connection((ips[0], port), 4).close()\n"
        )
        relay_probe_code = (
            "import socket,sys; "
            "socket.create_connection((sys.argv[1], int(sys.argv[2])), 3).close()"
        )
        # 1. Verify the bound proxy is reachable via host OUTPUT (traversing any
        #    host transparent proxy front-hop, matching existing sidecar behavior).
        subprocess.run(
            self._host_egress_argv()
            + [sys.executable, "-I", "-c", target_probe_code, target_host, str(target_port)],
            check=True,
            timeout=6,
            env=SYSTEM_ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # 2. Verify the isolated netns reaches the host relay on the slot gateway.
        subprocess.run(
            launch_args_fn(self.egress_uid)
            + [sys.executable, "-I", "-c", relay_probe_code, relay_gateway, str(relay_port)],
            check=True,
            timeout=5,
            env=SYSTEM_ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def acquire_slot_network(
        self,
        slot,
        env_dir,
        network,
        proxy_id,
        proxy_url,
        proxy_hash,
        launch_args_fn,
        *,
        egress_options=None,
    ):
        lease_lock = getattr(self, "_network_lease_lock", None)
        if lease_lock is None:
            lease_lock = threading.Lock()
            self._network_lease_lock = lease_lock
        leases = getattr(self, "_slot_networks", None)
        if leases is None:
            leases = {}
            self._slot_networks = leases
        opts = normalize_egress_options(egress_options)
        egress_key = egress_fingerprint(proxy_url, opts)
        with lease_lock:
            existing = leases.get(slot)
            if existing is not None:
                relay_alive = (
                    existing.get("relay") is None or existing["relay"].poll() is None
                )
                if (
                    existing["egress"].poll() is None
                    and relay_alive
                    and secrets.compare_digest(
                        existing.get("egress_key", existing["proxy_hash"]), egress_key
                    )
                ):
                    existing["refcount"] += 1
                    return existing
                if existing["refcount"] <= 0:
                    leases.pop(slot, None)
                    self._teardown_slot_network_lease(existing)
                else:
                    raise Failure(503, stage="network_prepare")
            lease_dir = env_dir / f".net-{secrets.token_hex(8)}"
            lease_dir.mkdir(mode=0o711)
            lease_dir.chmod(0o711)
            env_dir.chmod(0o711)
            lock = None
            relay = None
            egress = None
            gateway, guest = slot_network_addrs(slot)
            relay_port = pick_free_relay_port()
            target_host, target_port = network[2], network[3]
            relay_network = [str(slot), str(self.egress_uid), gateway, str(relay_port)]
            relay_proxy_url = rewrite_proxy_endpoint(proxy_url, gateway, relay_port)
            try:
                config = lease_dir / "egress.json"
                private_json(
                    config,
                    {
                        "proxy_id": proxy_id,
                        "proxy_url": relay_proxy_url,
                        "listen_tcp": "127.0.0.1:1080",
                        "listen_dns": "127.0.0.1:1053",
                        **opts,
                    },
                )
                os.chown(config, self.egress_uid, self.egress_uid)
                try:
                    lock = self.start_network(lease_dir, relay_network)
                except Failure as err:
                    raise Failure(err.status, err.code, stage=err.stage or "network_prepare") from err
                except (OSError, subprocess.SubprocessError) as err:
                    raise Failure(503, stage="network_prepare") from err
                try:
                    relay = self._start_egress_relay(
                        gateway, guest, relay_port, target_host, target_port
                    )
                except Failure as err:
                    raise Failure(err.status, err.code, stage=err.stage or "relay_start") from err
                except (OSError, subprocess.SubprocessError) as err:
                    raise Failure(503, stage="relay_start") from err
                try:
                    self._probe_egress_target(
                        target_host, target_port, gateway, relay_port, launch_args_fn
                    )
                except Failure as err:
                    raise Failure(err.status, err.code, stage=err.stage or "proxy_probe") from err
                except (OSError, subprocess.SubprocessError) as err:
                    raise Failure(503, stage="proxy_probe") from err
                try:
                    spawn = getattr(self, "spawn", lambda fn: fn())
                    egress = spawn(
                        lambda: subprocess.Popen(
                            launch_args_fn(self.egress_uid)
                            + [
                                sys.executable,
                                "-I",
                                "-c",
                                EGRESS_EXEC,
                                str(os.getpid()),
                                str(self.egress),
                                "--config",
                                str(config),
                            ],
                            env=SYSTEM_ENV,
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                    )
                    deadline = time.monotonic() + 3
                    probe = launch_args_fn(self.egress_uid) + [
                        sys.executable,
                        "-I",
                        "-c",
                        EGRESS_READY,
                        str(self.egress_uid),
                    ]
                    while egress.poll() is None and time.monotonic() < deadline:
                        result = subprocess.run(
                            probe,
                            timeout=1,
                            env=SYSTEM_ENV,
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        if result.returncode == 0 and egress.poll() is None:
                            break
                        time.sleep(0.05)
                    else:
                        raise Failure(503, stage="egress_start")
                except Failure as err:
                    raise Failure(err.status, err.code, stage=err.stage or "egress_start") from err
                except (OSError, subprocess.SubprocessError) as err:
                    raise Failure(503, stage="egress_start") from err
                lease = {
                    "slot": slot,
                    "directory": lease_dir,
                    "network": list(relay_network),
                    "proxy_hash": proxy_hash,
                    "egress_key": egress_key,
                    "lock": lock,
                    "relay": relay,
                    "egress": egress,
                    "refcount": 1,
                }
                leases[slot] = lease
                return lease
            except BaseException:
                if egress is not None:
                    if egress.poll() is None:
                        egress.kill()
                    try:
                        egress.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                if relay is not None:
                    if relay.poll() is None:
                        relay.kill()
                    try:
                        relay.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                if lock is not None:
                    try:
                        self.stop_network(lease_dir, relay_network, lock)
                    finally:
                        os.close(lock)
                shutil.rmtree(lease_dir, ignore_errors=True)
                raise

    def release_slot_network(self, slot, lease):
        if lease is None:
            return
        lease_lock = getattr(self, "_network_lease_lock", None)
        leases = getattr(self, "_slot_networks", None)
        if lease_lock is None or leases is None:
            self._teardown_slot_network_lease(lease)
            return
        with lease_lock:
            lease["refcount"] -= 1
            if lease["refcount"] > 0:
                return
            if leases.get(slot) is lease:
                leases.pop(slot, None)
        self._teardown_slot_network_lease(lease)

    def _teardown_slot_network_lease(self, lease):
        egress = lease.get("egress")
        if egress is not None:
            if egress.poll() is None:
                egress.kill()
            try:
                egress.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            lease["egress"] = None
        relay = lease.get("relay")
        if relay is not None:
            if relay.poll() is None:
                relay.kill()
            try:
                relay.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            lease["relay"] = None
        lock = lease.get("lock")
        if lock is not None:
            try:
                self.stop_network(lease["directory"], lease["network"], lock)
            finally:
                os.close(lock)
                lease["lock"] = None
        lease_dir = lease.get("directory")
        if lease_dir is not None:
            shutil.rmtree(lease_dir, ignore_errors=True)

    def _remember_runtime_proxy(self, env, proxy_url, egress_options=None):
        if not env or not isinstance(proxy_url, str) or not proxy_url:
            return
        proxies = getattr(self, "_runtime_proxies", None)
        if proxies is None:
            proxies = {}
            self._runtime_proxies = proxies
        opts = normalize_egress_options(egress_options)
        proxies[env["id"]] = (
            env["proxy_id"],
            proxy_url,
            egress_fingerprint(proxy_url, opts),
            opts,
        )

    def _runtime_proxy_entry(self, identifier):
        cached = getattr(self, "_runtime_proxies", {}).get(identifier)
        if not cached:
            return None
        if len(cached) >= 4:
            return cached[0], cached[1], cached[2], cached[3]
        return cached[0], cached[1], cached[2], {}

    def _clear_runtime_proxy(self, identifier):
        proxies = getattr(self, "_runtime_proxies", None)
        if proxies is not None:
            proxies.pop(identifier, None)
        backoff = getattr(self, "_warm_backoff", None)
        if backoff is not None:
            backoff.pop(identifier, None)

    def _can_keep_resident(self, env):
        if not env or env.get("auth_method", "oauth") != "oauth":
            return False
        if env.get("auth_state") != "authorized" or env.get("oauth_imported"):
            return False
        if not env.get("profile"):
            return False
        if (env.get("account") or {}).get("eligibility") in BLOCKING_ACCOUNT_ELIGIBILITIES:
            return False
        identifier = env["id"]
        if identifier in self.terminals or identifier in self.pending:
            return False
        if getattr(self, "payload_state", None) != "installed" or self.oauth_runtime_issue() is not None:
            return False
        if self.payload_mode == "crag_subscription":
            candidate = self.license_release_candidate(env)
            if not candidate.get("permit_sha256"):
                return False
        return True

    @staticmethod
    def _initial_session_model(env, requested_model=None):
        if isinstance(requested_model, str) and MODEL.fullmatch(requested_model):
            return requested_model
        for candidate in env.get("call_models") or ():
            if isinstance(candidate, str) and MODEL.fullmatch(candidate):
                return candidate
        return NATIVE_DEFAULT_MODEL

    def _schedule_warm_locked(self, identifier, model=None, force=False):
        env = self.environments.get(identifier)
        if not self._can_keep_resident(env):
            return False
        cached = self._runtime_proxy_entry(identifier)
        if not cached or cached[0] != env["proxy_id"]:
            return False
        _, _, egress_key, _ = cached
        existing = self.native_sessions.get(identifier)
        if (
            existing is not None
            and getattr(existing, "max_concurrency", 1) == env_concurrency(env)
            and secrets.compare_digest(_session_egress_key(existing), egress_key)
            and existing.is_alive()
            and not existing.is_severely_unhealthy()
        ):
            return False
        warming = getattr(self, "_warming", None)
        if warming is None:
            warming = set()
            self._warming = warming
        if identifier in warming:
            return False
        backoff = getattr(self, "_warm_backoff", None)
        if backoff is None:
            backoff = {}
            self._warm_backoff = backoff
        if not force:
            entry = backoff.get(identifier)
            if entry and time.monotonic() < entry[1]:
                return False
        warming.add(identifier)
        worker = threading.Thread(
            target=self._warm_worker,
            args=(identifier, model),
            name=f"gemini-warm-{identifier[-8:]}",
            daemon=True,
        )
        worker.start()
        return True

    def _record_warm_failure_locked(self, identifier):
        backoff = getattr(self, "_warm_backoff", None)
        if backoff is None:
            backoff = {}
            self._warm_backoff = backoff
        fails = backoff.get(identifier, (0, 0.0))[0] + 1
        delay = min(
            NATIVE_WARM_BACKOFF_MAX,
            NATIVE_WARM_BACKOFF_MIN * (2 ** min(fails - 1, 5)),
        )
        backoff[identifier] = (fails, time.monotonic() + delay)
        return fails, delay

    def _schedule_reauth_check_locked(self, identifier):
        env = self.environments.get(identifier)
        if (
            not env
            or env.get("auth_method", "oauth") != "oauth"
            or env.get("oauth_imported")
            or env.get("auth_state") != "authorized"
            or not env.get("profile")
        ):
            return False
        cached = self._runtime_proxy_entry(identifier)
        if not cached or cached[0] != env["proxy_id"]:
            return False
        proxy_url, egress_opts = cached[1], cached[3]
        health = self._profile_credential_health(env, skew_seconds=0)
        if not health or health.get("state") not in (
            "expired_refreshable",
            "expired",
            "missing",
        ):
            return False
        checking = getattr(self, "_reauth_checking", None)
        if checking is None:
            checking = set()
            self._reauth_checking = checking
        if identifier in checking:
            return False
        cooldowns = getattr(self, "_reauth_check_next_at", None)
        if cooldowns is None:
            cooldowns = {}
            self._reauth_check_next_at = cooldowns
        now_mono = time.monotonic()
        if now_mono < cooldowns.get(identifier, 0.0):
            return False
        checking.add(identifier)
        cooldowns[identifier] = now_mono + 120.0

        def _worker():
            try:
                with self.lock:
                    cur = self.environments.get(identifier)
                    if not cur or cur.get("auth_state") != "authorized":
                        return
                self.refresh_account(
                    cur,
                    proxy_url,
                    auto_pull_models=False,
                    **({"egress_options": egress_opts} if egress_opts else {}),
                )
            except Exception as exc:
                detail = (
                    f"{exc.status} {exc.code}"
                    if isinstance(exc, Failure) and exc.code
                    else str(exc.status)
                    if isinstance(exc, Failure)
                    else str(exc)
                )
                if proxy_url and proxy_url in detail:
                    detail = detail.replace(proxy_url, "[redacted]")
                detail = " ".join(detail.splitlines()).strip()
                err = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
                print(
                    f"Gemini re-auth check failed env={identifier} error={err}",
                    file=sys.stderr,
                )
            finally:
                with self.lock:
                    getattr(self, "_reauth_checking", set()).discard(identifier)

        threading.Thread(
            target=_worker, name=f"gemini-reauth-{identifier[-8:]}", daemon=True
        ).start()
        return True

    def _warm_worker(self, identifier, model=None):
        try:
            with self._session_lock(identifier):
                with self.lock:
                    env = self.environments.get(identifier)
                    if not self._can_keep_resident(env):
                        return
                    cached = self._runtime_proxy_entry(identifier)
                    if not cached or cached[0] != env["proxy_id"]:
                        return
                    proxy_id, proxy_url, egress_key, egress_opts = cached
                    existing = self.native_sessions.get(identifier)
                    desired_concurrency = env_concurrency(env)
                    if (
                        existing is not None
                        and getattr(existing, "max_concurrency", 1) == desired_concurrency
                        and secrets.compare_digest(_session_egress_key(existing), egress_key)
                        and existing.is_alive()
                        and not existing.is_severely_unhealthy()
                    ):
                        return
                    uid = self.env_uid(env)
                    profile = env.get("profile")
                    auth = profile and profile_secrets(
                        self.directory / identifier / profile, uid, include_raw=True
                    )
                    if not auth:
                        return
                    env_snapshot = dict(env)
                    initial_model = self._initial_session_model(env_snapshot, model)
                    if existing is not None and not self.active_infers.get(identifier):
                        self.stop_native_session(identifier)
                session = NativeSession(
                    self,
                    env_snapshot,
                    proxy_url,
                    auth,
                    initial_model,
                    **({"egress_options": egress_opts} if egress_opts else {}),
                )
                keep = False
                try:
                    with self.lock:
                        current_env = self.environments.get(identifier)
                        current_cached = self._runtime_proxy_entry(identifier)
                        already = self.native_sessions.get(identifier)
                        if (
                            current_env is not None
                            and self._can_keep_resident(current_env)
                            and current_env["proxy_id"] == proxy_id
                            and current_cached is not None
                            and secrets.compare_digest(current_cached[2], egress_key)
                            and env_concurrency(current_env) == desired_concurrency
                            and (already is None or not already.is_alive())
                        ):
                            if already is not None:
                                self.stop_native_session(identifier)
                            self.native_sessions[identifier] = session
                            keep = True
                finally:
                    if not keep:
                        session.close()
        except BaseException:
            with self.lock:
                self._record_warm_failure_locked(identifier)
        finally:
            with self.lock:
                getattr(self, "_warming", set()).discard(identifier)

    def _schedule_provision_locked(self, identifier, proxy_url, egress_options=None):
        env = self.environments.get(identifier)
        if (
            not env
            or env.get("auth_method", "oauth") != "oauth"
            or env.get("oauth_imported")
            or env.get("auth_state") != "authorized"
            or not env.get("profile")
            or self.egress is None
            or self.oauth_runtime_issue() is not None
        ):
            return False
        has_models = bool(env.get("call_models"))
        has_plan = isinstance(env.get("account"), dict) and bool(env["account"].get("plan"))
        if has_models and has_plan:
            return False
        provisioning = getattr(self, "_provisioning", None)
        if provisioning is None:
            provisioning = set()
            self._provisioning = provisioning
        if identifier in provisioning:
            return False
        cooldowns = getattr(self, "_provision_next_at", None)
        if cooldowns is None:
            cooldowns = {}
            self._provision_next_at = cooldowns
        now = time.monotonic()
        if now < cooldowns.get(identifier, 0.0):
            return False
        provisioning.add(identifier)
        cooldowns[identifier] = now + (300.0 if has_models else 60.0)
        opts = normalize_egress_options(egress_options)
        worker = threading.Thread(
            target=self._provision_worker,
            args=(identifier, proxy_url, opts),
            name=f"gemini-prov-{identifier[-8:]}",
            daemon=True,
        )
        worker.start()
        return True

    def _provision_worker(self, identifier, proxy_url, egress_options=None):
        try:
            with self.lock:
                env = self.environments.get(identifier)
                if (
                    not env
                    or env.get("auth_method", "oauth") != "oauth"
                    or env.get("oauth_imported")
                    or env.get("auth_state") != "authorized"
                    or not env.get("profile")
                ):
                    return
                if env.get("call_models") and isinstance(env.get("account"), dict) and env["account"].get("plan"):
                    return
                self._post_auth_provision(
                    env,
                    proxy_url,
                    **({"egress_options": egress_options} if egress_options else {}),
                )
        except BaseException:
            pass
        finally:
            with self.lock:
                getattr(self, "_provisioning", set()).discard(identifier)

    def _clear_eligibility_on_inference_success_locked(self, identifier):
        env = self.environments.get(identifier)
        if not env:
            return False
        account = env.get("account")
        if not isinstance(account, dict):
            return False
        had_blocking = (
            account.get("eligibility") in BLOCKING_ACCOUNT_ELIGIBILITIES
            or "validation_url" in account
        )
        if not had_blocking:
            return False
        account.pop("eligibility", None)
        account.pop("validation_url", None)
        ts = now()
        account["checked_at"] = ts
        account["eligibility_verified_at"] = ts
        if account.get("state") not in ("ok", "partial"):
            account["state"] = "ok"
        # Persist without invalidating last_inference binding (do not mutate updated_at).
        private_json(self.state_file, self.environments)
        self._schedule_warm_locked(identifier, force=True)
        return True

    def _clear_eligibility_verified_on_failure_locked(self, identifier, error_code):
        if error_code not in (
            "gemini_account_verification_required",
            "gemini_location_unsupported",
            "gemini_client_unsupported",
            "gemini_account_ineligible",
        ):
            return
        env = self.environments.get(identifier)
        account = env.get("account") if isinstance(env, dict) else None
        if not isinstance(account, dict):
            return
        mapped = {
            "gemini_account_verification_required": "verification_required",
            "gemini_location_unsupported": "location_unsupported",
            "gemini_client_unsupported": "client_unsupported",
            "gemini_account_ineligible": "ineligible",
        }[error_code]
        account.pop("eligibility_verified_at", None)
        account["eligibility"] = mapped
        account["checked_at"] = now()
        private_json(self.state_file, self.environments)

    def _probe_eligibility_via_inference(
        self, env_snapshot, proxy_url, auth, model, *, egress_options=None
    ):
        identifier = env_snapshot["id"]
        request_id = f"elig-{secrets.token_hex(8)}"
        ctx = {
            "identifier": identifier,
            "env": env_snapshot,
            "proxy_url": proxy_url,
            "egress_options": normalize_egress_options(egress_options),
            "auth": auth,
            "model": model,
            "request_id": request_id,
            "native_body": {
                "model": model,
                "contents": [{"role": "user", "parts": [{"text": "ping"}]}],
            },
        }
        conn = None
        try:
            session = self._acquire_native_session(ctx)
            conn, response = session.open_stream(
                request_id, ctx["native_body"], model=model
            )
            frames = []
            pending = bytearray()
            total = 0
            while True:
                chunk = response.read1(16384)
                if not chunk:
                    break
                total += len(chunk)
                if total > native_module().MAX_SSE:
                    return False, "gemini_inference_output_limit"
                pending.extend(chunk)
                while True:
                    b_lf = pending.find(b"\n\n")
                    b_crlf = pending.find(b"\r\n\r\n")
                    if b_crlf >= 0 and (b_lf < 0 or b_crlf < b_lf):
                        boundary, width = b_crlf, 4
                    elif b_lf >= 0:
                        boundary, width = b_lf, 2
                    else:
                        break
                    frames.append(bytes(pending[: boundary + width]))
                    del pending[: boundary + width]
            native_module().parse_sse(frames)
            return True, None
        except native_module().NativeFailure as err:
            return False, err.code
        except (Failure, OSError, TimeoutError, ValueError):
            return False, "gemini_inference_failed"
        finally:
            if conn is not None:
                try:
                    conn.close()
                except OSError:
                    pass

    def _schedule_eligibility_probe_locked(self, identifier):
        interval = int(
            self.runtime_policy.get(
                "eligibility_probe_interval_secs", int(ELIGIBILITY_PROBE_INTERVAL)
            )
        )
        if interval <= 0:
            return False
        env = self.environments.get(identifier)
        if (
            not env
            or env.get("auth_method", "oauth") != "oauth"
            or env.get("oauth_imported")
            or env.get("auth_state") != "authorized"
            or not env.get("profile")
        ):
            return False
        eligibility = (env.get("account") or {}).get("eligibility")
        if eligibility not in BLOCKING_ACCOUNT_ELIGIBILITIES:
            return False
        cached = self._runtime_proxy_entry(identifier)
        if not cached or cached[0] != env["proxy_id"]:
            return False
        proxy_url, egress_opts = cached[1], cached[3]
        probing = getattr(self, "_eligibility_probing", None)
        if probing is None:
            probing = set()
            self._eligibility_probing = probing
        if identifier in probing:
            return False
        cooldowns = getattr(self, "_eligibility_probe_next_at", None)
        if cooldowns is None:
            cooldowns = {}
            self._eligibility_probe_next_at = cooldowns
        now_mono = time.monotonic()
        if now_mono < cooldowns.get(identifier, 0.0):
            return False
        probing.add(identifier)
        cooldowns[identifier] = now_mono + float(interval)

        def _worker():
            try:
                with self.lock:
                    cur = self.environments.get(identifier)
                    if (
                        not cur
                        or cur.get("auth_state") != "authorized"
                        or self.running(identifier)
                        or identifier in self.terminals
                        or identifier in self.pending
                    ):
                        return
                    target_env = cur
                # First refresh upstream account metadata (loadCodeAssist).
                self.refresh_account(
                    target_env,
                    proxy_url,
                    auto_pull_models=False,
                    **({"egress_options": egress_opts} if egress_opts else {}),
                )
                # If still marked blocked (e.g. stale loadCodeAssist VALIDATION_REQUIRED),
                # run a real inference probe when runtime is ready; if inference succeeds, clear the warning.
                with self.lock:
                    cur = self.environments.get(identifier)
                    if (
                        not cur
                        or cur.get("auth_state") != "authorized"
                        or (cur.get("account") or {}).get("eligibility")
                        not in BLOCKING_ACCOUNT_ELIGIBILITIES
                        or not cur.get("call_models")
                        or self.running(identifier)
                        or identifier in self.terminals
                        or identifier in self.pending
                        or getattr(self, "payload_state", None) != "installed"
                        or self.oauth_runtime_issue() is not None
                    ):
                        return
                    uid = self.env_uid(cur)
                    profile = cur.get("profile")
                    auth = profile and profile_secrets(
                        self.directory / identifier / profile, uid, include_raw=True
                    )
                    if not auth:
                        return
                    env_snapshot = dict(cur)
                    probe_model = self._initial_session_model(env_snapshot)
                ok, err_code = self._probe_eligibility_via_inference(
                    env_snapshot,
                    proxy_url,
                    auth,
                    probe_model,
                    **({"egress_options": egress_opts} if egress_opts else {}),
                )
                if ok:
                    with self.lock:
                        cur = self.environments.get(identifier)
                        if cur and cur.get("auth_state") == "authorized":
                            ts = now()
                            self.last_inference[identifier] = (
                                self.inference_binding(cur),
                                {
                                    "state": "completed",
                                    "model": probe_model,
                                    "started_at": ts,
                                    "finished_at": ts,
                                    "error_code": None,
                                },
                                hashlib.sha256(proxy_url.encode()).hexdigest(),
                            )
                            self._clear_eligibility_on_inference_success_locked(
                                identifier
                            )
                elif err_code in (
                    "gemini_account_verification_required",
                    "gemini_location_unsupported",
                    "gemini_client_unsupported",
                    "gemini_account_ineligible",
                ):
                    with self.lock:
                        self._clear_eligibility_verified_on_failure_locked(
                            identifier, err_code
                        )
            except BaseException:
                pass
            finally:
                with self.lock:
                    getattr(self, "_eligibility_probing", set()).discard(identifier)

        threading.Thread(
            target=_worker, name=f"gemini-elig-{identifier[-8:]}", daemon=True
        ).start()
        return True

    def warm_environment(self, env, proxy_url, model=None, *, egress_options=None):
        identifier = env["id"]
        opts = normalize_egress_options(egress_options)
        self._remember_runtime_proxy(env, proxy_url, opts)
        self._schedule_provision_locked(identifier, proxy_url, opts)
        self._schedule_eligibility_probe_locked(identifier)
        egress_key = egress_fingerprint(proxy_url, opts)
        existing = self.native_sessions.get(identifier)
        if existing is not None:
            same_binding = (
                getattr(existing, "max_concurrency", 1) == env_concurrency(env)
                and secrets.compare_digest(_session_egress_key(existing), egress_key)
            )
            if not same_binding and not self.active_infers.get(identifier):
                self.stop_native_session(identifier)
                existing = None
            elif same_binding and existing.is_alive() and not existing.is_severely_unhealthy():
                ready = bool(existing.is_ready(timeout=0.5))
                return {"warmed": ready, "runtime_ready": ready, "warming": not ready}
        scheduled = self._schedule_warm_locked(identifier, model=model, force=True)
        return {
            "warmed": False,
            "runtime_ready": False,
            "warming": scheduled or (identifier in getattr(self, "_warming", set())),
        }

    def inference_binding(self, env):
        return (
            env["proxy_id"],
            env.get("profile"),
            env.get("auth_method", "oauth"),
            env.get("oauth_imported", False),
            env["auth_state"],
            env.get("updated_at"),
            self.payload_version,
        )

    def last_inference_view(self, env):
        entry = self.last_inference.get(env["id"])
        if entry and entry[0] == self.inference_binding(env):
            return {
                "last_inference": entry[1].copy(),
                "last_inference_proxy_sha256": entry[2],
            }
        return {"last_inference": None}

    @staticmethod
    def finish_inference(evidence, state, code=None):
        if state == "failed" and code == "gemini_inference_cancelled":
            state = "cancelled"
        evidence.update(
            state=state,
            finished_at=now(),
            error_code=(
                code
                if isinstance(code, str) and code in INFERENCE_ERROR_CODES
                else None
            ),
        )

    def touch_environment(self, env):
        # Explicit invalidation also handles multiple mutations in one second.
        self.last_inference.pop(env["id"], None)
        env["updated_at"] = now()

    def _session_lock(self, identifier):
        with self.lock:
            locks = getattr(self, "_session_locks", None)
            if locks is None:
                locks = {}
                self._session_locks = locks
            lock = locks.get(identifier)
            if lock is None:
                lock = threading.Lock()
                locks[identifier] = lock
            return lock

    def stop_native_session(self, identifier):
        session = self.native_sessions.pop(identifier, None)
        if session is not None:
            session.close()

    def cancel_infer(self, identifier, request_id=None):
        slots = self.active_infers.get(identifier)
        if not slots:
            return False
        if request_id is not None:
            entry = slots.get(request_id)
            if not entry:
                return False
            targets = [entry]
        else:
            targets = list(slots.values())
        for entry in targets:
            entry["cancel_event"].set()
            cancel_fn = entry.get("cancel_fn")
            if callable(cancel_fn):
                try:
                    cancel_fn()
                except Exception:
                    pass
        return bool(targets)

    def stop_run(self, identifier):
        entry = self.runs.pop(identifier, None)
        if entry and entry["process"] is not None:
            self.finish_inference(
                entry["evidence"], "cancelled", "gemini_inference_cancelled"
            )
            entry["process"].close()

    def running(self, identifier):
        if self.active_infers.get(identifier):
            return True
        entry = self.runs.get(identifier)
        return bool(entry and entry["process"] is not None)

    def update_run(self, entry):
        if entry["process"] is None:
            return entry["result"]
        result = entry["process"].poll()
        if result["state"] != "running" or time.monotonic() >= entry["deadline"]:
            result = (
                result
                if result["state"] != "running"
                else {
                    "state": "failed",
                    "text": "",
                    "error": {
                        "code": "gemini_inference_timeout",
                        "message": "Gemini request timed out",
                    },
                }
            )
            error = result.get("error") if result["state"] == "failed" else None
            self.finish_inference(
                entry["evidence"],
                result["state"],
                error.get("code") if isinstance(error, dict) else None,
            )
            if result["state"] == "completed":
                for env_id, item in self.runs.items():
                    if item is entry:
                        self._clear_eligibility_on_inference_success_locked(env_id)
                        break
            entry["process"].close()
            entry["process"] = None
            entry["result"] = result
            entry["deadline"] = time.monotonic() + RUN_TTL
            return entry["result"]
        return result

    def operation_account(
        self, env, *, allow_concurrent_infer=False, allow_reauth_probe=False
    ):
        self.ensure_payload(legacy_install=False)
        allowed_states = (
            ("authorized", "reauth_required")
            if allow_reauth_probe
            else ("authorized",)
        )
        if env["auth_state"] not in allowed_states:
            code = (
                "gemini_api_key_invalid"
                if env.get("auth_method") == "api_key"
                else "gemini_oauth_required"
            )
            raise Failure(409, code)
        identifier = env["id"]
        run_entry = self.runs.get(identifier)
        run_active = bool(run_entry and run_entry["process"] is not None)
        active_slots = len(self.active_infers.get(identifier, {}))
        infer_busy = (
            active_slots >= env_concurrency(env)
            if allow_concurrent_infer
            else active_slots > 0
        )
        if (
            run_active
            or infer_busy
            or identifier in self.terminals
            or identifier in self.pending
        ):
            raise Failure(409, "gemini_operation_busy")
        uid = self.env_uid(env)
        directory = self.directory / identifier
        if env.get("auth_method") == "api_key":
            key = json.loads(read_root_file(directory / "credential.json", 1024)).get(
                "api_key"
            )
            if isinstance(key, str) and API_KEY.fullmatch(key):
                return uid, key, None
            raise Failure(409, "gemini_api_key_invalid")
        profile = env.get("profile")
        if profile:
            self._heal_env_dir_perms(env)
        auth = profile and profile_secrets(directory / profile, uid, include_raw=True)
        if not auth:
            raise Failure(409, "gemini_oauth_required")
        issue = self.oauth_runtime_issue()
        if issue:
            raise Failure(503, issue)
        return uid, None, auth

    def _sync_profile_token(self, env, run):
        profile_name = env.get("profile")
        if not profile_name or env.get("auth_method", "oauth") != "oauth":
            return False
        uid = self.env_uid(env)
        updated = profile_secrets(run.directory, uid, include_raw=True)
        if not updated:
            return False
        _, new_bytes = updated
        profile_dir = self.directory / env["id"] / profile_name
        current = profile_secrets(profile_dir, uid, include_raw=True)
        if current and current[1] == new_bytes:
            return False
        token_dir = profile_dir / "home" / ".gemini" / "antigravity-cli"
        target = token_dir / TOKEN_NAME
        staging = token_dir / f".{TOKEN_NAME}.{secrets.token_hex(8)}"
        try:
            with os.fdopen(
                os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
            ) as out:
                out.write(new_bytes)
                out.flush()
                os.fsync(out.fileno())
            os.chown(staging, uid, uid)
            os.chmod(staging, 0o600)
            staging.replace(target)
            return True
        except OSError:
            return False
        finally:
            staging.unlink(missing_ok=True)

    def _profile_credential_health(self, env, *, skew_seconds=300):
        profile_name = env.get("profile")
        if not profile_name or env.get("auth_method", "oauth") != "oauth":
            return None
        uid = self.env_uid(env)
        loaded = profile_secrets(
            self.directory / env["id"] / profile_name, uid, include_raw=True
        )
        if not loaded:
            return {
                "present": False,
                "state": "missing",
                "has_access": False,
                "has_refresh": False,
                "needs_refresh": True,
                "expires_at": None,
            }
        try:
            data = json.loads(loaded[1])
        except (ValueError, UnicodeDecodeError):
            return {
                "present": False,
                "state": "missing",
                "has_access": False,
                "has_refresh": False,
                "needs_refresh": True,
                "expires_at": None,
            }
        token = data.get("token") if isinstance(data, dict) and isinstance(data.get("token"), dict) else data
        if not isinstance(token, dict):
            return {
                "present": False,
                "state": "missing",
                "has_access": False,
                "has_refresh": False,
                "needs_refresh": True,
                "expires_at": None,
            }
        access = token.get("access_token") or token.get("accessToken")
        refresh = token.get("refresh_token") or token.get("refreshToken")
        has_access = isinstance(access, str) and bool(access.strip())
        has_refresh = isinstance(refresh, str) and bool(refresh.strip())
        expiry = token.get("expiry") or token.get("expires_at") or token.get("expiresAt")
        expires_at_ts = None
        if isinstance(expiry, (int, float)) and expiry > 0:
            expires_at_ts = expiry / 1000.0 if expiry >= 10_000_000_000 else float(expiry)
        elif isinstance(expiry, str) and expiry.strip():
            normalized = re.sub(r"\.[0-9]+", "", expiry.strip())
            if normalized.endswith("Z"):
                normalized = normalized[:-1] + "+00:00"
            try:
                parsed = datetime.fromisoformat(normalized)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                expires_at_ts = parsed.timestamp()
            except ValueError:
                expires_at_ts = None
        now_ts = time.time()
        if not has_access:
            state = "refreshable" if has_refresh else "missing"
            needs_refresh = True
        elif expires_at_ts is not None and expires_at_ts <= now_ts:
            state = "expired_refreshable" if has_refresh else "expired"
            needs_refresh = True
        elif expires_at_ts is not None and expires_at_ts <= now_ts + skew_seconds:
            state = "refresh_window"
            needs_refresh = True
        else:
            state = "fresh"
            needs_refresh = False
        return {
            "present": True,
            "state": state,
            "has_access": has_access,
            "has_refresh": has_refresh,
            "needs_refresh": needs_refresh,
            "expires_at": int(expires_at_ts * 1000) if expires_at_ts is not None else None,
        }

    def _profile_token_state(self, env):
        health = self._profile_credential_health(env, skew_seconds=300)
        if not health or not health.get("present"):
            return False, False
        return bool(health.get("has_refresh")), bool(health.get("needs_refresh"))

    _HEADLESS_ERROR_STATUS = {
        "gemini_oauth_required": 401,
        "gemini_api_key_invalid": 401,
        "gemini_location_unsupported": 403,
        "gemini_account_ineligible": 403,
        "gemini_account_verification_required": 403,
        "gemini_client_unsupported": 403,
        "gemini_model_unavailable": 409,
        "gemini_quota_exhausted": 429,
        "gemini_inference_bad_input": 400,
        "gemini_inference_timeout": 504,
        "gemini_oauth_client_not_configured": 503,
        "gemini_upstream_unavailable": 503,
    }

    @classmethod
    def _raise_model_probe_failure(cls, data, *, api_key=False):
        err_code = data.get("error_code") if isinstance(data, dict) else None
        err_msg = data.get("error_message") if isinstance(data, dict) else None
        http_status = data.get("http_status") if isinstance(data, dict) else None
        state = data.get("state") if isinstance(data, dict) else None
        if api_key:
            if state == "reauth_required":
                raise Failure(409, "gemini_api_key_invalid", message=err_msg)
            if http_status == 429:
                raise Failure(429, err_code or "gemini_quota_exhausted", message=err_msg)
            if http_status == 403:
                raise Failure(403, err_code or "gemini_api_key_invalid", message=err_msg)
            if http_status == 503:
                raise Failure(503, err_code or "gemini_upstream_unavailable", message=err_msg)
            raise Failure(502, err_code or "gemini_proxy_error", message=err_msg)
        if state == "reauth_required" or http_status == 401 or err_code == "gemini_oauth_required":
            raise Failure(401, err_code or "gemini_oauth_required", message=err_msg)
        if http_status == 403:
            raise Failure(403, err_code or "gemini_account_ineligible", message=err_msg)
        if http_status == 409:
            raise Failure(409, err_code or "gemini_oauth_required", message=err_msg)
        if http_status == 429:
            raise Failure(429, err_code or "gemini_quota_exhausted", message=err_msg)
        if http_status == 503 or err_code == "gemini_oauth_client_not_configured":
            raise Failure(503, err_code or "gemini_upstream_unavailable", message=err_msg)
        status = cls._HEADLESS_ERROR_STATUS.get(err_code, 502)
        raise Failure(status, err_code or "gemini_proxy_error", message=err_msg)

    def pull_models(self, env, proxy_url, *, allow_reauth_probe=False, egress_options=None):
        self._heal_env_dir_perms(env)
        uid, key, auth = self.operation_account(
            env, allow_concurrent_infer=True, allow_reauth_probe=allow_reauth_probe
        )
        opts = normalize_egress_options(egress_options)
        fetched_data = None
        if key:
            data = read_account(uid, proxy_url, "api-key-models", api_key=key)
            if data.get("state") not in ("ok", "partial"):
                self._raise_model_probe_failure(data, api_key=True)
            models = data.get("models", [])
        elif env.get("auth_method", "oauth") == "oauth" and env.get("profile"):
            project_hint = (env.get("account") or {}).get("project_id")
            data = read_account(
                uid,
                proxy_url,
                "oauth-models",
                profile=self.directory / env["id"] / env["profile"],
                oauth_token={"project_id": project_hint} if project_hint else None,
                timeout=25,
                agy_path=self._agy_path(),
            )
            if data.get("state") not in ("ok", "partial"):
                self._raise_model_probe_failure(data, api_key=False)
            fetched_data = data
            models = [
                m
                for m in (data.get("models") or ())
                if isinstance(m, str) and MODEL.fullmatch(m)
            ]
        else:
            run = Headless(
                self,
                env,
                proxy_url,
                auth,
                invocation_module().MODEL_ARGS,
                None,
                **({"egress_options": opts} if opts else {}),
            )
            try:
                deadline = time.monotonic() + 19
                while True:
                    result = run.poll()
                    if result["state"] != "running":
                        break
                    if time.monotonic() >= deadline:
                        raise Failure(504, "gemini_inference_timeout")
                    time.sleep(0.05)
                if result["state"] != "completed":
                    err_obj = result.get("error") if isinstance(result.get("error"), dict) else {}
                    err_code = err_obj.get("code") or "gemini_inference_failed"
                    err_msg = err_obj.get("message")
                    status = self._HEADLESS_ERROR_STATUS.get(err_code, 502)
                    raise Failure(status, err_code, message=err_msg)
                models = result.get("models", [])
            finally:
                self._sync_profile_token(env, run)
                run.close()
        if not models:
            raise Failure(502, "gemini_models_empty")
        with self.lock:
            updated = {**env, "call_models": list(models), "updated_at": now()}
            if fetched_data is not None:
                updated_account = dict(env.get("account") or {})
                updated_account["models"] = list(models)
                if isinstance(fetched_data.get("quotas"), list) and fetched_data["quotas"]:
                    updated_account["quotas"] = fetched_data["quotas"]
                if (
                    isinstance(fetched_data.get("model_catalog"), list)
                    and fetched_data["model_catalog"]
                ):
                    updated_account["model_catalog"] = fetched_data["model_catalog"]
                if updated_account.get("state") not in ("ok", "partial"):
                    updated_account["state"] = "ok"
                    updated_account["checked_at"] = fetched_data.get("checked_at") or now()
                    for err_key in ("error_code", "error_message", "http_status"):
                        updated_account.pop(err_key, None)
                updated["account"] = updated_account
                if env.get("auth_state") == "reauth_required":
                    updated["auth_state"] = "authorized"
            self.save_environment(env, updated)
            return self.view(env)

    def _start_oauth_test_chat(self, env, proxy_url, auth, model, prompt, *, egress_options=None):
        identifier = env["id"]
        opts = normalize_egress_options(egress_options)
        egress_key = egress_fingerprint(proxy_url, opts)
        desired_concurrency = env_concurrency(env)
        existing = self.native_sessions.get(identifier)
        if (
            existing is not None
            and getattr(existing, "max_concurrency", 1) == desired_concurrency
            and secrets.compare_digest(_session_egress_key(existing), egress_key)
            and existing.is_alive()
            and not existing.is_severely_unhealthy()
        ):
            session = existing
        else:
            if existing is not None:
                self.stop_native_session(identifier)
            session = NativeSession(
                self,
                env,
                proxy_url,
                auth,
                model,
                **({"egress_options": opts} if opts else {}),
            )
            self.native_sessions[identifier] = session
        session.last_used = time.monotonic()
        return ResidentTestChatRun(session, model, prompt, auth[0])

    def start_run(self, env, proxy_url, body):
        model, prompt = body.get("model"), body.get("prompt")
        if (
            not isinstance(model, str)
            or not MODEL.fullmatch(model)
            or not isinstance(prompt, str)
            or not prompt.strip()
            or len(prompt.encode()) > 4096
        ):
            raise Failure(400)
        uid, key, auth = self.operation_account(env, allow_concurrent_infer=True)
        if model not in env.get("call_models", []):
            raise Failure(409, "gemini_model_unavailable")
        identifier = env["id"]
        egress_opts = normalize_egress_options(body.get("egress_options"))
        self._remember_runtime_proxy(env, proxy_url, egress_opts)
        self.stop_run(identifier)
        evidence = {
            "state": "running",
            "model": model,
            "started_at": now(),
            "finished_at": None,
            "error_code": None,
        }
        # Runs may outlive a binding change. Updating their own evidence object
        # must not put an invalidated record back into inventory.
        # Keep the proxy identity on the trusted control socket only. A proxy
        # pool edit can change the endpoint or credentials without a new ID.
        self.last_inference[identifier] = (
            self.inference_binding(env),
            evidence,
            hashlib.sha256(proxy_url.encode()).hexdigest(),
        )
        try:
            if key:
                process = invocation_module().Invocation(
                    account_command(uid, "api-key-chat"),
                    SYSTEM_ENV,
                    prompt,
                    input_bytes=json.dumps(
                        {
                            "api_key": key,
                            "proxy_url": proxy_url,
                            "prompt": prompt,
                            "model": model,
                        }
                    ).encode(),
                    secrets=(key,),
                )
            else:
                process = self._start_oauth_test_chat(
                    env,
                    proxy_url,
                    auth,
                    model,
                    prompt,
                    **({"egress_options": egress_opts} if egress_opts else {}),
                )
        except Failure as error:
            self.finish_inference(
                evidence, "failed", error.code or "gemini_inference_start_failed"
            )
            raise
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError):
            self.finish_inference(evidence, "failed", "gemini_inference_start_failed")
            raise
        run_id = secrets.token_hex(16)
        self.runs[identifier] = {
            "id": run_id,
            "process": process,
            "evidence": evidence,
            "deadline": time.monotonic() + RUN_TTL,
        }
        return {"run_id": run_id}

    def run_request(self, operation, identifier, body):
        entry = self.runs.get(identifier)
        if not entry or entry["id"] != body.get("run_id"):
            raise Failure(404, "gemini_run_not_found")
        if operation == "test-chat-cancel":
            self.stop_run(identifier)
            return {"cancelled": True}
        try:
            self.ensure_payload(legacy_install=False)
        except Failure:
            self.stop_run(identifier)
            raise
        return self.update_run(entry)

    def probe_proxy(self, env, proxy_url):
        started = time.monotonic()
        result = read_account(self.env_uid(env), proxy_url, "proxy-probe")
        return {
            "ok": result.get("ok") is True,
            "latency_ms": round((time.monotonic() - started) * 1000),
        }

    def save_environment(self, env, updated):
        private_json(self.state_file, {**self.environments, env["id"]: updated})
        self.last_inference.pop(env["id"], None)
        env.clear()
        env.update(updated)

    def bind_proxy(self, env, body):
        new_id = body.get("proxy_id")
        if not isinstance(new_id, str) or not ID.fullmatch(new_id):
            raise Failure(400)
        proxy_url = body.get("proxy_url")
        proxy_config(proxy_url)
        egress_opts = normalize_egress_options(body.get("egress_options"))
        identifier = env["id"]
        if (
            body.get("previous_proxy_id") != env["proxy_id"]
            or self.running(identifier)
            or identifier in self.terminals
            or identifier in self.pending
        ):
            raise Failure(409, "gemini_operation_busy")
        new_egress_key = egress_fingerprint(proxy_url, egress_opts)
        prev_cached = self._runtime_proxy_entry(identifier)
        egress_changed = (
            prev_cached is not None
            and not secrets.compare_digest(prev_cached[2], new_egress_key)
        )
        if new_id != env["proxy_id"]:
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            self._remove_account_from_shard(identifier)
            self._clear_runtime_proxy(identifier)
            updated = {**env, "proxy_id": new_id, "updated_at": now()}
            updated.pop("call_models", None)
            updated.pop("account", None)
            self.save_environment(env, updated)
        elif egress_changed:
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            self._remove_account_from_shard(identifier)
        self._remember_runtime_proxy(env, proxy_url, egress_opts)
        return self.view(env)

    def terminal_request(self, operation, env, body):
        identifier = env["id"]
        session_id = body.get("session_id")
        if not isinstance(session_id, str) or not ATTEMPT.fullmatch(session_id):
            raise Failure(400)
        terminal = self.terminals.get(identifier)
        if operation == "terminal-stop":
            if terminal and terminal.session_id == session_id:
                self.stop_terminal(identifier)
            return {}
        if operation == "terminal-io":
            closed = {"data": "", "closed": True}
            if not terminal or terminal.session_id != session_id:
                return closed
            try:
                self.ensure_payload(legacy_install=False)
            except Failure:
                self.stop_terminal(identifier)
                raise
            size = terminal_size(body)
            text = body.get("input", "")
            if not isinstance(text, str):
                raise Failure(400)
            data = text.encode("utf-8")
            if len(data) > TERMINAL_INPUT:
                raise Failure(400)
            if time.monotonic() < terminal.deadline:
                try:
                    output = terminal.relay(data, size)
                    return {"data": output, "closed": False}
                except Failure as error:
                    if error.status != 409:
                        raise
                except OSError:
                    pass
            self.stop_terminal(identifier)
            return closed

        if (
            terminal
            or identifier in self.pending
            or self.running(identifier)
            or any(other.session_id == session_id for other in self.terminals.values())
        ):
            raise Failure(409, "gemini_terminal_conflict")
        if (
            env.get("auth_method", "oauth") != "oauth"
            or env["auth_state"] != "authorized"
            or not env.get("profile")
        ):
            raise Failure(409, TERMINAL_OAUTH)
        profile = self.directory / identifier / env["profile"]
        credentials = profile_secrets(profile, self.env_uid(env))
        if not credentials:
            raise Failure(409, TERMINAL_OAUTH)
        if body.get("proxy_id") != env["proxy_id"]:
            raise Failure(409, "gemini_terminal_conflict")
        proxy_url = body.get("proxy_url")
        proxy_config(proxy_url)
        egress_opts = normalize_egress_options(body.get("egress_options"))
        size = terminal_size(body, required=True)
        self.ensure_payload()
        self._remember_runtime_proxy(env, proxy_url, egress_opts)
        self.stop_native_session(identifier)
        try:
            issue = self.oauth_runtime_issue()
            if issue:
                raise Failure(503, issue)
            self.terminals[identifier] = Terminal(
                self,
                env,
                proxy_url,
                profile,
                size,
                session_id,
                credentials,
                **({"egress_options": egress_opts} if egress_opts else {}),
            )
        except Failure as error:
            if error.code == TERMINAL_OAUTH:
                env["auth_state"] = "reauth_required"
                self.touch_environment(env)
                self.save()
                raise
            raise Failure(503, "gemini_terminal_unavailable") from error
        except (OSError, subprocess.SubprocessError) as error:
            raise Failure(503, "gemini_terminal_unavailable") from error
        return {"ok": True}

    def close(self):
        failed = False
        with self.lock:
            for identifier in list(self.active_infers):
                self.cancel_infer(identifier)
            for shard_id in list(self.daemon_shards):
                try:
                    self._stop_shard(shard_id)
                except (OSError, subprocess.SubprocessError):
                    failed = True
            for stop, active in (
                (self.stop_run, self.runs),
                (self.stop_native_session, self.native_sessions),
                (self.stop_terminal, self.terminals),
                (self.cancel, self.pending),
            ):
                for identifier in list(active):
                    try:
                        stop(identifier)
                    except (OSError, subprocess.SubprocessError):
                        failed = True
        if failed:
            raise RuntimeError("Gemini child cleanup failed")

    def cleanup(self):
        with self.lock:
            self._cleanup_locked()

    def _cleanup_locked(self):
        now_mono = time.monotonic()
        for shard_id, shard in list(self.daemon_shards.items()):
            if any(self.active_infers.get(acc_id) for acc_id in shard.members):
                continue
            if not shard.is_alive():
                self._stop_shard(shard_id)
                self._record_shard_fault(shard_id)
                continue
            last_probe = getattr(shard, "_last_health_at", 0.0)
            if now_mono - last_probe >= NATIVE_HEALTH_POLL_INTERVAL:
                status = shard.health(timeout=0.5)
                if (
                    isinstance(status, dict)
                    and status.get("ready") is True
                    and status.get("needs_recovery") is not True
                ):
                    self._clear_shard_fault(shard_id)
                if shard.is_severely_unhealthy():
                    self._stop_shard(shard_id)
                    self._record_shard_fault(shard_id)
        for identifier, session in list(self.native_sessions.items()):
            if self.active_infers.get(identifier):
                continue
            run_entry = self.runs.get(identifier)
            if run_entry and run_entry["process"] is not None:
                continue
            if not session.is_alive():
                ever_ready = bool(getattr(session, "_ever_ready", False))
                self.stop_native_session(identifier)
                if not ever_ready:
                    self._record_warm_failure_locked(identifier)
                    self._schedule_reauth_check_locked(identifier)
                self._schedule_warm_locked(identifier)
                continue
            last_probe = getattr(session, "_last_health_at", 0.0)
            if now_mono - last_probe >= NATIVE_HEALTH_POLL_INTERVAL:
                status = session.health(timeout=0.5)
                if (
                    isinstance(status, dict)
                    and status.get("ready") is True
                    and status.get("needs_recovery") is not True
                ):
                    getattr(self, "_warm_backoff", {}).pop(identifier, None)
                if session.is_severely_unhealthy():
                    diag_code = session_diagnostic(session)
                    ever_ready = bool(getattr(session, "_ever_ready", False))
                    self.stop_native_session(identifier)
                    if not ever_ready or diag_code is not None:
                        self._record_warm_failure_locked(identifier)
                        self._schedule_reauth_check_locked(identifier)
                    if diag_code is None:
                        self._schedule_warm_locked(identifier)
        for identifier, entry in list(self.runs.items()):
            if entry["process"] is None and time.monotonic() >= entry["deadline"]:
                self.stop_run(identifier)
            else:
                self.update_run(entry)
        if self.terminals or self.pending or self.runs or self.native_sessions:
            try:
                self.ensure_payload(legacy_install=False)
            except Failure:
                for identifier in list(self.active_infers):
                    self.cancel_infer(identifier)
                for identifier in list(self.runs):
                    self.stop_run(identifier)
                for identifier in list(self.native_sessions):
                    self.stop_native_session(identifier)
                for identifier in list(self.terminals):
                    self.stop_terminal(identifier)
                for identifier in list(self.pending):
                    self.cancel(identifier)
                    env = self.environments[identifier]
                    env["auth_state"] = "reauth_required"
                    self.touch_environment(env)
                    self.save()
                return
        for identifier, terminal in list(self.terminals.items()):
            if (
                time.monotonic() >= terminal.deadline
                or not terminal.alive()
                or not terminal.live_profile()
            ):
                self.stop_terminal(identifier)
            else:
                try:
                    terminal.flush_input()
                except OSError:
                    self.stop_terminal(identifier)
        for identifier, login in list(self.pending.items()):
            env = self.environments[identifier]
            completed_proxy_url = None
            completed_egress_opts = None
            try:
                if time.monotonic() > login.deadline:
                    raise Failure(409)
                if not login.finished():
                    continue
                old_profile = env.get("profile")
                imported = env.pop("oauth_imported", False)
                completed_proxy_url = login.proxy_url
                completed_egress_opts = getattr(login, "egress_options", None)
                login.close(preserve=True)
                env.update(auth_state="authorized", profile=login.attempt)
                self.touch_environment(env)
                env.pop("account", None)
                env.pop("call_models", None)
                self.save()
                if imported:
                    (self.directory / identifier / "oauth-import.json").unlink(
                        missing_ok=True
                    )
                del self.pending[identifier]
                if old_profile:
                    shutil.rmtree(self.directory / identifier / old_profile)
                self._remember_runtime_proxy(env, login.proxy_url, completed_egress_opts)
            except Failure:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                self.touch_environment(env)
                self.save()
                continue
            if completed_proxy_url:
                self._post_auth_provision(
                    env,
                    completed_proxy_url,
                    **({"egress_options": completed_egress_opts} if completed_egress_opts else {}),
                )
                self._schedule_warm_locked(identifier, force=True)
        for identifier in list(self.environments):
            if identifier not in self.native_sessions:
                self._schedule_warm_locked(identifier)
            self._schedule_eligibility_probe_locked(identifier)

    def _post_auth_provision(self, env, proxy_url, *, egress_options=None):
        opts = normalize_egress_options(egress_options)
        if (
            env.get("auth_method", "oauth") == "oauth"
            and not env.get("oauth_imported")
            and self.egress is not None
            and self.oauth_runtime_issue() is None
        ):
            try:
                self.pull_models(
                    env, proxy_url, **({"egress_options": opts} if opts else {})
                )
            except (
                Failure,
                OSError,
                subprocess.SubprocessError,
                ValueError,
                RuntimeError,
            ):
                pass
        try:
            self.refresh_account(
                env,
                proxy_url,
                auto_pull_models=False,
                **({"egress_options": opts} if opts else {}),
            )
        except (
            Failure,
            OSError,
            subprocess.SubprocessError,
            ValueError,
            RuntimeError,
        ):
            pass

    def ensure_env_machine_id(self, env):
        env_dir = self.directory / env["id"]
        env_dir.mkdir(mode=0o711, exist_ok=True)
        env_dir.chmod(0o711)
        target = env_dir / "machine-id"
        if target.exists():
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise Failure(503, "license_invalid")
            return target
        staging = env_dir / f".machine-id.{secrets.token_hex(8)}"
        try:
            with os.fdopen(
                os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644), "w"
            ) as out:
                out.write(secrets.token_hex(16) + "\n")
                out.flush()
                os.fsync(out.fileno())
            os.chmod(staging, 0o644)
            staging.replace(target)
        finally:
            staging.unlink(missing_ok=True)
        return target

    def ensure_env_license_dir(self, env):
        env_dir = self.directory / env["id"]
        env_dir.mkdir(mode=0o711, exist_ok=True)
        env_dir.chmod(0o711)
        uid = self.env_uid(env)
        target = env_dir / "crag-license"
        if target.exists() or target.is_symlink():
            info = target.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or (info.st_mode & 0o7777) != 0o700:
                raise Failure(503, "license_invalid")
            return target
        target.mkdir(mode=0o700)
        os.chown(target, uid, uid)
        os.chmod(target, 0o700)
        return target

    def run_craggemini_license_cli(self, env, extra_args, input_code=None):
        if env.get("auth_method", "oauth") != "oauth":
            raise Failure(409, "gemini_subscription_oauth_only")
        self.ensure_payload(legacy_install=False)
        uid = self.env_uid(env)
        machine_id = self.ensure_env_machine_id(env)
        license_dir = self.ensure_env_license_dir(env)
        staging_dir = None
        try:
            bwrap_args = [
                "setpriv",
                "--reuid",
                str(uid),
                "--regid",
                str(uid),
                "--clear-groups",
                "--no-new-privs",
                "--inh-caps=-all",
                "--ambient-caps=-all",
                "--bounding-set=-all",
                resolve_bwrap_argv0(host_root=active_host_root()),
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--unshare-net",
                "--die-with-parent",
                "--clearenv",
                "--ro-bind",
                "/usr",
                "/usr",
                "--ro-bind-try",
                "/lib",
                "/lib",
                "--ro-bind-try",
                "/lib64",
                "/lib64",
                "--ro-bind-try",
                "/bin",
                "/bin",
                "--ro-bind",
                str(machine_id),
                "/etc/machine-id",
                "--dir",
                "/run",
                "--dir",
                "/run/kin",
                "--dir",
                "/run/kin/crag-license",
                "--bind",
                str(license_dir),
                "/run/kin/crag-license",
                "--ro-bind",
                str(self.payload / "craggemini"),
                "/opt/craggemini",
                "--proc",
                "/proc",
                "--tmpfs",
                "/tmp",
            ]
            if self.crag_host_dir is not None and self.crag_host_dir.is_dir():
                bwrap_args.extend(
                    [
                        "--dir",
                        "/run/kin/crag-host",
                        "--ro-bind",
                        str(self.crag_host_dir),
                        "/run/kin/crag-host",
                    ]
                )
            if self.payload_mode == "crag_subscription":
                bwrap_args.extend(
                    [
                        "--ro-bind",
                        str(self.payload / "craggemini.payload.enc"),
                        "/opt/craggemini.payload.enc",
                        "--ro-bind",
                        str(self.payload / "manifest.json"),
                        "/opt/manifest.json",
                        "--ro-bind",
                        str(self.payload / "crag-license-public.pem"),
                        "/opt/crag-license-public.pem",
                    ]
                )
            cli_args = [
                "/opt/craggemini",
                "--vm-id",
                env["id"],
                "--license-dir",
                "/run/kin/crag-license",
                "--host-license-dir",
                "/run/kin/crag-host",
                *extra_args,
            ]
            if input_code is not None:
                staging_dir = self.directory / env["id"] / f".activate-{secrets.token_hex(8)}"
                staging_dir.mkdir(mode=0o700)
                os.chown(staging_dir, uid, uid)
                code_file = staging_dir / "code.txt"
                with os.fdopen(
                    os.open(code_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                    "w",
                    encoding="utf-8",
                ) as out:
                    out.write(input_code.strip() + "\n")
                    out.flush()
                    os.fsync(out.fileno())
                os.chown(code_file, uid, uid)
                os.chmod(code_file, 0o600)
                bwrap_args.extend(["--dir", "/tmp/activate", "--ro-bind", str(staging_dir), "/tmp/activate"])
                cli_args.extend(["--license-activate-file", "/tmp/activate/code.txt"])
            result = subprocess.run(
                bwrap_args + ["--"] + cli_args,
                timeout=10,
                capture_output=True,
                text=True,
                env=SYSTEM_ENV,
            )
            if result.returncode != 0:
                status_code, error_code = classify_craggemini_license_cli_error(
                    result.stdout,
                    result.stderr,
                    sync_pending=self._crag_host_sync_pending(),
                )
                raise Failure(status_code, error_code)
            data = json.loads(result.stdout)
            if not isinstance(data, dict):
                raise Failure(503, "license_invalid")
            return data
        except Failure:
            raise
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            classified = classify_craggemini_license_host_error(error)
            if classified is not None:
                status_code, error_code = classified
                raise Failure(status_code, error_code) from None
            raise Failure(503, "license_unconfigured") from None
        finally:
            if staging_dir is not None:
                shutil.rmtree(staging_dir, ignore_errors=True)

    def _crag_host_sync_pending(self):
        host_dir = getattr(self, "crag_host_dir", None)
        if host_dir is None:
            return False
        try:
            marker = host_dir / "sync-pending"
            return marker.exists() or marker.is_symlink()
        except OSError:
            return False

    def _expected_payload_key_id(self):
        payload_dir = getattr(self, "payload", None)
        if payload_dir is None:
            return None
        manifest_path = payload_dir / "manifest.json"
        try:
            fd = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    return None
                data = json.loads(stream.read(65537).decode("utf-8", errors="strict"))
        except (OSError, UnicodeDecodeError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        payload = data.get("payload")
        if not isinstance(payload, dict):
            return None
        key_id = payload.get("key_id")
        return key_id if isinstance(key_id, str) and SHA256.fullmatch(key_id) else None

    def _read_env_permit_payload_key_id(self, env):
        directory = getattr(self, "directory", None)
        if directory is None:
            return None
        reg_file = directory / env["id"] / "crag-license" / "registration.code"
        try:
            fd = os.open(reg_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    return None
                text = stream.read(65537).decode("utf-8", errors="strict")
        except (OSError, UnicodeDecodeError):
            return None
        return extract_permit_payload_key_id(text)

    @staticmethod
    def _stat_token(path):
        if path is None:
            return None
        try:
            st = os.lstat(path)
            return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        except OSError:
            return None

    def _license_cache_state(self):
        lock = getattr(self, "_license_cache_lock", None)
        if lock is None:
            lock = threading.Lock()
            self._license_cache_lock = lock
        cache = getattr(self, "_license_status_cache", None)
        if cache is None:
            cache = {}
            self._license_status_cache = cache
        return lock, cache

    def _invalidate_license_cache(self, env_id=None):
        lock, cache = self._license_cache_state()
        with lock:
            if env_id is None:
                cache.clear()
            else:
                cache.pop(env_id, None)

    def _license_status_fingerprint(self, env):
        env_id = env["id"]
        directory = getattr(self, "directory", None)
        lic_dir = (directory / env_id / "crag-license") if directory is not None else None
        host_dir = getattr(self, "crag_host_dir", None)
        payload_dir = getattr(self, "payload", None)
        return (
            env_id,
            getattr(self, "payload_mode", None),
            getattr(self, "verified_payload", None),
            self._stat_token(payload_dir / "manifest.json" if payload_dir is not None else None),
            self._stat_token(lic_dir / "registration.code" if lic_dir is not None else None),
            self._stat_token(lic_dir / "device.json" if lic_dir is not None else None),
            self._stat_token(host_dir / "entitlement.code" if host_dir is not None else None),
            self._stat_token(host_dir / "revoked" if host_dir is not None else None),
            self._stat_token(host_dir / "sync-pending" if host_dir is not None else None),
            self._stat_token(Path("/etc/machine-id")),
        )

    def _get_cached_license_status(self, env):
        env_id = env["id"]
        fp = self._license_status_fingerprint(env)
        lock, cache = self._license_cache_state()
        now_mono = time.monotonic()
        now_wall = time.time()
        with lock:
            entry = cache.get(env_id)
            if entry is None:
                return None, fp
            cached_fp, cached_at, status = entry
            ttl = 30.0 if status.get("valid") is True else 5.0
            if cached_fp != fp or (now_mono - cached_at) >= ttl:
                return None, fp
            expires_at = status.get("expires_at")
            if isinstance(expires_at, (int, float)) and now_wall >= expires_at:
                return None, fp
            not_before = status.get("not_before")
            if isinstance(not_before, (int, float)) and now_wall < not_before:
                return None, fp
            return dict(status), fp

    def license_status(self, env, *, use_cache=True):
        if env.get("auth_method", "oauth") == "api_key":
            return {
                "product": "craggemini",
                "status": "not_required",
                "valid": True,
                "seat_required": False,
                "vm_id": env["id"],
            }
        fp = None
        if use_cache:
            cached, fp = self._get_cached_license_status(env)
            if cached is not None:
                return cached
        try:
            status = self.run_craggemini_license_cli(env, ["--license-status"])
            status = reconcile_craggemini_license_status(
                status,
                expected_payload_key_id=(
                    self._expected_payload_key_id()
                    if self.payload_mode == "crag_subscription"
                    else None
                ),
                permit_payload_key_id=(
                    None
                    if status.get("payload_key_id")
                    else self._read_env_permit_payload_key_id(env)
                ),
                sync_pending=self._crag_host_sync_pending(),
            )
            status.setdefault("product", "craggemini")
            status["seat_required"] = True
        except Failure as error:
            code = (
                error.code
                if error.code in LICENSE_ERROR_CODES
                or error.code in SANDBOX_ERROR_CODES
                or error.code in HOST_RESOURCE_ERROR_CODES
                else "license_unconfigured"
            )
            status = {
                "product": "craggemini",
                "status": (
                    "unlicensed"
                    if code == "license_required"
                    else "sync_pending"
                    if code == "gemini_subscription_sync_pending"
                    else "host_resource_exhausted"
                    if code in HOST_RESOURCE_ERROR_CODES
                    else "unconfigured"
                ),
                "valid": False,
                "seat_required": True,
                **(
                    {"sync_pending": True}
                    if code == "gemini_subscription_sync_pending"
                    else {}
                ),
                "vm_id": env["id"],
                "code": code,
            }
        if use_cache:
            if fp is None:
                fp = self._license_status_fingerprint(env)
            lock, cache = self._license_cache_state()
            with lock:
                if len(cache) > MAX_ENVIRONMENTS * 2:
                    cache.clear()
                cache[env["id"]] = (fp, time.monotonic(), dict(status))
        return status

    def license_release_candidate(self, env):
        if env.get("auth_method", "oauth") != "oauth":
            return {"permit_sha256": None, "seat_required": False}
        reg_file = self.directory / env["id"] / "crag-license" / "registration.code"
        try:
            fd = os.open(reg_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    return {"permit_sha256": None, "seat_required": True}
                text = stream.read(65537).decode("utf-8", errors="strict").strip()
            if text.startswith("CRAGS1."):
                return {
                    "permit_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    "seat_required": True,
                }
            return {"permit_sha256": None, "seat_required": True}
        except (OSError, UnicodeDecodeError):
            return {"permit_sha256": None, "seat_required": True}

    def license_clear(self, env):
        identifier = env["id"]
        self.cancel_infer(identifier)
        self.stop_run(identifier)
        self.stop_native_session(identifier)
        self._clear_runtime_proxy(identifier)
        reg_file = self.directory / identifier / "crag-license" / "registration.code"
        try:
            if reg_file.exists() and not reg_file.is_symlink():
                reg_file.unlink()
        except OSError:
            pass
        self._sync_shard_account_license(env)
        self._invalidate_license_cache(identifier)
        return {"cleared": True}

    def view(self, env):
        account = env.get("account", {})
        method = env.get("auth_method", "oauth")
        session = self.native_sessions.get(env["id"])
        shard_id = self._account_shard_map.get(env["id"])
        shard = self.daemon_shards.get(shard_id) if shard_id else None
        shard_ready = (
            shard is not None
            and env["id"] in shard.members
            and shard.is_alive()
            and not shard.is_severely_unhealthy()
        )
        runtime_ready = (
            (method == "api_key" and env["auth_state"] == "authorized" and bool(env.get("call_models")))
            or shard_ready
            or (
                session is not None
                and session.is_alive()
                and not session.is_severely_unhealthy()
                and session_diagnostic(session) is None
            )
        )
        crag_license = (
            self.license_status(env)
            if self.payload_mode == "crag_subscription"
            else None
        )
        credential_state = (
            self._profile_credential_health(env)
            if method == "oauth" and not env.get("oauth_imported")
            else None
        )
        return {
            "id": env["id"],
            "name": env["name"],
            "proxy_id": env["proxy_id"],
            "auth_state": env["auth_state"],
            "auth_method": method,
            **({"oauth_imported": True} if env.get("oauth_imported") else {}),
            "runtime_ready": runtime_ready,
            "max_concurrency": env_concurrency(env),
            "max_sessions": int(
                self.runtime_policy.get("max_sessions_per_account", DEFAULT_MAX_SESSIONS)
            ),
            "active_slots": len(self.active_infers.get(env["id"], {})),
            "capabilities": list(FULL_CAPABILITIES if method == "api_key" else NATIVE_CAPABILITIES),
            "kernel_version": self.payload_version,
            "models": env.get("call_models", account.get("models", [])),
            "models_discovered": bool(env.get("call_models")),
            "account": account,
            **({"credential_state": credential_state} if credential_state is not None else {}),
            **({"crag_license": crag_license} if crag_license is not None else {}),
            "created_at": env.get("created_at"),
            "updated_at": env.get("updated_at"),
            **self.last_inference_view(env),
        }

    def probe_imported_account(self, slot, proxy_url, credential):
        if credential["expiry"] <= time.time():
            return {"state": "reauth_required", "checked_at": now()}
        return read_account(
            self.uid_base + (slot % MAX_NETNS_SLOTS), proxy_url, "oauth_import", oauth_token=credential
        )

    def _agy_path(self):
        return (self.payload / "agy") if getattr(self, "payload", None) is not None else None

    def _heal_env_dir_perms(self, env):
        if not isinstance(env, dict):
            return
        identifier = env.get("id")
        if not isinstance(identifier, str) or not identifier:
            return
        env_dir = self.directory / identifier
        _ensure_traversable_dir(env_dir)
        profile = env.get("profile")
        if isinstance(profile, str) and ATTEMPT.fullmatch(profile):
            _ensure_traversable_dir(env_dir / profile)

    def probe_refresh_imported_account(self, slot, proxy_url, credential):
        result = read_account(
            self.uid_base + (slot % MAX_NETNS_SLOTS),
            proxy_url,
            "oauth_refresh_import",
            oauth_token=credential,
            timeout=25,
            agy_path=self._agy_path(),
        )
        if not isinstance(result, dict):
            return {"account": {"state": "error", "checked_at": now()}}
        if isinstance(result.get("account"), dict):
            return result
        return {"account": result}

    def _write_imported_profile(self, env_dir, uid, token_doc, project_id=None):
        env_dir.chmod(0o711)
        profile_id = secrets.token_hex(16)
        profile_dir = env_dir / profile_id
        profile_dir.mkdir(mode=0o711)
        profile_dir.chmod(0o711)
        home = profile_dir / "home"
        settings = home / ".gemini" / "antigravity-cli"
        for private in (home, home / ".gemini", settings):
            private.mkdir(mode=0o700)
            os.chmod(private, 0o700)
            os.chown(private, uid, uid)
        settings_file = settings / "settings.json"
        private_json(settings_file, CLI_SETTINGS)
        os.chown(settings_file, uid, uid)
        token_file = settings / TOKEN_NAME
        private_json(token_file, token_doc)
        os.chown(token_file, uid, uid)
        cache_dir = settings / "cache"
        cache_dir.mkdir(mode=0o700, exist_ok=True)
        os.chmod(cache_dir, 0o700)
        os.chown(cache_dir, uid, uid)
        onboarding_file = cache_dir / "onboarding.json"
        private_json(onboarding_file, {"onboardingComplete": True})
        os.chmod(onboarding_file, 0o600)
        os.chown(onboarding_file, uid, uid)
        if isinstance(project_id, str) and 1 <= len(project_id.strip()) <= 128:
            proj_file = cache_dir / "default_project_id.txt"
            proj_file.write_text(project_id.strip() + "\n", encoding="utf-8")
            os.chmod(proj_file, 0o600)
            os.chown(proj_file, uid, uid)
        return profile_id

    def refresh_account(self, env, proxy_url, *, auto_pull_models=True, egress_options=None):
        directory = self.directory / env["id"]
        opts = normalize_egress_options(egress_options)
        pull_kwargs = {"egress_options": opts} if opts else {}
        if env.get("auth_method") == "api_key":
            api_key = json.loads((directory / "credential.json").read_bytes())[
                "api_key"
            ]
            account = read_account(
                self.env_uid(env), proxy_url, "api_key", api_key=api_key
            )
        elif env.get("oauth_imported"):
            credential = json.loads((directory / "oauth-import.json").read_bytes())
            account = self.probe_imported_account(env["slot"], proxy_url, credential)
        else:
            self._heal_env_dir_perms(env)
            has_refresh, is_expired = self._profile_token_state(env)
            with self.lock:
                can_run_agy = (
                    self.egress is not None
                    and self.oauth_runtime_issue() is None
                    and not self.running(env["id"])
                    and env["id"] not in self.terminals
                    and env["id"] not in self.pending
                )
            agy_refreshed = False
            agy_non_auth_error = False
            if has_refresh and is_expired and can_run_agy:
                agy_refreshed = True
                try:
                    self.pull_models(
                        env, proxy_url, allow_reauth_probe=True, **pull_kwargs
                    )
                except Failure as error:
                    if error.code != "gemini_oauth_required":
                        agy_non_auth_error = True
                except (OSError, subprocess.SubprocessError, ValueError, RuntimeError):
                    agy_non_auth_error = True
            account = read_account(
                self.env_uid(env),
                proxy_url,
                "oauth",
                profile=directory / env["profile"],
                agy_path=self._agy_path(),
            )
            if (
                account.get("state") == "reauth_required"
                and has_refresh
                and not agy_refreshed
                and can_run_agy
            ):
                agy_refreshed = True
                try:
                    self.pull_models(
                        env, proxy_url, allow_reauth_probe=True, **pull_kwargs
                    )
                    account = read_account(
                        self.env_uid(env),
                        proxy_url,
                        "oauth",
                        profile=directory / env["profile"],
                        agy_path=self._agy_path(),
                    )
                except Failure as error:
                    if error.code != "gemini_oauth_required":
                        agy_non_auth_error = True
                except (OSError, subprocess.SubprocessError, ValueError, RuntimeError):
                    agy_non_auth_error = True
            if account.get("state") == "reauth_required" and agy_non_auth_error:
                account["state"] = "error"
            if (
                account.get("state") in ("ok", "partial")
                and auto_pull_models
                and not env.get("call_models")
                and not agy_refreshed
                and can_run_agy
            ):
                try:
                    self.pull_models(
                        env, proxy_url, allow_reauth_probe=True, **pull_kwargs
                    )
                except (
                    Failure,
                    OSError,
                    subprocess.SubprocessError,
                    ValueError,
                    RuntimeError,
                ):
                    pass
        # The probes above may run without host.lock (the background re-auth
        # check keeps network I/O and agy outside it, #1674). Every shared-state
        # change below needs the lock; RLock keeps locked callers unaffected.
        with self.lock:
            if self.environments.get(env["id"]) is not env:
                return self.view(env)
            prev_eligibility = (env.get("account") or {}).get("eligibility")
            prev_verified_at = (env.get("account") or {}).get("eligibility_verified_at")
            last_entry = self.last_inference.get(env["id"])
            inference_proven = bool(
                (
                    last_entry
                    and last_entry[0] == self.inference_binding(env)
                    and isinstance(last_entry[1], dict)
                    and last_entry[1].get("state") == "completed"
                )
                or prev_verified_at
            )
            if inference_proven and (
                account.get("eligibility") in ("verification_required", "client_unsupported")
                or (
                    account.get("eligibility") is None
                    and "validation_url" in account
                )
            ):
                account.pop("eligibility", None)
                account.pop("validation_url", None)
                account["eligibility_verified_at"] = prev_verified_at or now()
            if account.get("state") in ("error", "reauth_required") and env.get("account"):
                previous = env["account"]
                if previous.get("state") in ("ok", "partial") and not previous.get(
                    "data_at"
                ):
                    previous["data_at"] = previous.get("checked_at")
                previous.update(state=account["state"], checked_at=account["checked_at"])
                for err_key in (
                    "error_code",
                    "error_message",
                    "http_status",
                    "eligibility",
                    "validation_url",
                ):
                    if account.get(err_key) is not None:
                        previous[err_key] = account[err_key]
                    elif err_key in ("error_code", "error_message", "http_status"):
                        previous.pop(err_key, None)
            else:
                env["account"] = account
            if account.get("state") == "reauth_required":
                self.stop_run(env["id"])
                self.stop_native_session(env["id"])
                self._clear_runtime_proxy(env["id"])
                env.pop("call_models", None)
                self.stop_terminal(env["id"])
                env["auth_state"] = "reauth_required"
            elif account.get("state") in ("ok", "partial"):
                env["auth_state"] = "authorized"
            self.touch_environment(env)
            self.save()
            new_eligibility = (env.get("account") or {}).get("eligibility")
            existing_session = self.native_sessions.get(env["id"])
            session_poisoned = (
                existing_session is not None
                and session_diagnostic(existing_session) is not None
            )
            if (
                (prev_eligibility != new_eligibility or session_poisoned)
                and not self.running(env["id"])
            ):
                self.stop_native_session(env["id"])
                if (
                    new_eligibility not in BLOCKING_ACCOUNT_ELIGIBILITIES
                    and env.get("auth_state") == "authorized"
                ):
                    self._schedule_warm_locked(env["id"], force=True)
            return self.view(env)

    def _prewarm_license_cache_unlocked(self, envs):
        for env in envs:
            if env.get("auth_method", "oauth") == "api_key":
                continue
            cached, _ = self._get_cached_license_status(env)
            if cached is None:
                self.license_status(env, use_cache=True)

    def _resolve_infer_target(self, body):
        with self.lock:
            descriptor = os.open(
                self.directory / "maintenance.lock",
                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                0o600,
            )
            try:
                fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
                pending = self.directory / "maintenance.pending"
                if pending.exists() or pending.is_symlink():
                    raise Failure(409, "gemini_operation_busy")
            except BlockingIOError:
                raise Failure(409, "gemini_operation_busy") from None
            finally:
                os.close(descriptor)

            identifier = body.get("id")
            if not isinstance(identifier, str) or identifier not in self.environments:
                raise Failure(404)
            env = self.environments[identifier]
            if body.get("proxy_id") != env["proxy_id"]:
                raise Failure(409)
            proxy_url = body.get("proxy_url")
            proxy_config(proxy_url)
            verify_proxy_sha256(body, proxy_url)
            model = body.get("model")
            if not isinstance(model, str) or not MODEL.fullmatch(model):
                raise Failure(400, "gemini_invalid_request")
            _, key, auth = self.operation_account(env, allow_concurrent_infer=True)
            if model not in env.get("call_models", []):
                raise Failure(409, "gemini_model_unavailable")
            if key:
                return {"direct": False, "reason": "api_key"}
            ctx = {
                "identifier": identifier,
                "env": dict(env),
                "proxy_url": proxy_url,
                "egress_options": normalize_egress_options(body.get("egress_options")),
                "auth": auth,
                "model": model,
            }
            use_shard = self._use_sharded_daemon()

        worker = None
        is_shard = False
        shard_id = None
        if use_shard:
            shard, shard_id = self._acquire_shard_for_account(ctx)
            if shard is not None:
                worker = shard
                is_shard = True
        if worker is None:
            worker = self._acquire_native_session(ctx)
            is_shard = False

        if not worker.is_alive() or worker.is_severely_unhealthy():
            return {"direct": False, "reason": "warming"}
        if not getattr(worker, "_ever_ready", False):
            health = worker.health(timeout=0.35)
            if not (
                isinstance(health, dict)
                and health.get("ready") is True
                and health.get("needs_recovery") is not True
            ):
                return {"direct": False, "reason": "warming"}
            worker._ever_ready = True
            if is_shard and shard_id:
                with self.lock:
                    self._clear_shard_fault(shard_id)
        if not self._expose_direct_socket(worker):
            return {"direct": False, "reason": "socket_unavailable"}
        use_account_route = is_shard or getattr(worker, "pool_mode", False)
        return {
            "direct": True,
            "kind": "shard" if is_shard else "session",
            "socket_path": worker.socket_path,
            "token": worker.native_token,
            "message_path": (
                f"/internal/v1/accounts/{identifier}/messages"
                if use_account_route
                else "/internal/v1/messages"
            ),
            "cancel_path": (
                f"/internal/v1/accounts/{identifier}/cancel"
                if use_account_route
                else "/internal/v1/cancel"
            ),
            "account_id": identifier if use_account_route else None,
            "epoch": getattr(worker, "attempt", ""),
            "ttl_ms": 30000,
        }

    def request(self, operation, body):
        if operation == "infer-target":
            return self._resolve_infer_target(body)
        # Evaluate any uncached CRAGGemini license checks outside the global Host lock
        # so bwrap forks never stall concurrent infer/list/get traffic.
        if operation == "list":
            envs_to_warm = []
            with self.lock:
                self.inspect_payload()
                if self.payload_mode == "crag_subscription":
                    envs_to_warm = [dict(e) for e in self.environments.values()]
            if envs_to_warm:
                self._prewarm_license_cache_unlocked(envs_to_warm)
        elif operation == "get":
            env_to_warm = None
            with self.lock:
                self.inspect_payload()
                identifier = body.get("id") if isinstance(body, dict) else None
                if (
                    self.payload_mode == "crag_subscription"
                    and isinstance(identifier, str)
                    and identifier in self.environments
                ):
                    env_to_warm = dict(self.environments[identifier])
            if env_to_warm is not None:
                self._prewarm_license_cache_unlocked([env_to_warm])
        with self.lock:
            return self._locked_request(operation, body)

    def _locked_request(self, operation, body):
        if operation in {
            "list",
            "get",
            "daemon-status",
            "maintenance-status",
            "maintenance-quiesce",
            "maintenance-sandbox",
            "test-chat-status",
            "test-chat-cancel",
            "infer-cancel",
            "terminal-io",
            "terminal-stop",
        }:
            return self._request(operation, body)
        descriptor = os.open(
            self.directory / "maintenance.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            0o600,
        )
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != 0
                or info.st_nlink != 1
                or info.st_mode & 0o077
            ):
                raise Failure(503, "gemini_maintenance_lock_invalid")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure(409, "gemini_operation_busy") from None
            pending = self.directory / "maintenance.pending"
            if pending.exists() or pending.is_symlink():
                raise Failure(409, "gemini_operation_busy")
            return self._request(operation, body)
        finally:
            os.close(descriptor)

    def _request(self, operation, body):
        if operation == "maintenance-status":
            return {
                "busy": bool(
                    self.pending
                    or self.terminals
                    or any(self.active_infers.values())
                    or any(self.running(key) for key in self.runs)
                )
            }
        if operation == "maintenance-sandbox":
            issue = self.probe_sandbox(force=bool(body.get("force")))
            return {"ok": issue is None, "code": issue}
        if operation == "maintenance-quiesce":
            if (
                self.pending
                or self.terminals
                or any(self.active_infers.values())
                or any(self.running(key) for key in self.runs)
            ):
                return {"busy": True}
            stopped = 0
            for shard_id in list(getattr(self, "daemon_shards", {})):
                self._stop_shard(shard_id)
                stopped += 1
            for identifier in list(getattr(self, "native_sessions", {})):
                self.stop_native_session(identifier)
                stopped += 1
            return {"busy": False, "stopped": stopped}
        if operation == "daemon-status":
            return self.daemon_status()
        if operation == "apply-policy":
            return self.apply_runtime_policy(body.get("policy", body))
        if operation == "daemon-action":
            return self.daemon_action(body)
        if operation == "install-payload":
            self.load_payload(materialize=True, verify_again=True)
            self._invalidate_license_cache()
            return {
                "version": self.payload_version,
                "activation_required": self.payload_state == "awaiting_redemption",
            }
        if operation == "ensure-payload":
            if body:
                raise Failure(400)
            self.ensure_payload()
            self._invalidate_license_cache()
            return {
                "version": self.payload_version,
                "payload_state": self.payload_state,
                "payload_mode": self.payload_mode,
            }
        if operation == "redeem":
            result = self.redeem_payload(body.get("redemption_code"))
            self._invalidate_license_cache()
            return result
        if operation == "list":
            self.inspect_payload()
            return {
                "payload_state": self.payload_state,
                "payload_mode": self.payload_mode,
                "payload_issue": self.payload_issue,
                "release_activated": self.payload_state == "installed",
                "oauth_runtime_issue": self.oauth_runtime_issue(),
                "environments": [self.view(env) for env in self.environments.values()],
            }
        if operation == "create":
            proxy_url = body.get("proxy_url")
            proxy_config(proxy_url)
            name, proxy_id = body.get("name"), body.get("proxy_id")
            method, api_key = body.get("auth_method", "oauth"), body.get("api_key")
            if (
                not isinstance(name, str)
                or not name.strip()
                or len(name) > 80
                or not isinstance(proxy_id, str)
                or not ID.fullmatch(proxy_id)
                or method not in ("oauth", "api_key")
                or (
                    method == "api_key"
                    and (not isinstance(api_key, str) or not API_KEY.fullmatch(api_key))
                )
                or (method == "oauth" and api_key is not None)
            ):
                raise Failure(400)
            raw_concurrency = body.get("max_concurrency")
            if raw_concurrency is None:
                max_concurrency = int(
                    self.runtime_policy.get(
                        "max_concurrency_per_account", DEFAULT_ENV_CONCURRENCY
                    )
                )
            elif type(raw_concurrency) is int and 1 <= raw_concurrency <= MAX_CONCURRENCY:
                max_concurrency = raw_concurrency
            else:
                raise Failure(400, "gemini_invalid_concurrency")
            imported = body.get("oauth_account")
            credential = None
            refresh_credential = None
            if imported is not None:
                if method != "oauth" or not isinstance(imported, dict):
                    raise Failure(400, "gemini_oauth_import_invalid")
                refresh = imported.get("refresh_token")
                access = imported.get("access_token")
                raw_expiry = (
                    imported.get("expiry_timestamp")
                    if "expiry_timestamp" in imported
                    else imported.get("expiry")
                    if "expiry" in imported
                    else imported.get("expires_at")
                )
                expiry = None
                if raw_expiry is not None:
                    if type(raw_expiry) is int or type(raw_expiry) is float:
                        ts = int(raw_expiry / 1000) if raw_expiry >= 10_000_000_000 else int(raw_expiry)
                        expiry = ts if 0 < ts < 253402300800 else -1
                    elif isinstance(raw_expiry, str) and raw_expiry.strip():
                        raw_str = raw_expiry.strip()
                        if raw_str.isdigit():
                            ts_num = int(raw_str)
                            ts = ts_num // 1000 if ts_num >= 10_000_000_000 else ts_num
                            expiry = ts if 0 < ts < 253402300800 else -1
                        else:
                            norm = re.sub(r"\.[0-9]+", "", raw_str)
                            if norm.endswith("Z"):
                                norm = norm[:-1] + "+00:00"
                            try:
                                parsed_dt = datetime.fromisoformat(norm)
                                if parsed_dt.tzinfo is None:
                                    parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)
                                ts = int(parsed_dt.timestamp())
                                expiry = ts if 0 < ts < 253402300800 else -1
                            except ValueError:
                                expiry = -1
                    else:
                        expiry = -1
                auth_method_hint = imported.get("auth_method")
                wif_provider = imported.get("wif_provider")
                oauth_client_key = imported.get("oauth_client_key")
                is_gcp_tos = imported.get("is_gcp_tos")
                imported_project_id = imported.get("project_id")
                imported_email = imported.get("email")
                if auth_method_hint is not None and (
                    not isinstance(auth_method_hint, str)
                    or auth_method_hint.strip().lower() not in OAUTH_AUTH_METHODS
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                if wif_provider is not None and (
                    not isinstance(wif_provider, str)
                    or not WIF_PROVIDER.fullmatch(wif_provider)
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                if oauth_client_key is not None and (
                    not isinstance(oauth_client_key, str)
                    or not OAUTH_CLIENT_KEY.fullmatch(oauth_client_key.strip())
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                if is_gcp_tos is not None and type(is_gcp_tos) is not bool:
                    raise Failure(400, "gemini_oauth_import_invalid")
                if imported_project_id is not None and (
                    not isinstance(imported_project_id, str)
                    or not OAUTH_PROJECT_ID.fullmatch(imported_project_id.strip())
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                if imported_email is not None and (
                    not isinstance(imported_email, str)
                    or not 1 <= len(imported_email.strip()) <= 254
                    or any(ch in imported_email for ch in "\r\n\x00")
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                has_access_pair = access is not None and expiry is not None
                if access is not None and (
                    not isinstance(access, str) or not OAUTH_ACCESS_TOKEN.fullmatch(access)
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                if raw_expiry is not None and (
                    type(expiry) is not int or not 0 < expiry < 253402300800
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                if refresh is not None:
                    if not isinstance(refresh, str) or not OAUTH_REFRESH_TOKEN.fullmatch(refresh):
                        raise Failure(400, "gemini_oauth_import_invalid")
                    refresh_credential = {
                        "refresh_token": refresh,
                        **({"access_token": access, "expiry": expiry} if has_access_pair else {}),
                        **({"auth_method": auth_method_hint.strip().lower()} if auth_method_hint else {}),
                        **({"wif_provider": wif_provider} if wif_provider else {}),
                        **({"oauth_client_key": oauth_client_key.strip()} if oauth_client_key else {}),
                        **({"is_gcp_tos": is_gcp_tos} if is_gcp_tos is not None else {}),
                        **({"project_id": imported_project_id.strip()} if imported_project_id else {}),
                        **({"email": imported_email.strip()} if imported_email else {}),
                    }
                elif has_access_pair:
                    credential = {"access_token": access, "expiry": expiry}
                else:
                    raise Failure(400, "gemini_oauth_import_invalid")
            taken = {env["slot"] for env in self.environments.values()}
            slot = next(
                (slot for slot in range(MAX_ENVIRONMENTS) if slot not in taken), None
            )
            if slot is None:
                raise Failure(409)
            self.ensure_payload()
            account = {}
            call_models = None
            imported_token_doc = None
            if method == "api_key":
                account = read_account(
                    self.uid_base + (slot % MAX_NETNS_SLOTS), proxy_url, "api_key", api_key=api_key
                )
                if account["state"] == "reauth_required":
                    raise Failure(400, "gemini_api_key_rejected")
                if account["state"] not in ("ok", "partial"):
                    raise Failure(502, "gemini_account_read_failed")
                chat_data = read_account(
                    self.uid_base + (slot % MAX_NETNS_SLOTS), proxy_url, "api-key-models", api_key=api_key
                )
                if chat_data.get("state") in ("ok", "partial") and chat_data.get(
                    "models"
                ):
                    call_models = chat_data["models"]
            if refresh_credential:
                refresh_result = self.probe_refresh_imported_account(
                    slot, proxy_url, refresh_credential
                )
                account = refresh_result.get("account") or {"state": "error", "checked_at": now()}
                err_msg = refresh_result.get("error_message") or account.get("error_message")
                if (
                    refresh_result.get("error") == "oauth_client_not_configured"
                    or account.get("error_code") == "oauth_client_not_configured"
                ):
                    raise Failure(503, "gemini_oauth_client_not_configured", message=err_msg)
                if account.get("state") == "reauth_required":
                    raise Failure(400, "gemini_oauth_import_rejected", message=err_msg)
                if account.get("state") not in ("ok", "partial"):
                    raise Failure(502, "gemini_account_read_failed", message=err_msg)
                if isinstance(refresh_result.get("token_doc"), dict):
                    imported_token_doc = refresh_result["token_doc"]
                    discovered = [
                        m
                        for m in (account.get("models") or ())
                        if isinstance(m, str) and MODEL.fullmatch(m)
                    ]
                    if discovered:
                        call_models = discovered
                else:
                    raise Failure(502, "gemini_account_read_failed", message=err_msg)
            elif credential:
                account = self.probe_imported_account(slot, proxy_url, credential)
                if account["state"] == "reauth_required":
                    raise Failure(400, "gemini_oauth_import_rejected")
                if account["state"] not in ("ok", "partial"):
                    raise Failure(502, "gemini_account_read_failed")
            identifier = f"gemini-{secrets.token_hex(12)}"
            directory = self.directory / identifier
            directory.mkdir(mode=0o711)
            directory.chmod(0o711)
            timestamp = now()
            env = {
                "id": identifier,
                "name": name.strip(),
                "proxy_id": proxy_id,
                "slot": slot,
                "max_concurrency": max_concurrency,
                "auth_method": method,
                "auth_state": (
                    "authorized"
                    if method == "api_key" or credential or imported_token_doc
                    else "unverified"
                ),
                **({"oauth_imported": True} if credential and not imported_token_doc else {}),
                **({"call_models": call_models} if call_models else {}),
                "account": account,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            try:
                if method == "api_key":
                    private_json(directory / "credential.json", {"api_key": api_key})
                if imported_token_doc:
                    profile_id = self._write_imported_profile(
                        directory,
                        self.env_uid(env),
                        imported_token_doc,
                        project_id=(
                            account.get("project_id")
                            or (refresh_credential.get("project_id") if refresh_credential else None)
                        ),
                    )
                    env["profile"] = profile_id
                elif credential:
                    private_json(directory / "oauth-import.json", credential)
                self.environments[identifier] = env
                self.save()
                if imported_token_doc:
                    egress_opts = normalize_egress_options(body.get("egress_options"))
                    self._remember_runtime_proxy(env, proxy_url, egress_opts)
                    self._schedule_provision_locked(identifier, proxy_url, egress_opts)
                    self._schedule_warm_locked(identifier)
            except OSError:
                self.environments.pop(identifier, None)
                shutil.rmtree(directory)
                raise
            return self.view(env)
        identifier = body.get("id")
        if not isinstance(identifier, str) or identifier not in self.environments:
            raise Failure(404)
        env = self.environments[identifier]
        if operation == "get":
            self.inspect_payload()
            return {
                **self.view(env),
                "payload_state": self.payload_state,
                "payload_mode": self.payload_mode,
                "payload_issue": self.payload_issue,
            }
        if operation == "license-machine-code":
            return self.run_craggemini_license_cli(env, ["--license-machine-code"])
        if operation == "license-activate":
            code = body.get("code")
            if not isinstance(code, str) or not 16 <= len(code.strip()) <= 16384:
                raise Failure(400, "gemini_subscription_invalid_code")
            status = self.run_craggemini_license_cli(env, [], input_code=code)
            self._invalidate_license_cache(identifier)
            self._sync_shard_account_license(env)
            self.stop_native_session(identifier)
            self._schedule_warm_locked(identifier, force=True)
            return status
        if operation == "license-status":
            return {"license": self.license_status(env, use_cache=False)}
        if operation == "license-release-candidate":
            return self.license_release_candidate(env)
        if operation == "license-clear":
            return self.license_clear(env)
        if operation == "proxy-bind":
            return self.bind_proxy(env, body)
        if operation == "concurrency-set":
            raw_concurrency = body.get("max_concurrency")
            if type(raw_concurrency) is not int or not 1 <= raw_concurrency <= MAX_CONCURRENCY:
                raise Failure(400, "gemini_invalid_concurrency")
            run_entry = self.runs.get(identifier)
            run_active = bool(run_entry and run_entry["process"] is not None)
            if (
                run_active
                or identifier in self.terminals
                or identifier in self.pending
            ):
                raise Failure(409, "gemini_operation_busy")
            if env_concurrency(env) != raw_concurrency:
                has_active_infer = bool(self.active_infers.get(identifier))
                scaled_live = False
                shard_id = self._account_shard_map.get(identifier)
                shard = self.daemon_shards.get(shard_id) if shard_id else None
                if shard is not None and shard.is_alive() and identifier in shard.members:
                    st, _ = native_module().worker_json_request(
                        shard.socket_path,
                        shard.native_token,
                        "POST",
                        f"/internal/v1/accounts/{identifier}/scale",
                        {
                            "runnable_slots": raw_concurrency,
                            "max_concurrency": raw_concurrency,
                            "min_warm_slots": min(
                                raw_concurrency, self.runtime_policy["min_warm_slots"]
                            ),
                            "idle_ttl_secs": self.runtime_policy["session_idle_ttl_secs"],
                        },
                        timeout=5.0,
                    )
                    if st == 200:
                        shard.members[identifier]["max_concurrency"] = raw_concurrency
                        scaled_live = True
                session = self.native_sessions.get(identifier)
                if not scaled_live and session is not None and session.is_alive():
                    st, _ = native_module().worker_json_request(
                        session.socket_path,
                        session.native_token,
                        "POST",
                        f"/internal/v1/accounts/{identifier}/scale",
                        {
                            "runnable_slots": raw_concurrency,
                            "max_concurrency": raw_concurrency,
                            "min_warm_slots": min(
                                raw_concurrency, self.runtime_policy["min_warm_slots"]
                            ),
                            "idle_ttl_secs": self.runtime_policy["session_idle_ttl_secs"],
                        },
                        timeout=5.0,
                    )
                    if st == 200:
                        session.max_concurrency = raw_concurrency
                        scaled_live = True
                if not scaled_live and not has_active_infer:
                    self.stop_native_session(identifier)
                self.save_environment(
                    env,
                    {**env, "max_concurrency": raw_concurrency, "updated_at": now()},
                )
                if not scaled_live and not has_active_infer:
                    self._schedule_warm_locked(identifier, force=True)
            return self.view(env)
        if operation in ("test-chat-status", "test-chat-cancel"):
            return self.run_request(operation, identifier, body)
        if operation == "infer-cancel":
            req_id = body.get("request_id")
            if req_id is not None and (
                not isinstance(req_id, str) or not INFER_REQUEST_ID.fullmatch(req_id)
            ):
                raise Failure(400)
            return {"cancelled": self.cancel_infer(identifier, req_id)}
        if operation in ("terminal-start", "terminal-io", "terminal-stop"):
            return self.terminal_request(operation, env, body)
        if operation == "logout":
            if env.get("auth_method", "oauth") != "oauth":
                raise Failure(409)
            self.cancel_infer(identifier)
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            self._remove_account_from_shard(identifier)
            self._clear_runtime_proxy(identifier)
            self.stop_terminal(identifier)
            self.cancel(identifier)
            self.recover_network(self.directory / identifier, env["slot"])
            if env.get("profile"):
                profile = self.directory / identifier / env.pop("profile")
                try:
                    shutil.rmtree(profile)
                except FileNotFoundError:
                    pass
            env.pop("account", None)
            env.pop("call_models", None)
            if env["auth_state"] != "disabled":
                env["auth_state"] = "reauth_required"
            self.touch_environment(env)
            self.save()
            return {}
        if operation in ("delete", "disable"):
            self.cancel_infer(identifier)
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            self._remove_account_from_shard(identifier)
            self._clear_runtime_proxy(identifier)
            self.stop_terminal(identifier)
            self.cancel(identifier)
            self.recover_network(self.directory / identifier, env["slot"])
            env["auth_state"] = "disabled"
            self.touch_environment(env)
            self.save()
            if operation == "delete":
                self._invalidate_license_cache(identifier)
                shutil.rmtree(self.directory / identifier)
                del self.environments[identifier]
                self.save()
            return {}
        if body.get("proxy_id") != env["proxy_id"]:
            raise Failure(409)
        proxy_url = body.get("proxy_url")
        proxy_config(proxy_url)
        verify_proxy_sha256(body, proxy_url)
        egress_opts = normalize_egress_options(body.get("egress_options"))
        if operation == "warm":
            self.ensure_payload(legacy_install=False)
            return self.warm_environment(
                env,
                proxy_url,
                model=body.get("model"),
                **({"egress_options": egress_opts} if egress_opts else {}),
            )
        if operation == "proxy-probe":
            return self.probe_proxy(env, proxy_url)
        if operation == "models":
            self._remember_runtime_proxy(env, proxy_url, egress_opts)
            return self.pull_models(
                env, proxy_url, **({"egress_options": egress_opts} if egress_opts else {})
            )
        if operation == "test-chat":
            return self.start_run(env, proxy_url, body)
        if operation == "refresh":
            self.ensure_payload(legacy_install=False)
            if env["auth_state"] not in ("authorized", "reauth_required") or (
                env.get("auth_method") != "api_key"
                and not (env.get("profile") or env.get("oauth_imported"))
            ):
                raise Failure(409)
            self._remember_runtime_proxy(env, proxy_url, egress_opts)
            return self.refresh_account(
                env, proxy_url, **({"egress_options": egress_opts} if egress_opts else {})
            )
        if env.get("auth_method", "oauth") != "oauth":
            raise Failure(409)
        if operation == "authorize":
            if identifier in self.terminals or self.running(identifier):
                raise Failure(409, "gemini_terminal_conflict")
            self.ensure_oauth_runtime()
            self.cancel(identifier)
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            env["auth_state"] = "authorizing"
            self.touch_environment(env)
            self.save()
            try:
                login = Login(
                    self,
                    env,
                    proxy_url,
                    **({"egress_options": egress_opts} if egress_opts else {}),
                )
                self.pending[identifier] = login
                return login.challenge()
            except (Failure, OSError, subprocess.SubprocessError) as error:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                self.touch_environment(env)
                self.save()
                stage = (
                    error.stage
                    if isinstance(error, Failure) and error.stage in AUTH_FAILURE_STAGES
                    else None
                )
                code = (
                    error.code
                    if isinstance(error, Failure) and error.code in SANDBOX_ERROR_CODES
                    else "gemini_authorization_unavailable"
                )
                if (
                    isinstance(error, Failure)
                    and isinstance(error.reason, str)
                    and SAFE_AUTH_REASON.fullmatch(error.reason)
                ):
                    reason_kind = error.reason
                else:
                    cause = getattr(error, "__cause__", None) or error
                    if isinstance(cause, subprocess.TimeoutExpired):
                        reason_kind = "timeout"
                    elif isinstance(cause, subprocess.CalledProcessError) and isinstance(
                        cause.returncode, int
                    ):
                        reason_kind = f"exit_code={cause.returncode}"
                    elif isinstance(cause, OSError):
                        reason_kind = "os_error"
                    else:
                        reason_kind = "failed"
                stage_text = f" stage={stage}" if stage else ""
                print(
                    f"Gemini CLI authorization did not start{stage_text} reason={reason_kind}",
                    file=sys.stderr,
                )
                raise Failure(503, code, stage=stage) from error
        if operation == "complete":
            self.ensure_payload(legacy_install=False)
            login = self.pending.get(identifier)
            code = body.get("code")
            state = body.get("state")
            if (
                not login
                or body.get("attempt_id") != login.attempt
                or not isinstance(code, str)
                or (
                    state is not None
                    and (
                        not isinstance(state, str)
                        or not re.fullmatch(r"[A-Za-z0-9._~-]{1,512}", state)
                    )
                )
            ):
                raise Failure(409)
            login.submit(code, state, proxy_url)
            return self.view(env)
        raise Failure(404)

    @staticmethod
    def _extract_native_turn_body(model, body_obj):
        if not isinstance(body_obj, dict):
            return None
        if not _NATIVE_ALLOWED_TOP.issuperset(body_obj):
            return None
        mode = body_obj.get("system_prompt_mode")
        if mode is not None and mode not in ("official_full", "zero"):
            return None
        contents = body_obj.get("contents")
        if not isinstance(contents, list) or not contents:
            return None
        has_substantive_part = False
        cleaned_contents = []
        for entry in contents:
            if not isinstance(entry, dict) or any(k not in ("role", "parts") for k in entry):
                return None
            if entry.get("role") not in (None, "user", "model"):
                return None
            parts = entry.get("parts")
            if not isinstance(parts, list) or not parts:
                return None
            cleaned_parts = []
            for part in parts:
                if not isinstance(part, dict) or not part or not _NATIVE_ALLOWED_PART_KEYS.issuperset(part):
                    return None
                if "text" in part:
                    text = part["text"]
                    if not isinstance(text, str):
                        return None
                    if _NATIVE_ILLEGAL_CTRL_RE.search(text):
                        return None
                    if text.strip() and part.get("thought") is not True:
                        has_substantive_part = True
                if not has_substantive_part and not _NATIVE_SUBSTANTIVE_PART_KEYS.isdisjoint(part):
                    has_substantive_part = True
                # CRAGGemini SHM does not consume historical thought blocks.
                if part.get("thought") is True:
                    continue
                fd = part.get("fileData") if isinstance(part.get("fileData"), dict) else part.get("file_data")
                if isinstance(fd, dict):
                    mime = fd.get("mimeType") or fd.get("mime_type") or "application/octet-stream"
                    uri = fd.get("fileUri") or fd.get("file_uri") or ""
                    ref = f"[Attached {mime}: {uri}]" if uri else f"[Attached {mime}]"
                    cleaned_parts.append({"text": ref})
                    continue
                if (
                    part.get("thoughtSignature") == "skip_thought_signature_validator"
                    or part.get("thought_signature") == "skip_thought_signature_validator"
                ):
                    cleaned_part = {
                        k: v
                        for k, v in part.items()
                        if not (
                            k in ("thoughtSignature", "thought_signature")
                            and v == "skip_thought_signature_validator"
                        )
                    }
                    if cleaned_part:
                        cleaned_parts.append(cleaned_part)
                else:
                    cleaned_parts.append(part)
            if cleaned_parts:
                cleaned_entry = {"parts": cleaned_parts}
                if entry.get("role") is not None:
                    cleaned_entry["role"] = entry["role"]
                cleaned_contents.append(cleaned_entry)
        if not has_substantive_part or not cleaned_contents:
            return None

        forwarded = {"model": model, "contents": cleaned_contents}

        sys_inst = body_obj.get("systemInstruction")
        if sys_inst is None:
            sys_inst = body_obj.get("system_instruction")
        if sys_inst is not None:
            forwarded["systemInstruction"] = sys_inst

        if mode is not None:
            forwarded["system_prompt_mode"] = mode

        raw_tool_cfg = body_obj.get("toolConfig")
        if raw_tool_cfg is None:
            raw_tool_cfg = body_obj.get("tool_config")
        fc_cfg = None
        if isinstance(raw_tool_cfg, dict):
            fc_cfg = raw_tool_cfg.get("functionCallingConfig")
            if not isinstance(fc_cfg, dict):
                fc_cfg = raw_tool_cfg.get("function_calling_config")
        tool_mode_none = isinstance(fc_cfg, dict) and str(fc_cfg.get("mode", "")).upper() == "NONE"

        if not tool_mode_none and isinstance(body_obj.get("tools"), list):
            cleaned_tools = []
            for t in body_obj["tools"]:
                if not isinstance(t, dict):
                    continue
                filtered = {k: v for k, v in t.items() if k in _NATIVE_ALLOWED_TOOL_KEYS}
                if filtered:
                    cleaned_tools.append(filtered)
            if cleaned_tools:
                forwarded["tools"] = cleaned_tools
                if isinstance(raw_tool_cfg, dict) and raw_tool_cfg:
                    forwarded["toolConfig"] = raw_tool_cfg

        raw_gen = body_obj.get("generationConfig")
        if raw_gen is None:
            raw_gen = body_obj.get("generation_config")
        if isinstance(raw_gen, dict):
            cleaned_gen = {}
            raw_mods = raw_gen.get("responseModalities")
            if raw_mods is None:
                raw_mods = raw_gen.get("response_modalities")
            if isinstance(raw_mods, list):
                mods = [
                    str(m).upper()
                    for m in raw_mods
                    if isinstance(m, str) and m.upper() in ("TEXT", "IMAGE")
                ]
                if "IMAGE" in mods:
                    cleaned_gen["responseModalities"] = mods
            raw_img = raw_gen.get("imageConfig")
            if raw_img is None:
                raw_img = raw_gen.get("image_config")
            if isinstance(raw_img, dict):
                clean_img = {}
                ratio = raw_img.get("aspectRatio")
                if ratio is None:
                    ratio = raw_img.get("aspect_ratio")
                if isinstance(ratio, str) and ratio.strip() in _NATIVE_VALID_ASPECT_RATIOS:
                    clean_img["aspectRatio"] = ratio.strip()
                size = raw_img.get("imageSize")
                if size is None:
                    size = raw_img.get("image_size")
                if isinstance(size, str) and size.strip().upper() in _NATIVE_VALID_IMAGE_SIZES:
                    clean_img["imageSize"] = size.strip().upper()
                if clean_img:
                    cleaned_gen["imageConfig"] = clean_img
            cand_count = raw_gen.get("candidateCount")
            if cand_count is None:
                cand_count = raw_gen.get("candidate_count")
            if (
                ("responseModalities" in cleaned_gen or "imageConfig" in cleaned_gen)
                and isinstance(cand_count, int)
                and not isinstance(cand_count, bool)
                and 1 <= cand_count <= 8
            ):
                cleaned_gen["candidateCount"] = cand_count
            raw_tc = raw_gen.get("thinkingConfig")
            if raw_tc is None:
                raw_tc = raw_gen.get("thinking_config")
            if isinstance(raw_tc, dict):
                clean_tc = {}
                inc = raw_tc.get("includeThoughts")
                if inc is None:
                    inc = raw_tc.get("include_thoughts")
                if isinstance(inc, bool):
                    clean_tc["includeThoughts"] = inc
                lvl = raw_tc.get("thinkingLevel")
                if lvl is None:
                    lvl = raw_tc.get("thinking_level")
                if isinstance(lvl, str) and lvl.strip().lower() in (
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "extra_high",
                    "none",
                ):
                    clean_tc["thinkingLevel"] = lvl.strip().lower()
                budget = raw_tc.get("thinkingBudget")
                if budget is None:
                    budget = raw_tc.get("thinking_budget")
                if isinstance(budget, int) and not isinstance(budget, bool) and -1 <= budget <= 131072:
                    clean_tc["thinkingBudget"] = budget
                if clean_tc:
                    cleaned_gen["thinkingConfig"] = clean_tc
            if cleaned_gen:
                forwarded["generationConfig"] = cleaned_gen

        conv_id = body_obj.get("conversation_id")
        if not isinstance(conv_id, str) or not conv_id:
            conv_id = body_obj.get("conversationId")
        if isinstance(conv_id, str) and _NATIVE_CONV_ID_RE.fullmatch(conv_id):
            forwarded["conversation_id"] = conv_id

        return forwarded

    @staticmethod
    def _redact_bytes(chunk, secret_values):
        for secret in secret_values:
            if secret and secret in chunk:
                chunk = chunk.replace(secret, b"[redacted]")
        return chunk

    def _begin_infer(self, body):
        identifier = body.get("id")
        if not isinstance(identifier, str) or identifier not in self.environments:
            raise Failure(404)
        env = self.environments[identifier]
        if body.get("proxy_id") != env["proxy_id"]:
            raise Failure(409)
        proxy_url = body.get("proxy_url")
        proxy_config(proxy_url)
        verify_proxy_sha256(body, proxy_url)
        model = body.get("model")
        request_id = body.get("request_id")
        infer_body = body.get("body")
        if (
            not isinstance(model, str)
            or not MODEL.fullmatch(model)
            or not isinstance(request_id, str)
            or not INFER_REQUEST_ID.fullmatch(request_id)
            or not isinstance(infer_body, dict)
        ):
            raise Failure(400, "gemini_invalid_request")
        descriptor = os.open(
            self.directory / "maintenance.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            0o600,
        )
        try:
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            pending = self.directory / "maintenance.pending"
            if pending.exists() or pending.is_symlink():
                raise Failure(409, "gemini_operation_busy")
        except BlockingIOError:
            raise Failure(409, "gemini_operation_busy") from None
        finally:
            os.close(descriptor)

        uid, key, auth = self.operation_account(env, allow_concurrent_infer=True)
        if request_id in self.active_infers.get(identifier, {}):
            raise Failure(409, "gemini_operation_busy")
        if model not in env.get("call_models", []):
            raise Failure(409, "gemini_model_unavailable")
        native_body = None
        if not key:
            native_body = self._extract_native_turn_body(model, infer_body)
            if native_body is None:
                raise Failure(400, "gemini_unsupported_turn")
        evidence = {
            "state": "running",
            "model": model,
            "started_at": now(),
            "finished_at": None,
            "error_code": None,
        }
        self.last_inference[identifier] = (
            self.inference_binding(env),
            evidence,
            hashlib.sha256(proxy_url.encode()).hexdigest(),
        )
        cancel_event = threading.Event()
        infer_entry = {
            "request_id": request_id,
            "cancel_event": cancel_event,
            "cancel_fn": None,
        }
        self.active_infers.setdefault(identifier, {})[request_id] = infer_entry
        gateway_policy = body.get("gateway_policy")
        if not isinstance(gateway_policy, dict):
            gateway_policy = None
        restart_resume = body.get("restart_resume") is True
        return {
            "identifier": identifier,
            "env": dict(env),
            "uid": uid,
            "key": key,
            "auth": auth,
            "proxy_url": proxy_url,
            "egress_options": normalize_egress_options(body.get("egress_options")),
            "model": model,
            "request_id": request_id,
            "infer_body": infer_body,
            "native_body": native_body,
            "gateway_policy": gateway_policy,
            "restart_resume": restart_resume,
            "evidence": evidence,
            "entry": infer_entry,
        }

    def stream_infer(self, body, handler):
        with self.lock:
            ctx = self._begin_infer(body)
        identifier = ctx["identifier"]
        evidence = ctx["evidence"]
        cancel_event = ctx["entry"]["cancel_event"]
        final_state = "failed"
        final_code = "gemini_inference_failed"
        try:
            if ctx["key"]:
                final_state, final_code = self._stream_api_key_infer(ctx, handler)
            else:
                final_state, final_code = self._stream_native_infer(ctx, handler)
        except Failure as error:
            final_state = "cancelled" if cancel_event.is_set() else "failed"
            final_code = error.code or "gemini_inference_failed"
            handler.send_json_error(error.status, final_code)
        except (BrokenPipeError, ConnectionResetError):
            final_state = "cancelled"
            final_code = "gemini_inference_cancelled"
        except (OSError, subprocess.SubprocessError, ValueError):
            final_state = "failed"
            final_code = "gemini_inference_failed"
            handler.send_json_error(502, final_code)
        finally:
            with self.lock:
                slot_map = self.active_infers.get(identifier)
                if slot_map is not None:
                    slot_map.pop(ctx["request_id"], None)
                    if not slot_map:
                        self.active_infers.pop(identifier, None)
                self.finish_inference(
                    evidence,
                    final_state,
                    None if final_state == "completed" else final_code,
                )
                if final_state == "completed":
                    self._clear_eligibility_on_inference_success_locked(identifier)
                elif final_state == "failed":
                    self._clear_eligibility_verified_on_failure_locked(
                        identifier, final_code
                    )

    @staticmethod
    def _parse_google_duration_ms(raw):
        if not isinstance(raw, str):
            return None
        text = raw.strip()
        if not text or len(text) > 64:
            return None
        total_ms = 0.0
        pos = 0
        for match in re.finditer(r"(\d+(?:\.\d+)?)(ms|s|m|h)", text):
            if match.start() != pos:
                return None
            pos = match.end()
            val = float(match.group(1))
            unit = match.group(2)
            factor = {"ms": 1.0, "s": 1000.0, "m": 60000.0, "h": 3600000.0}[unit]
            total_ms += val * factor
        if pos != len(text) or total_ms <= 0:
            return None
        return max(1, min(3_600_000, int(-(-total_ms // 1))))

    @classmethod
    def _parse_google_quota_error(cls, parsed_err):
        if not isinstance(parsed_err, dict):
            return None, None, False
        err_obj = parsed_err.get("error") if isinstance(parsed_err.get("error"), dict) else parsed_err
        details = err_obj.get("details") if isinstance(err_obj, dict) else None
        retry_after_ms = None
        upstream_reason = None
        if isinstance(details, list):
            for item in details:
                if not isinstance(item, dict):
                    continue
                reason = item.get("reason")
                if isinstance(reason, str) and reason and upstream_reason is None:
                    upstream_reason = reason
                delay_ms = cls._parse_google_duration_ms(item.get("retryDelay"))
                if delay_ms is not None:
                    retry_after_ms = max(retry_after_ms or 0, delay_ms)
                meta = item.get("metadata")
                if isinstance(meta, dict):
                    qdelay = cls._parse_google_duration_ms(meta.get("quotaResetDelay"))
                    if qdelay is not None:
                        retry_after_ms = max(retry_after_ms or 0, qdelay)
                    ts_raw = meta.get("quotaResetTimeStamp")
                    if isinstance(ts_raw, str) and ts_raw.strip():
                        try:
                            dt = datetime.fromisoformat(ts_raw.strip().replace("Z", "+00:00"))
                            delta_ms = int((dt.timestamp() - time.time()) * 1000)
                            if delta_ms > 0:
                                retry_after_ms = max(
                                    retry_after_ms or 0, min(3_600_000, delta_ms)
                                )
                        except ValueError:
                            pass
        content_rejected = (
            isinstance(err_obj, dict)
            and err_obj.get("status") == "RESOURCE_EXHAUSTED"
            and upstream_reason is None
            and retry_after_ms is None
        )
        return retry_after_ms, upstream_reason, content_rejected

    @staticmethod
    def _emit_json_error(
        handler,
        status,
        code=None,
        message=None,
        *,
        retry_after_ms=None,
        upstream_reason=None,
        content_rejected=False,
    ):
        extra = {}
        if retry_after_ms is not None:
            extra["retry_after_ms"] = retry_after_ms
        if isinstance(upstream_reason, str) and upstream_reason:
            extra["upstream_reason"] = upstream_reason
        if content_rejected:
            extra["content_rejected"] = True
        handler.send_json_error(status, code, message, **extra)

    def _stream_api_key_infer(self, ctx, handler):
        key = ctx["key"]
        cancel_event = ctx["entry"]["cancel_event"]
        secret_bytes = (key.encode("utf-8"),)
        proc = subprocess.Popen(
            account_command(ctx["uid"], "api-key-stream"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            bufsize=0,
            env=SYSTEM_ENV,
        )

        def stop_proc():
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

        ctx["entry"]["cancel_fn"] = stop_proc
        try:
            payload = json.dumps(
                {
                    "api_key": key,
                    "proxy_url": ctx["proxy_url"],
                    "model": ctx["model"],
                    "body": ctx["infer_body"],
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            proc.stdin.write(payload)
            proc.stdin.close()
            header_line = proc.stdout.readline(1024)
            parts = header_line.decode("ascii", errors="replace").strip().split(" ", 2)
            status = int(parts[1]) if len(parts) >= 2 and parts[0] == "STATUS" and parts[1].isdigit() else 0
            ct = (parts[2] if len(parts) >= 3 else "").split(";", 1)[0].strip().lower()
            if status != 200 or ct != "text/event-stream":
                raw_err = proc.stdout.read(65536) if proc.stdout else b""
                err_msg = None
                retry_after_ms = None
                upstream_reason = None
                content_rejected = False
                try:
                    parsed_err = json.loads(raw_err) if raw_err else {}
                    err_obj = parsed_err.get("error") if isinstance(parsed_err, dict) else None
                    if isinstance(err_obj, dict) and isinstance(err_obj.get("message"), str):
                        err_msg = err_obj["message"][:512]
                    if status == 429:
                        retry_after_ms, upstream_reason, content_rejected = (
                            self._parse_google_quota_error(parsed_err)
                        )
                except ValueError:
                    pass
                code = {
                    0: "gemini_proxy_error",
                    400: "gemini_invalid_request",
                    401: "gemini_api_key_invalid",
                    403: "gemini_api_key_invalid",
                    404: "gemini_model_unavailable",
                    429: "gemini_content_rejected" if content_rejected else "gemini_quota_exhausted",
                }.get(status, "gemini_inference_failed")
                http_status = status if 400 <= status <= 599 else 502
                self._emit_json_error(
                    handler,
                    http_status,
                    code,
                    err_msg,
                    retry_after_ms=retry_after_ms,
                    upstream_reason=upstream_reason,
                    content_rejected=content_rejected,
                )
                return "failed", code
            handler.begin_sse()
            while not cancel_event.is_set():
                chunk = (
                    proc.stdout.read1(_SSE_STREAM_READ_BYTES)
                    if hasattr(proc.stdout, "read1")
                    else proc.stdout.read(_SSE_STREAM_READ_BYTES)
                )
                if not chunk:
                    break
                handler.write_sse_chunk(self._redact_bytes(chunk, secret_bytes))
            if cancel_event.is_set():
                return "cancelled", "gemini_inference_cancelled"
            return "completed", None
        finally:
            stop_proc()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)

    def _acquire_native_session(self, ctx):
        identifier = ctx["identifier"]
        egress_opts = normalize_egress_options(ctx.get("egress_options"))
        egress_key = egress_fingerprint(ctx["proxy_url"], egress_opts)
        desired_concurrency = env_concurrency(ctx["env"])
        with self._session_lock(identifier):
            with self.lock:
                self._remember_runtime_proxy(ctx["env"], ctx["proxy_url"], egress_opts)
                existing = self.native_sessions.get(identifier)
                if (
                    existing is not None
                    and getattr(existing, "max_concurrency", 1) == desired_concurrency
                    and secrets.compare_digest(_session_egress_key(existing), egress_key)
                    and existing.is_alive()
                    and not existing.is_severely_unhealthy()
                ):
                    existing.last_used = time.monotonic()
                    return existing
                if existing is not None:
                    self.stop_native_session(identifier)
            session = NativeSession(
                self,
                ctx["env"],
                ctx["proxy_url"],
                ctx["auth"],
                ctx["model"],
                **({"egress_options": egress_opts} if egress_opts else {}),
            )
            with self.lock:
                self.native_sessions[identifier] = session
                getattr(self, "_warm_backoff", {}).pop(identifier, None)
            return session

    def _stream_native_infer(self, ctx, handler):
        identifier = ctx["identifier"]
        cancel_event = ctx["entry"]["cancel_event"]
        creds = tuple(
            v.encode("utf-8")
            for v in (ctx["auth"][0] if ctx["auth"] else ())
            if isinstance(v, str) and v
        )
        native_mod = native_module()
        gateway_policy = ctx.get("gateway_policy")
        shard = None
        shard_id = None
        if self._use_sharded_daemon():
            shard, shard_id = self._acquire_shard_for_account(ctx)
        if shard is not None:
            conn = None
            had_error = False
            stream_started = False

            def stop_shard_turn():
                shard.cancel_turn(identifier, ctx["request_id"])
                if conn is not None:
                    try:
                        conn.close()
                    except OSError:
                        pass

            ctx["entry"]["cancel_fn"] = stop_shard_turn
            try:
                shard_kwargs = {
                    "model": ctx["model"],
                    "gateway_policy": gateway_policy,
                }
                if ctx.get("restart_resume") is True:
                    shard_kwargs["restart_resume"] = True
                conn, response = shard.open_stream(
                    identifier,
                    ctx["request_id"],
                    ctx["native_body"],
                    **shard_kwargs,
                )
                if shard_id:
                    with self.lock:
                        self._clear_shard_fault(shard_id)
                stream_started = True
                handler.begin_sse()
                while not cancel_event.is_set():
                    chunk = response.read1(_SSE_STREAM_READ_BYTES)
                    if not chunk:
                        break
                    handler.write_sse_chunk(self._redact_bytes(chunk, creds))
                if cancel_event.is_set():
                    had_error = True
                    return "cancelled", "gemini_inference_cancelled"
                return "completed", None
            except native_mod.NativeFailure as error:
                had_error = error.code != "gemini_unsupported_turn"
                if (
                    not stream_started
                    and error.status == 503
                    and error.code
                    in (
                        "gemini_native_worker_unavailable",
                        "gemini_native_bridge_timeout",
                    )
                    and self.runtime_policy.get("daemon_fault_isolation", True)
                    and (not shard.is_alive() or shard.is_severely_unhealthy())
                ):
                    pass
                else:
                    status = error.status or 502
                    self._emit_json_error(
                        handler,
                        status,
                        error.code,
                        error.message,
                        retry_after_ms=error.retry_after_ms,
                        upstream_reason=getattr(error, "upstream_reason", None),
                        content_rejected=getattr(error, "content_rejected", False),
                    )
                    return "failed", error.code
            except (BrokenPipeError, ConnectionResetError):
                had_error = True
                stop_shard_turn()
                raise
            except (OSError, TimeoutError, HTTPException):
                had_error = True
                if (
                    not stream_started
                    and self.runtime_policy.get("daemon_fault_isolation", True)
                    and (not shard.is_alive() or shard.is_severely_unhealthy())
                ):
                    pass
                else:
                    handler.send_json_error(502, "gemini_inference_failed")
                    return "failed", "gemini_inference_failed"
            finally:
                if conn is not None:
                    conn.close()
                unhealthy = not shard.is_alive()
                if not unhealthy and had_error:
                    shard.health(timeout=0.5)
                    unhealthy = shard.is_severely_unhealthy()
                if unhealthy and shard_id:
                    with self.lock:
                        if self.daemon_shards.get(shard_id) is shard:
                            self._stop_shard(shard_id)
                            self._record_shard_fault(shard_id)

        session = self._acquire_native_session(ctx)
        conn = None
        had_error = False

        def stop_native():
            session.cancel_turn(ctx["request_id"])
            if conn is not None:
                try:
                    conn.close()
                except OSError:
                    pass

        ctx["entry"]["cancel_fn"] = stop_native
        try:
            session_kwargs = {
                "model": ctx["model"],
                "gateway_policy": gateway_policy,
            }
            if ctx.get("restart_resume") is True:
                session_kwargs["restart_resume"] = True
            conn, response = session.open_stream(
                ctx["request_id"],
                ctx["native_body"],
                **session_kwargs,
            )
            handler.begin_sse()
            while not cancel_event.is_set():
                chunk = response.read1(_SSE_STREAM_READ_BYTES)
                if not chunk:
                    break
                handler.write_sse_chunk(self._redact_bytes(chunk, creds))
            if cancel_event.is_set():
                had_error = True
                return "cancelled", "gemini_inference_cancelled"
            session.last_used = time.monotonic()
            if (
                session.native_diagnostic is not None
                and hasattr(session.native_diagnostic, "clear_advisory")
            ):
                session.native_diagnostic.clear_advisory()
            return "completed", None
        except native_mod.NativeFailure as error:
            had_error = error.code != "gemini_unsupported_turn"
            diagnostic = (
                session.native_diagnostic.poll(final=True)
                if session.native_diagnostic is not None
                else None
            )
            code = diagnostic or error.code
            if code in (
                "gemini_location_unsupported",
                "gemini_account_verification_required",
                "gemini_client_unsupported",
                "gemini_account_ineligible",
            ):
                status = 403
                message = None
            else:
                status = error.status or 502
                message = error.message
            self._emit_json_error(
                handler,
                status,
                code,
                message,
                retry_after_ms=error.retry_after_ms,
                upstream_reason=getattr(error, "upstream_reason", None),
                content_rejected=getattr(error, "content_rejected", False),
            )
            return "failed", code
        except (BrokenPipeError, ConnectionResetError):
            had_error = True
            stop_native()
            raise
        except (OSError, TimeoutError, HTTPException):
            had_error = True
            handler.send_json_error(502, "gemini_inference_failed")
            return "failed", "gemini_inference_failed"
        finally:
            if conn is not None:
                conn.close()
            diag_code = None
            unhealthy = not session.is_alive()
            if not unhealthy:
                diag_code = session_diagnostic(session)
                if diag_code is not None:
                    unhealthy = True
                elif had_error:
                    session.health(timeout=0.5)
                    unhealthy = session.is_severely_unhealthy()
            if unhealthy:
                with self.lock:
                    if self.native_sessions.get(identifier) is session:
                        self.stop_native_session(identifier)
                        if diag_code is None:
                            self._schedule_warm_locked(identifier, force=True)


class ThreadingUnixStreamServer(
    socketserver.ThreadingMixIn, socketserver.UnixStreamServer
):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


class ControlHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(2)
        self._headers_sent = False
        super().setup()

    def send_json_error(
        self,
        status,
        code=None,
        message=None,
        retry_after_ms=None,
        upstream_reason=None,
        content_rejected=False,
    ):
        if self._headers_sent:
            return
        payload = {}
        if code:
            payload["code"] = code
        if message:
            payload["message"] = message
        if isinstance(upstream_reason, str) and upstream_reason:
            payload["upstream_reason"] = upstream_reason
        if content_rejected:
            payload["content_rejected"] = True
        retry_after_sec = None
        if type(retry_after_ms) is int and retry_after_ms > 0:
            payload["retry_after_ms"] = retry_after_ms
            retry_after_sec = max(1, (retry_after_ms + 999) // 1000)
        data = json.dumps(payload).encode()
        self._headers_sent = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            if retry_after_sec is not None:
                self.send_header("Retry-After", str(retry_after_sec))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return

    def begin_sse(self):
        if self._headers_sent:
            return
        self._headers_sent = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

    def write_sse_chunk(self, chunk):
        if not chunk:
            return
        self.wfile.write(chunk)
        self.wfile.flush()

    def do_POST(self):
        operation = self.path[1:] if self.path.startswith("/") else self.path
        try:
            length = int(self.headers.get("Content-Length", 0))
            if operation == "infer":
                if not hasattr(self.server.host, "stream_infer"):
                    raise Failure(404)
                self.request.settimeout(300)
                if length < 1 or length > MAX_INFER_BODY:
                    raise Failure(413 if length > MAX_INFER_BODY else 400)
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise Failure(400)
                self.server.host.stream_infer(body, self)
                return
            if length < 1 or length > (
                32768
                if operation in ("create", "test-chat")
                else 16384
                if operation == "license-activate"
                else 8192
            ):
                raise Failure(400)
            if operation not in {
                "list",
                "redeem",
                "get",
                "create",
                "authorize",
                "complete",
                "refresh",
                "disable",
                "delete",
                "logout",
                "terminal-start",
                "terminal-io",
                "terminal-stop",
                "install-payload",
                "ensure-payload",
                "maintenance-status",
                "maintenance-quiesce",
                "maintenance-sandbox",
                "proxy-probe",
                "proxy-bind",
                "concurrency-set",
                "models",
                "test-chat",
                "test-chat-status",
                "test-chat-cancel",
                "infer-cancel",
                "infer-target",
                "warm",
                "apply-policy",
                "daemon-status",
                "daemon-action",
                "license-machine-code",
                "license-activate",
                "license-status",
                "license-release-candidate",
                "license-clear",
            }:
                raise Failure(404)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise Failure(400)
            if operation in (
                "install-payload",
                "maintenance-status",
                "maintenance-quiesce",
                "maintenance-sandbox",
            ):
                _, uid, _ = struct.unpack(
                    "3i",
                    self.request.getsockopt(
                        socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
                    ),
                )
                if uid != 0:
                    raise Failure(403)
                if operation == "maintenance-sandbox":
                    if body and (
                        set(body) != {"force"} or type(body["force"]) is not bool
                    ):
                        raise Failure(400)
                elif body:
                    raise Failure(400)
            status, payload = 200, self.server.host.request(operation, body)
        except Failure as error:
            payload = {"code": error.code} if error.code else {}
            if error.message:
                payload["message"] = error.message
            if error.stage in AUTH_FAILURE_STAGES:
                payload["stage"] = error.stage
            status = error.status
        except (ValueError, TimeoutError, RecursionError):
            status, payload = 400, {}
        except (OSError, subprocess.SubprocessError):
            print("Gemini host operation failed", file=sys.stderr)
            status, payload = 503, {}
        if self._headers_sent:
            return
        data = json.dumps(payload).encode()
        self._headers_sent = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return

    def log_message(self, *_args):
        return


def socket_identity(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
        raise RuntimeError("Gemini socket path is not an owned socket")
    return info.st_dev, info.st_ino


def remove_stale_socket(path):
    stale = socket_identity(path)
    if stale is None:
        return
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(0.25)
        try:
            client.connect(str(path))
        except ConnectionRefusedError:
            if socket_identity(path) == stale:
                path.unlink()
            return
    raise RuntimeError("Gemini socket already has a listener")


def main():
    parser = argparse.ArgumentParser()
    for name in ("state", "payload", "public-key", "egress", "socket"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--payload-source", type=Path)
    parser.add_argument("--default-public-key", type=Path)
    parser.add_argument("--default-release-verifier", type=Path)
    parser.add_argument("--release-verifier", type=Path)
    parser.add_argument("--crag-host-dir", type=Path)
    parser.add_argument("--gateway-group", required=True)
    parser.add_argument("--uid-base", type=int, required=True)
    args = parser.parse_args()
    if (args.default_public_key is None) != (args.default_release_verifier is None):
        parser.error(
            "--default-public-key and --default-release-verifier must be used together"
        )
    if os.geteuid() != 0 or not 1024 <= args.uid_base <= 65524:
        raise SystemExit("Gemini host setup requires root and a dedicated UID range")
    os.umask(0o077)
    for uid in range(args.uid_base, args.uid_base + MAX_NETNS_SLOTS + 1):
        try:
            pwd.getpwuid(uid)
        except KeyError:
            continue
        raise SystemExit("Gemini UID range overlaps a host user")
    if any(
        args.uid_base <= account.gr_gid <= args.uid_base + MAX_NETNS_SLOTS
        for account in grp.getgrall()
    ):
        raise SystemExit("Gemini GID range overlaps a host group")
    if not args.state.is_absolute():
        raise SystemExit("Gemini host paths must be absolute")
    check_root_owned(args.state.parent)
    args.state.mkdir(mode=0o711, exist_ok=True)
    for entry in (
        ROOT,
        Path(__file__),
        ROOT / "scripts/gemini-host-egress.sh",
        ROOT / "scripts/install-gemini-payload.mjs",
        ROOT / "scripts/gemini_host_account.py",
        INFERENCE_MODULE,
        NATIVE_MODULE,
        ROOT / "src/lib/gemini/payload.mjs",
        args.state,
        args.socket.parent,
    ):
        if not entry.is_absolute():
            raise SystemExit("Gemini host paths must be absolute")
        check_root_owned(entry)
    args.state.chmod(0o711)
    for entry in (
        args.payload,
        args.public_key,
        args.egress,
        args.payload_source,
        args.default_public_key,
        args.default_release_verifier,
        args.release_verifier,
        args.crag_host_dir,
    ):
        if entry is not None and not entry.is_absolute():
            raise SystemExit("Gemini host paths must be absolute")
    lock = os.open(
        args.state / "service.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    remove_stale_socket(args.socket)
    host = Host(args)
    bound = None
    stop = False

    def shutdown(*_args):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        with ThreadingUnixStreamServer(str(args.socket), ControlHandler) as server:
            bound = socket_identity(args.socket)
            os.chown(args.socket, 0, grp.getgrnam(args.gateway_group).gr_gid)
            args.socket.chmod(0o660)
            server.host = host
            server.timeout = 0.25
            notify_socket = os.environ.get("NOTIFY_SOCKET")
            if notify_socket:
                address = (
                    "\0" + notify_socket[1:]
                    if notify_socket.startswith("@")
                    else notify_socket
                )
                with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
                    notify.sendto(b"READY=1", address)
            last_cleanup = time.monotonic()
            while not stop:
                server.handle_request()
                now_mono = time.monotonic()
                if now_mono - last_cleanup >= 0.25:
                    last_cleanup = now_mono
                    host.cleanup()
    finally:
        try:
            host.close()
        finally:
            if bound is not None and socket_identity(args.socket) == bound:
                args.socket.unlink()
            os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit("Gemini host failed to start or lost its managed runtime")
