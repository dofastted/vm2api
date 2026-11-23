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


MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo"
CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal:"
CODE_ASSIST_DAILY = "https://daily-cloudcode-pa.googleapis.com/v1internal:"
ANTIGRAVITY_USER_AGENT = (
    "antigravity/hub/2.34.0 (aidev_client; os_type=linux; arch=amd64; cl=1026637980)"
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


def get_json(proxy_url, url, header=None, body=None, *, timeout=6):
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
        "--config",
        "-",
        "--proto",
        "=https",
        "--connect-timeout",
        "3",
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
            timeout=timeout + 1,
            env=ENV,
        )
        if output.returncode != 0:
            return 0, {}
        raw, _, status = output.stdout.rpartition(b"\n")
        status = int(status)
        if status != 200:
            return status, {}
        data = json.loads(raw)
        return (status, data) if isinstance(data, dict) else (0, {})
    except (OSError, subprocess.SubprocessError, ValueError):
        return 0, {}


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
    {"VALIDATION_REQUIRED", "UNSUPPORTED_REGION", "UNSUPPORTED_CLIENT"}
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
        if reason == "UNSUPPORTED_REGION" and fallback is None:
            fallback = ("location_unsupported", None)
        elif reason in _BLOCKING_INELIGIBLE_REASONS and fallback is None:
            fallback = ("ineligible", None)
    return fallback if fallback is not None else (None, None)


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
                and entry.get("reasonCode") in _BLOCKING_INELIGIBLE_REASONS
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
    return checked("reauth_required" if status in (400, 401, 403) else "error")


def probe_oauth(proxy_url, profile):
    token = read_token(profile)
    if token is None:
        return checked("error")
    return probe_oauth_token(proxy_url, token)


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
    code_assist_headers = [auth_header, f"User-Agent: {ANTIGRAVITY_USER_AGENT}"]
    metadata = {"metadata": {"ideType": "ANTIGRAVITY"}}
    with ThreadPoolExecutor(max_workers=2) as executor:
        user = executor.submit(get_json, proxy_url, GOOGLE_USERINFO, auth_header)
        assist = executor.submit(
            get_json,
            proxy_url,
            CODE_ASSIST + "loadCodeAssist",
            code_assist_headers,
            metadata,
        )
        user_status, user_data = user.result()
        assist_status, assist_data = assist.result()
    if imported:
        email = user_data.get("email")
        if user_status in (401, 403) or assist_status in (401, 403):
            return checked("reauth_required")
        if user_status != 200 or assist_status != 200 or not text(email, 254):
            return checked("error")
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
                CODE_ASSIST + "onboardUser",
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
                    CODE_ASSIST + "loadCodeAssist",
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
            model_status, data = model_result.result()
            if summary is not None:
                summary_status, summary_data = summary.result()
                if summary_status == 200:
                    account["quota_groups"] = quota_groups(summary_data)
        if model_status == 200:
            account["models"], account["quotas"] = models(data)
    state = "partial"
    if user_status == assist_status == model_status == 200:
        state = "ok"
    elif 401 in (user_status, assist_status, model_status):
        state = "reauth_required"
    elif user_status != 200 and assist_status != 200:
        state = "error"
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
    else:
        result = checked("error")
    print(json.dumps(result))
