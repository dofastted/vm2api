import json
import os
import re
import stat
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlencode


MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
ACCESS_TOKEN_RE = re.compile(r"[A-Za-z0-9._~+/-]{1,4096}={0,2}\Z")
REFRESH_TOKEN_RE = re.compile(r"1//[0-9A-Za-z._~+/-]{6,2048}\Z")
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_WIF_TOKEN_URL = "https://sts.googleapis.com/v1/oauthtoken"
OAUTH_CLIENT_ENV_KEYS = (
    "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID",
    "KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET",
    "KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID",
    "KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET",
    "KIN_GEMINI_OAUTH_WIF_CLIENT_ID",
)


def _resolve_oauth_clients(oauth_clients=None):
    source = oauth_clients if isinstance(oauth_clients, dict) else os.environ

    def read_cfg(key):
        value = source.get(key)
        if not isinstance(value, str):
            return None
        trimmed = value.strip()
        return trimmed or None

    resolved = {}
    consumer_id = read_cfg("KIN_GEMINI_OAUTH_CONSUMER_CLIENT_ID")
    if consumer_id:
        resolved["consumer"] = (
            GOOGLE_OAUTH_TOKEN_URL,
            consumer_id,
            read_cfg("KIN_GEMINI_OAUTH_CONSUMER_CLIENT_SECRET"),
            "consumer",
        )
    cloud_id = read_cfg("KIN_GEMINI_OAUTH_CLOUD_CLIENT_ID")
    if cloud_id:
        resolved["cloud"] = (
            GOOGLE_OAUTH_TOKEN_URL,
            cloud_id,
            read_cfg("KIN_GEMINI_OAUTH_CLOUD_CLIENT_SECRET"),
            "gcp",
        )
    wif_id = read_cfg("KIN_GEMINI_OAUTH_WIF_CLIENT_ID")
    if wif_id:
        resolved["wif"] = (GOOGLE_WIF_TOKEN_URL, wif_id, None, "gcp")
    return resolved
GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo"
CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal:"
CODE_ASSIST_DAILY = "https://daily-cloudcode-pa.googleapis.com/v1internal:"
ANTIGRAVITY_VERSION = "2.35.2"
ANTIGRAVITY_USER_AGENT = f"antigravity/hub/{ANTIGRAVITY_VERSION} linux/amd64"
ANTIGRAVITY_API_CLIENT = "gl-node/22.21.1"
ANTIGRAVITY_FALLBACK_USER_AGENTS = (
    f"antigravity/{ANTIGRAVITY_VERSION} linux/amd64 google-api-nodejs-client/10.3.0",
    "antigravity/1.5.18 (aidev_client; os_type=linux; arch=amd64)",
    f"antigravity/hub/{ANTIGRAVITY_VERSION} (aidev_client; os_type=linux; arch=amd64)",
)
GEMINI_API = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_MODELS = GEMINI_API + "/models?pageSize=1000"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin", "LANG": "C.UTF-8"}
TOKEN_FILE = "home/.gemini/antigravity-cli/antigravity-oauth-token"


def read_token(profile):
    try:
        descriptor = os.open(
            os.path.join(profile, TOKEN_FILE),
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
        )
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
                or info.st_size > 16384
            ):
                return None
            data = json.loads(stream.read(16385))
            return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _redact_proxy_error(raw, proxy_url=None):
    text_val = raw.decode("utf-8", errors="replace").strip()[:240] if isinstance(raw, (bytes, bytearray)) else str(raw or "").strip()[:240]
    if isinstance(proxy_url, str) and proxy_url and proxy_url in text_val:
        text_val = text_val.replace(proxy_url, "[redacted proxy URL]")
    text_val = re.sub(r"(?:socks5h?|https?)://[^\s/?#<>\"`]*@[^\s<>\"`]*", "[redacted proxy URL]", text_val, flags=re.IGNORECASE)
    return text_val[:200]


def get_json(proxy_url, url, header=None, body=None, *, timeout=10):
    config_lines = [
        f"proxy = {json.dumps(proxy_url)}\n",
        'noproxy = ""\n',
    ]
    if isinstance(header, str):
        config_lines.append(f"header = {json.dumps(header)}\n")
    elif isinstance(header, (list, tuple)):
        for item in header:
            if isinstance(item, str) and item:
                config_lines.append(f"header = {json.dumps(item)}\n")
    args = [
        "curl",
        "--disable",
        "--silent",
        "--show-error",
        "--config",
        "-",
        "--proto",
        "=https",
        "--connect-timeout",
        "6",
        "--max-time",
        str(timeout),
        "--max-filesize",
        "2097152",
        "--write-out",
        "\n%{http_code}",
        url,
    ]
    if body is not None:
        config_lines.append(
            f"data-binary = {json.dumps(json.dumps(body, ensure_ascii=True))}\n"
        )
        args += ["--header", "Content-Type: application/json"]
    config = "".join(config_lines)
    try:
        output = subprocess.run(
            args,
            input=config.encode(),
            capture_output=True,
            timeout=timeout + 2,
            env=ENV,
        )
        if output.returncode != 0:
            stderr_msg = _redact_proxy_error(output.stderr, proxy_url)
            return 0, {"_transport_error": stderr_msg or f"curl exit {output.returncode}"}
        raw, _, status = output.stdout.rpartition(b"\n")
        status = int(status)
        if status != 200:
            err_data = {}
            try:
                parsed = json.loads(raw[:16384])
                if isinstance(parsed, dict):
                    err_data = parsed
            except ValueError:
                snippet = raw[:240].decode("utf-8", errors="replace").strip()
                if snippet:
                    err_data = {"_raw_error": snippet}
            return status, err_data
        data = json.loads(raw)
        return (status, data) if isinstance(data, dict) else (0, {})
    except (OSError, subprocess.SubprocessError, ValueError):
        return 0, {"_transport_error": "request failed or timed out"}


def _sanitize_error_message(raw, limit=220):
    if not isinstance(raw, str):
        return None
    cleaned = re.sub(r"\s+", " ", raw).strip()
    if not cleaned:
        return None
    return cleaned[:limit]


def classify_http_error(status, payload, *, default_code="gemini_inference_failed"):
    err_obj = payload.get("error") if isinstance(payload, dict) and isinstance(payload.get("error"), dict) else {}
    raw_msg = (
        err_obj.get("message")
        or (payload.get("error_description") if isinstance(payload, dict) else None)
        or (payload.get("message") if isinstance(payload, dict) else None)
        or (payload.get("_transport_error") if isinstance(payload, dict) else None)
        or (payload.get("_raw_error") if isinstance(payload, dict) else None)
    )
    msg = _sanitize_error_message(raw_msg)
    reason = None
    validation_url = None
    details = err_obj.get("details") if isinstance(err_obj.get("details"), list) else []
    for item in details:
        if not isinstance(item, dict):
            continue
        if not reason and isinstance(item.get("reason"), str) and item.get("reason").strip():
            reason = item["reason"].strip().upper()
        meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        for key in ("validation_url", "validationUrl", "verification_url", "verificationUrl", "url"):
            candidate = safe_google_validation_url(meta.get(key))
            if candidate and not validation_url:
                validation_url = candidate
        if not validation_url and isinstance(item.get("links"), list):
            for link in item["links"]:
                if isinstance(link, dict):
                    candidate = safe_google_validation_url(link.get("url"))
                    if candidate:
                        validation_url = candidate
                        break

    eligibility = None
    if status == 0:
        return {
            "error_code": "gemini_proxy_error",
            "error_message": msg or "无法通过绑定代理连接 Google 上游",
            "http_status": 0,
        }
    if status == 401:
        return {
            "error_code": "gemini_oauth_required",
            "error_message": msg or "Google OAuth 凭证已失效或被吊销 (401)",
            "http_status": 401,
        }
    if status == 403:
        if reason == "VALIDATION_REQUIRED" or validation_url:
            eligibility = "verification_required"
            code = "gemini_account_verification_required"
            fallback_msg = "Google 要求完成账号身份验证 (403 VALIDATION_REQUIRED)"
        elif reason == "UNSUPPORTED_REGION":
            eligibility = "location_unsupported"
            code = "gemini_location_unsupported"
            fallback_msg = "当前账号或代理出口地区不受支持 (403 UNSUPPORTED_REGION)"
        elif reason == "TOS_VIOLATION":
            eligibility = "ineligible"
            code = "gemini_account_ineligible"
            fallback_msg = "Google 因违反服务条款已停用该账号 (403 TOS_VIOLATION)"
        elif reason == "UNSUPPORTED_CLIENT":
            eligibility = "client_unsupported"
            code = "gemini_client_unsupported"
            fallback_msg = "客户端版本或标识被拒绝 (403 UNSUPPORTED_CLIENT)"
        else:
            eligibility = "ineligible"
            code = "gemini_account_ineligible"
            suffix = reason if isinstance(reason, str) and reason.strip() else "403"
            fallback_msg = (
                f"Google 判定该账号不符合 Antigravity 资格或可能已被停用 ({suffix})；"
                "若上游为 TOS_VIOLATION 请在 Google 侧申诉或更换账号"
            )
        out = {
            "error_code": code,
            "error_message": msg or fallback_msg,
            "http_status": 403,
            "eligibility": eligibility,
        }
        if validation_url:
            out["validation_url"] = validation_url
        return out
    if status == 429:
        return {
            "error_code": "gemini_quota_exhausted",
            "error_message": msg or "账号配额已用尽 (429)",
            "http_status": 429,
        }
    if status == 502:
        return {
            "error_code": "gemini_proxy_error",
            "error_message": msg or "上游网关返回 502 错误",
            "http_status": 502,
        }
    if status == 503:
        return {
            "error_code": "gemini_upstream_unavailable",
            "error_message": msg or "Google 上游服务暂时不可用 (503)",
            "http_status": 503,
        }
    return {
        "error_code": default_code,
        "error_message": msg or f"Google 上游返回 HTTP {status}",
        "http_status": status if isinstance(status, int) else 0,
    }


def post_form_json(proxy_url, url, form_fields, *, timeout=10):
    encoded = urlencode(form_fields)
    config_lines = [
        f"proxy = {json.dumps(proxy_url)}\n",
        'noproxy = ""\n',
        f"data-binary = {json.dumps(encoded)}\n",
    ]
    args = [
        "curl",
        "--disable",
        "--silent",
        "--show-error",
        "--config",
        "-",
        "--proto",
        "=https",
        "--connect-timeout",
        "6",
        "--max-time",
        str(timeout),
        "--max-filesize",
        "1048576",
        "--header",
        "Content-Type: application/x-www-form-urlencoded",
        "--write-out",
        "\n%{http_code}",
        url,
    ]
    config = "".join(config_lines)
    try:
        output = subprocess.run(
            args,
            input=config.encode(),
            capture_output=True,
            timeout=timeout + 2,
            env=ENV,
        )
        if output.returncode != 0:
            stderr_msg = _redact_proxy_error(output.stderr, proxy_url)
            return 0, {"_transport_error": stderr_msg or f"curl exit {output.returncode}"}
        raw, _, status_raw = output.stdout.rpartition(b"\n")
        status = int(status_raw)
        try:
            data = json.loads(raw)
        except ValueError:
            data = {}
        return status, data if isinstance(data, dict) else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return 0, {"_transport_error": "request failed or timed out"}


def refresh_oauth_token(
    proxy_url, refresh_token, *, auth_method=None, wif_provider=None, oauth_clients=None
):
    if not isinstance(refresh_token, str) or not REFRESH_TOKEN_RE.fullmatch(refresh_token):
        return {"state": "reauth_required", "error": "invalid_refresh_token"}
    method_tag = auth_method.strip().lower() if isinstance(auth_method, str) else ""
    provider = wif_provider.strip() if isinstance(wif_provider, str) else ""
    configured = _resolve_oauth_clients(oauth_clients)
    if provider:
        order = ("wif",)
    elif method_tag in ("business_licensed_enterprise", "gcp"):
        order = ("cloud", "consumer")
    else:
        order = ("consumer", "cloud")
    clients = [configured[name] for name in order if name in configured]
    if not clients:
        return {"state": "error", "error": "oauth_client_not_configured"}

    last_error = None
    last_status = 0
    for idx, (token_url, client_id, client_secret, resolved_method) in enumerate(clients):
        form = {
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
        if client_secret:
            form["client_secret"] = client_secret
        status, data = post_form_json(proxy_url, token_url, form, timeout=10)
        last_status = status
        if status == 200:
            access_token = data.get("access_token")
            if not isinstance(access_token, str) or not ACCESS_TOKEN_RE.fullmatch(access_token):
                return {"state": "error", "error": "invalid_access_token"}
            raw_expires = data.get("expires_in")
            try:
                expires_in = int(raw_expires) if raw_expires is not None else 3600
            except (TypeError, ValueError):
                expires_in = 3600
            if expires_in <= 0 or expires_in > 31536000:
                expires_in = 3600
            expiry_iso = datetime.fromtimestamp(
                int(time.time()) + expires_in, timezone.utc
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
            rotated = data.get("refresh_token")
            effective_rt = (
                rotated
                if isinstance(rotated, str) and REFRESH_TOKEN_RE.fullmatch(rotated)
                else refresh_token
            )
            token_type = data.get("token_type")
            if not isinstance(token_type, str) or not token_type.strip():
                token_type = "Bearer"
            token_doc = {
                "token": {
                    "access_token": access_token,
                    "token_type": token_type,
                    "refresh_token": effective_rt,
                    "expiry": expiry_iso,
                },
                "auth_method": resolved_method,
            }
            if provider:
                token_doc["wif_provider"] = provider
                token_doc["saved_wif_provider"] = provider
            return {"state": "ok", "token_doc": token_doc}

        err_code = data.get("error") if isinstance(data.get("error"), str) else ""
        last_error = err_code
        # Retry with the alternate official OAuth client only on client mismatch.
        if (
            idx == 0
            and len(clients) > 1
            and status in (400, 401)
            and err_code in ("unauthorized_client", "invalid_client")
        ):
            continue
        break

    if last_status in (400, 401, 403):
        return {"state": "reauth_required", "error": last_error or "refresh_rejected"}
    return {"state": "error", "error": last_error or "refresh_transport_error"}


def probe_oauth_refresh_import(proxy_url, oauth_token, *, oauth_clients=None):
    if not isinstance(oauth_token, dict):
        return {"account": checked("error")}
    refresh_token = oauth_token.get("refresh_token")
    auth_method = oauth_token.get("auth_method")
    wif_provider = oauth_token.get("wif_provider")
    refreshed = refresh_oauth_token(
        proxy_url,
        refresh_token,
        auth_method=auth_method,
        wif_provider=wif_provider,
        oauth_clients=oauth_clients,
    )
    if refreshed.get("state") == "ok" and isinstance(refreshed.get("token_doc"), dict):
        token_doc = refreshed["token_doc"]
        account = probe_oauth_token(proxy_url, token_doc, imported=False)
        if account.get("state") in ("ok", "partial"):
            email = account.get("email")
            if token_doc.get("auth_method") == "gcp" and isinstance(email, str) and email:
                token_doc["id_token_email"] = email
            return {"account": account, "token_doc": token_doc}
        return {"account": account}

    # If refresh failed due to a third-party OAuth client mismatch or unconfigured host client
    # and the caller also supplied a non-expired access token, fall back to access-only import.
    access_token = oauth_token.get("access_token")
    expiry = oauth_token.get("expiry")
    if (
        refreshed.get("error")
        in ("unauthorized_client", "invalid_client", "oauth_client_not_configured")
        and isinstance(access_token, str)
        and ACCESS_TOKEN_RE.fullmatch(access_token)
        and type(expiry) is int
        and expiry > time.time()
    ):
        fallback_account = probe_oauth_token(
            proxy_url,
            {"token": {"access_token": access_token, "expiry": expiry}},
            imported=True,
        )
        return {"account": fallback_account, "fallback_access_only": True}

    err_code = refreshed.get("error")
    extra = {}
    if isinstance(err_code, str) and err_code:
        extra["error_code"] = err_code
    out = {"account": checked(refreshed.get("state") or "error", **extra)}
    if isinstance(err_code, str) and err_code:
        out["error"] = err_code
    return out


def checked(state, **data):
    return {
        "state": state,
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **data,
    }


def text(value, limit=128):
    return value[:limit] if isinstance(value, str) and value else None


def tier(value):
    if isinstance(value, dict):
        return text(value.get("name")) or text(value.get("id"))
    return text(value)


def project_id_of(value):
    if isinstance(value, dict):
        return text(value.get("id")) or text(value.get("projectId"))
    return text(value)


_BLOCKING_INELIGIBLE_REASONS = frozenset(
    {"VALIDATION_REQUIRED", "UNSUPPORTED_REGION", "UNSUPPORTED_CLIENT", "TOS_VIOLATION"}
)
_ONBOARD_BLOCKING_REASONS = frozenset(
    {"VALIDATION_REQUIRED", "UNSUPPORTED_REGION"}
)
_GOOGLE_VALIDATION_URL = re.compile(
    r"https://accounts\.google\.com/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{1,2000}\Z"
)


def safe_google_validation_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    candidate = value.strip()
    if _GOOGLE_VALIDATION_URL.fullmatch(candidate):
        return candidate
    return None


def parse_ineligibility(assist_data):
    if not isinstance(assist_data, dict):
        return None, None
    # An account with an active paidTier or currentTier is already onboarded and usable;
    # ineligibleTiers entries for other/alternative tiers must not mark it blocked.
    if assist_data.get("paidTier") or assist_data.get("currentTier"):
        return None, None
    ineligible = assist_data.get("ineligibleTiers")
    if not isinstance(ineligible, list):
        return None, None
    fallback = None
    for entry in ineligible:
        if not isinstance(entry, dict):
            continue
        reason = entry.get("reasonCode")
        if reason == "VALIDATION_REQUIRED":
            return "verification_required", safe_google_validation_url(
                entry.get("validationUrl")
            )
        if reason == "UNSUPPORTED_REGION":
            fallback = ("location_unsupported", None)
        elif reason == "TOS_VIOLATION" and fallback is None:
            fallback = ("ineligible", None)
        elif reason == "UNSUPPORTED_CLIENT" and fallback is None:
            fallback = ("client_unsupported", None)
        elif reason in _BLOCKING_INELIGIBLE_REASONS and fallback is None:
            fallback = ("ineligible", None)
    return fallback if fallback is not None else (None, None)


def verification_url(assist_data):
    """A safe action is independent of whether an alternative tier blocks use."""
    if not isinstance(assist_data, dict):
        return None
    entries = assist_data.get("ineligibleTiers")
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if isinstance(entry, dict) and entry.get("reasonCode") == "VALIDATION_REQUIRED":
            url = safe_google_validation_url(entry.get("validationUrl"))
            if url:
                return url
    return None


def select_onboard_tier(assist_data):
    if not isinstance(assist_data, dict):
        return None
    if assist_data.get("paidTier") or assist_data.get("currentTier"):
        return None
    ineligible = assist_data.get("ineligibleTiers")
    if isinstance(ineligible, list):
        for entry in ineligible:
            if (
                isinstance(entry, dict)
                and entry.get("reasonCode") in _ONBOARD_BLOCKING_REASONS
            ):
                return None
    allowed = assist_data.get("allowedTiers")
    if not isinstance(allowed, list):
        return None
    fallback = None
    for entry in allowed:
        if not isinstance(entry, dict):
            continue
        tier_id = text(entry.get("id"))
        if not tier_id:
            continue
        if entry.get("isDefault") is True:
            return tier_id
        if fallback is None:
            fallback = tier_id
    return fallback


_MODEL_PROVIDER_MAP = {
    "MODEL_PROVIDER_GOOGLE": "google",
    "MODEL_PROVIDER_ANTHROPIC": "anthropic",
    "MODEL_PROVIDER_OPENAI": "openai",
}


def classify_model_provider(model, raw_provider=None):
    if isinstance(raw_provider, str):
        mapped = _MODEL_PROVIDER_MAP.get(raw_provider.strip().upper())
        if mapped:
            return mapped
    lower = model.lower()
    if lower.startswith("claude-"):
        return "anthropic"
    if lower.startswith(("gpt-", "o1", "o3", "o4", "chatgpt", "codex-")):
        return "openai"
    return "google"


def classify_quota_group(model, provider):
    if provider != "google":
        return "3p"
    if "argon" in model.lower():
        return "gemini-argon-wtu"
    return "gemini"


def model_catalog(data):
    entries = data.get("models")
    if not isinstance(entries, dict):
        return []
    catalog = []
    for model, info in list(entries.items())[:128]:
        if not MODEL.fullmatch(model) or not isinstance(info, dict):
            continue
        provider = classify_model_provider(model, info.get("modelProvider"))
        catalog.append(
            {
                "id": model,
                "provider": provider,
                "quota_group": classify_quota_group(model, provider),
            }
        )
    return sorted(catalog, key=lambda item: item["id"])


def models(data, is_api_key=False, *, chat_only=False):
    if is_api_key:
        entries = data.get("models")
        if not isinstance(entries, list):
            return []
        names = set()
        for entry in entries:
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str):
                continue
            if chat_only:
                methods = entry.get("supportedGenerationMethods")
                if not isinstance(methods, list) or "generateContent" not in methods:
                    continue
            if name.startswith("models/"):
                name = name[len("models/") :]
            if MODEL.fullmatch(name):
                names.add(name)
        return sorted(names)[:128]
    entries = data.get("models")
    if not isinstance(entries, dict):
        return [], []
    names, quotas = [], []
    for model, info in list(entries.items())[:128]:
        if not MODEL.fullmatch(model) or not isinstance(info, dict):
            continue
        names.append(model)
        quota = info.get("quotaInfo")
        if not isinstance(quota, dict):
            continue
        remaining = quota.get("remainingFraction")
        if type(remaining) not in (float, int) or not 0 <= remaining <= 1:
            continue
        quotas.append(
            {
                "model": model,
                "remaining_fraction": remaining,
                "reset_at": text(quota.get("resetTime")),
            }
        )
    return sorted(names), sorted(quotas, key=lambda quota: quota["model"])


def quota_groups(data):
    entries = data.get("groups")
    if not isinstance(entries, list):
        return []
    groups = []
    seen = set()
    for group in entries[:12]:
        if not isinstance(group, dict):
            continue
        name = text(group.get("displayName"))
        buckets = group.get("buckets")
        if not name or not isinstance(buckets, list):
            continue
        windows = []
        for bucket in buckets[:4]:
            if not isinstance(bucket, dict) or bucket.get("disabled") is True:
                continue
            identifier, period = bucket.get("bucketId"), bucket.get("window")
            if (
                not isinstance(identifier, str)
                or not MODEL.fullmatch(identifier)
                or identifier in seen
                or period not in ("5h", "weekly")
            ):
                continue
            remaining = bucket.get("remainingFraction")
            if remaining is not None and (
                type(remaining) not in (int, float) or not 0 <= remaining <= 1
            ):
                continue
            seen.add(identifier)
            windows.append(
                {
                    "id": identifier,
                    "period": period,
                    "remaining_fraction": remaining,
                    "reset_at": text(bucket.get("resetTime")),
                }
            )
        if windows:
            groups.append(
                {
                    "name": name,
                    "windows": sorted(windows, key=lambda window: window["period"]),
                }
            )
    return groups


def probe_api_key(proxy_url, api_key, *, chat_only=False):
    status, data = get_json(proxy_url, GEMINI_MODELS, f"x-goog-api-key: {api_key}")
    if status == 200 and isinstance(data.get("models"), list):
        return checked(
            "partial" if data.get("nextPageToken") else "ok",
            models=models(data, is_api_key=True, chat_only=chat_only),
        )
    err_info = classify_http_error(
        status,
        data,
        default_code="gemini_api_key_invalid" if status in (400, 401, 403) else "gemini_inference_failed",
    )
    if status in (400, 401, 403):
        err_info["error_code"] = "gemini_api_key_invalid"
    return checked(
        "reauth_required" if status in (400, 401, 403) else "error",
        error_code=err_info["error_code"],
        error_message=err_info["error_message"],
        http_status=err_info["http_status"],
    )


def probe_oauth(proxy_url, profile):
    token = read_token(profile)
    if token is None:
        return checked(
            "reauth_required",
            error_code="gemini_oauth_required",
            error_message="缺少本地 OAuth 凭证文件，请重新完成授权",
            http_status=401,
        )
    return probe_oauth_token(proxy_url, token)


def _code_assist_headers(auth_header, user_agent):
    headers = [auth_header, f"User-Agent: {user_agent}"]
    if "google-api-nodejs-client/" in user_agent:
        headers.append(f"X-Goog-Api-Client: {ANTIGRAVITY_API_CLIENT}")
    return headers


def probe_oauth_token(proxy_url, token, *, imported=False):
    credential = token.get("token")
    if not isinstance(credential, dict):
        return checked("error")
    access_token = credential.get("access_token")
    if not isinstance(access_token, str) or not re.fullmatch(
        r"[A-Za-z0-9._~+/-]{1,4096}={0,2}", access_token
    ):
        return checked("error")
    auth_header = f"Authorization: Bearer {access_token}"
    assist_base = CODE_ASSIST
    code_assist_headers = _code_assist_headers(auth_header, ANTIGRAVITY_USER_AGENT)
    metadata = {
        "metadata": {
            "ideName": "antigravity",
            "ideType": "ANTIGRAVITY",
            "ideVersion": ANTIGRAVITY_VERSION,
            "platform": "LINUX_AMD64",
            "pluginType": "GEMINI",
        }
    }
    with ThreadPoolExecutor(max_workers=2) as executor:
        user = executor.submit(get_json, proxy_url, GOOGLE_USERINFO, auth_header)
        assist = executor.submit(
            get_json,
            proxy_url,
            assist_base + "loadCodeAssist",
            code_assist_headers,
            metadata,
        )
        user_status, user_data = user.result()
        assist_status, assist_data = assist.result()
    if (
        assist_status == 200
        and parse_ineligibility(assist_data)[0] == "client_unsupported"
    ) or assist_status in (0, 400, 404, 429, 500, 502, 503, 504):
        fallback_candidates = [
            (CODE_ASSIST, fallback_ua)
            for fallback_ua in ANTIGRAVITY_FALLBACK_USER_AGENTS
        ] + [
            (CODE_ASSIST_DAILY, ANTIGRAVITY_USER_AGENT),
            (CODE_ASSIST_DAILY, ANTIGRAVITY_FALLBACK_USER_AGENTS[0]),
        ]
        for fb_base, fallback_ua in fallback_candidates:
            fallback_headers = _code_assist_headers(auth_header, fallback_ua)
            fb_status, fb_data = get_json(
                proxy_url,
                fb_base + "loadCodeAssist",
                fallback_headers,
                metadata,
            )
            if (
                fb_status == 200
                and isinstance(fb_data, dict)
                and parse_ineligibility(fb_data)[0] != "client_unsupported"
            ):
                assist_base = fb_base
                assist_status, assist_data = fb_status, fb_data
                code_assist_headers = fallback_headers
                break
    if imported:
        email = user_data.get("email")
        if user_status in (401, 403) or assist_status in (401, 403):
            failed_status, failed_data = (
                (assist_status, assist_data)
                if assist_status in (401, 403)
                else (user_status, user_data)
            )
            err_info = classify_http_error(failed_status, failed_data)
            return checked(
                "reauth_required",
                error_code=err_info["error_code"],
                error_message=err_info["error_message"],
                http_status=err_info["http_status"],
            )
        if user_status != 200 or assist_status != 200 or not text(email, 254):
            failed_status, failed_data = (
                (assist_status, assist_data)
                if assist_status != 200
                else (user_status, user_data)
            )
            err_info = classify_http_error(failed_status, failed_data)
            return checked(
                "error",
                error_code=err_info["error_code"],
                error_message=err_info["error_message"],
                http_status=err_info["http_status"],
            )
    onboard_project = None
    if assist_status == 200 and not imported:
        onboard_tier = select_onboard_tier(assist_data)
        if onboard_tier:
            onboard_body = {"tierId": onboard_tier, "metadata": metadata["metadata"]}
            existing_project = project_id_of(
                assist_data.get("cloudaicompanionProject")
            ) or text(token.get("project_id"))
            if existing_project:
                onboard_body["cloudaicompanionProject"] = existing_project
            onboard_status, onboard_data = get_json(
                proxy_url,
                assist_base + "onboardUser",
                code_assist_headers,
                onboard_body,
                timeout=10,
            )
            if onboard_status == 200 and isinstance(onboard_data, dict):
                response_obj = onboard_data.get("response")
                if isinstance(response_obj, dict):
                    onboard_project = project_id_of(
                        response_obj.get("cloudaicompanionProject")
                    )
                if not onboard_project:
                    onboard_project = project_id_of(
                        onboard_data.get("cloudaicompanionProject")
                    )
                if onboard_data.get("done") is False:
                    time.sleep(0.5)
                assist_status2, assist_data2 = get_json(
                    proxy_url,
                    assist_base + "loadCodeAssist",
                    code_assist_headers,
                    metadata,
                )
                if assist_status2 == 200 and isinstance(assist_data2, dict):
                    assist_data = assist_data2
    project = (
        project_id_of(assist_data.get("cloudaicompanionProject"))
        or onboard_project
        or text(token.get("project_id"))
    )
    expiry = credential.get("expiry")
    if type(expiry) in (int, float):
        try:
            expiry = datetime.fromtimestamp(expiry, timezone.utc).isoformat(
                timespec="seconds"
            )
        except (ValueError, OverflowError, OSError):
            expiry = None
    eligibility, validation_url = parse_ineligibility(assist_data)
    # Keep the link even when paid/current-tier metadata correctly suppresses
    # alternative-tier eligibility failures. A URL alone never blocks scheduling.
    validation_url = validation_url or verification_url(assist_data)
    account = {
        "email": text(user_data.get("email"), 254)
        or text(token.get("id_token_email"), 254),
        "project_id": project,
        "region": text(token.get("region")),
        "plan": tier(assist_data.get("paidTier"))
        or tier(assist_data.get("currentTier"))
        or text(token.get("tier_display_name"))
        or text(token.get("user_tier")),
        "expires_at": text(expiry),
    }
    if eligibility:
        account["eligibility"] = eligibility
    if validation_url:
        account["validation_url"] = validation_url
    paid = assist_data.get("paidTier")
    current = assist_data.get("currentTier")
    credits = paid.get("availableCredits") if isinstance(paid, dict) else None
    if not isinstance(credits, list) and isinstance(current, dict):
        credits = current.get("availableCredits")
    if isinstance(credits, list):
        account["credits"] = [
            {
                "type": text(entry.get("creditType")),
                "amount": text(entry.get("creditAmount")),
            }
            for entry in credits[:16]
            if isinstance(entry, dict)
        ]
    model_status = None
    model_data = {}
    if assist_status == 200:
        project_body = {"project": project} if project else {}
        with ThreadPoolExecutor(max_workers=2) as executor:
            model_result = executor.submit(
                get_json,
                proxy_url,
                CODE_ASSIST_DAILY + "fetchAvailableModels",
                code_assist_headers,
                project_body,
            )
            summary = (
                executor.submit(
                    get_json,
                    proxy_url,
                    CODE_ASSIST_DAILY + "retrieveUserQuotaSummary",
                    code_assist_headers,
                    project_body,
                )
                if project
                else None
            )
            model_status, model_data = model_result.result()
            if summary is not None:
                summary_status, summary_data = summary.result()
                if summary_status == 200:
                    account["quota_groups"] = quota_groups(summary_data)
        if model_status == 200:
            account["models"], account["quotas"] = models(model_data)
            catalog = model_catalog(model_data)
            if catalog:
                account["model_catalog"] = catalog
            if (
                account.get("eligibility") == "client_unsupported"
                and account.get("models")
            ):
                account.pop("eligibility", None)
    state = "partial"
    if user_status == assist_status == model_status == 200:
        state = "ok"
    elif 401 in (user_status, assist_status, model_status):
        state = "reauth_required"
    elif user_status != 200 and assist_status != 200:
        state = "error"
    if state != "ok":
        failed_pair = None
        for st, payload in (
            (assist_status, assist_data),
            (model_status, model_data),
            (user_status, user_data),
        ):
            if st is not None and st != 200:
                failed_pair = (st, payload)
                if st in (401, 403):
                    break
        if failed_pair is not None:
            err_info = classify_http_error(failed_pair[0], failed_pair[1])
            account["error_code"] = err_info["error_code"]
            account["error_message"] = err_info["error_message"]
            account["http_status"] = err_info["http_status"]
            if err_info.get("eligibility") and not account.get("eligibility"):
                account["eligibility"] = err_info["eligibility"]
            if err_info.get("validation_url") and not account.get("validation_url"):
                account["validation_url"] = err_info["validation_url"]
    return checked(state, **account)


def api_key_chat(request):
    model = request.get("model")
    if not isinstance(model, str) or not MODEL.fullmatch(model):
        return {"status": "ERROR", "error": "gemini_model_unavailable"}
    status, data = get_json(
        request["proxy_url"],
        f"{GEMINI_API}/models/{model}:generateContent",
        f"x-goog-api-key: {request['api_key']}",
        {
            "contents": [{"role": "user", "parts": [{"text": request["prompt"]}]}],
            "generationConfig": {"maxOutputTokens": 1024},
        },
        timeout=24,
    )
    if status != 200:
        return {
            "status": "ERROR",
            "error": {
                0: "gemini_proxy_error",
                401: "gemini_api_key_invalid",
                403: "gemini_api_key_invalid",
                404: "gemini_model_unavailable",
                429: "gemini_quota_exhausted",
            }.get(status, "gemini_inference_failed"),
        }
    candidates = data.get("candidates")
    candidate = candidates[0] if isinstance(candidates, list) and candidates else None
    content = candidate.get("content") if isinstance(candidate, dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    answer = (
        "".join(
            p["text"]
            for p in parts
            if isinstance(p, dict)
            and isinstance(p.get("text"), str)
            and p.get("thought") is not True
        )
        if isinstance(parts, list)
        else ""
    )
    if not answer.strip() or candidate.get("finishReason") not in (
        "STOP",
        "MAX_TOKENS",
    ):
        return {"status": "ERROR", "error": "gemini_inference_failed"}
    usage = data.get("usageMetadata")
    fields = {
        "promptTokenCount": "input_tokens",
        "candidatesTokenCount": "output_tokens",
        "totalTokenCount": "total_tokens",
    }
    counts = (
        {
            key: usage[name]
            for name, key in fields.items()
            if type(usage.get(name)) is int
        }
        if isinstance(usage, dict)
        else {}
    )
    return {"status": "SUCCESS", "response": answer[:16384], "usage": counts}


def _read_http_status_and_type(stream):
    """Consume curl --dump-header - response headers (including proxy CONNECT blocks)."""
    status = 0
    content_type = ""
    while True:
        line = stream.readline(8192)
        if not line:
            return status, content_type
        if not line.startswith(b"HTTP/"):
            return status, content_type
        parts = line.decode("latin-1", errors="replace").strip().split(None, 2)
        try:
            code = int(parts[1]) if len(parts) >= 2 else 0
        except ValueError:
            code = 0
        block_ct = ""
        while True:
            header = stream.readline(8192)
            if not header or header in (b"\r\n", b"\n"):
                break
            text_header = header.decode("latin-1", errors="replace")
            if ":" in text_header:
                name, value = text_header.split(":", 1)
                if name.strip().lower() == "content-type":
                    block_ct = value.strip()
        if code == 200 and len(parts) >= 3 and "connection established" in parts[2].lower():
            continue
        if 100 <= code < 200:
            continue
        return code, block_ct


def api_key_stream(request):
    model = request.get("model")
    api_key = request.get("api_key")
    proxy_url = request.get("proxy_url")
    body = request.get("body")
    if (
        not isinstance(model, str)
        or not MODEL.fullmatch(model)
        or not isinstance(api_key, str)
        or not isinstance(proxy_url, str)
        or not isinstance(body, dict)
    ):
        sys.stdout.buffer.write(b"STATUS 400 application/json\n")
        sys.stdout.buffer.flush()
        return 1
    body_bytes = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body_bytes) > 4 * 1024 * 1024:
        sys.stdout.buffer.write(b"STATUS 413 application/json\n")
        sys.stdout.buffer.flush()
        return 1
    config = "".join(
        f"{key} = {json.dumps(value)}\n"
        for key, value in (
            ("proxy", proxy_url),
            ("noproxy", ""),
            ("header", f"x-goog-api-key: {api_key}"),
            ("header", "Content-Type: application/json"),
            ("header", "Accept: text/event-stream"),
        )
    ).encode("utf-8")
    read_fd, write_fd = os.pipe()
    proc = None
    writer = None
    try:
        args = [
            "curl",
            "--disable",
            "--silent",
            "--show-error",
            "--no-buffer",
            "--dump-header",
            "-",
            "--config",
            "-",
            "--proto",
            "=https",
            "--connect-timeout",
            "10",
            "--max-time",
            "300",
            "--data-binary",
            f"@/dev/fd/{read_fd}",
            f"{GEMINI_API}/models/{model}:streamGenerateContent?alt=sse",
        ]
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            pass_fds=(read_fd,),
            env=ENV,
            bufsize=0,
        )
        os.close(read_fd)
        read_fd = -1

        def feed_body():
            try:
                view = memoryview(body_bytes)
                offset = 0
                while offset < len(view):
                    written = os.write(write_fd, view[offset : offset + 65536])
                    if written <= 0:
                        break
                    offset += written
            except OSError:
                pass
            finally:
                try:
                    os.close(write_fd)
                except OSError:
                    pass

        writer = threading.Thread(target=feed_body, daemon=True)
        writer.start()
        write_fd = -1
        try:
            proc.stdin.write(config)
            proc.stdin.close()
        except OSError:
            pass

        status, content_type = _read_http_status_and_type(proc.stdout)
        safe_ct = re.sub(r"[\r\n]+", "", content_type or "application/octet-stream")[:128]
        sys.stdout.buffer.write(f"STATUS {status} {safe_ct}\n".encode("ascii"))
        sys.stdout.buffer.flush()
        while True:
            chunk = proc.stdout.read1(16384) if hasattr(proc.stdout, "read1") else proc.stdout.read(16384)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        proc.wait(timeout=5)
        return 0 if status == 200 else 1
    except (OSError, subprocess.SubprocessError):
        try:
            sys.stdout.buffer.write(b"STATUS 0 error\n")
            sys.stdout.buffer.flush()
        except OSError:
            pass
        return 1
    finally:
        if read_fd >= 0:
            try:
                os.close(read_fd)
            except OSError:
                pass
        if write_fd >= 0:
            try:
                os.close(write_fd)
            except OSError:
                pass
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait()
        if writer is not None:
            writer.join(timeout=1)


if __name__ == "__main__":
    request = json.load(sys.stdin)
    if sys.argv[1] in ("api_key", "api-key-models") and re.fullmatch(
        r"[A-Za-z0-9_-]{20,256}", request["api_key"]
    ):
        result = probe_api_key(
            request["proxy_url"],
            request["api_key"],
            chat_only=sys.argv[1] == "api-key-models",
        )
    elif sys.argv[1] == "oauth":
        result = probe_oauth(request["proxy_url"], sys.argv[2])
    elif sys.argv[1] == "proxy-probe":
        status, _ = get_json(request["proxy_url"], GOOGLE_USERINFO)
        result = {"ok": status == 401}
    elif sys.argv[1] == "api-key-stream" and re.fullmatch(
        r"[A-Za-z0-9_-]{20,256}", request["api_key"]
    ):
        raise SystemExit(api_key_stream(request))
    elif sys.argv[1] == "api-key-chat" and re.fullmatch(
        r"[A-Za-z0-9_-]{20,256}", request["api_key"]
    ):
        result = api_key_chat(request)
        if result["status"] == "SUCCESS":
            print(
                json.dumps(
                    {
                        "event": "step_update",
                        "step_update": {
                            "step_type": "agent_response",
                            "state": "DONE",
                            "text_delta": result.pop("response"),
                        },
                    }
                )
            )
        print(json.dumps({"event": "result", "result": result}))
        sys.exit(0 if result["status"] == "SUCCESS" else 1)
    elif sys.argv[1] == "oauth_import":
        result = probe_oauth_token(
            request["proxy_url"], {"token": request["oauth_token"]}, imported=True
        )
    elif sys.argv[1] == "oauth_refresh_import":
        result = probe_oauth_refresh_import(
            request["proxy_url"],
            request.get("oauth_token"),
            oauth_clients=request.get("oauth_clients"),
        )
    else:
        result = checked("error")
    print(json.dumps(result))
