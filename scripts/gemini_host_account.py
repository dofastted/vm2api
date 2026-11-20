import json
import os
import re
import stat
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone


MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo"
CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal:"
GEMINI_API = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_MODELS = f"{GEMINI_API}/models?pageSize=1000"
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


def get_json(proxy_url, url, header, body=None, *, timeout=6):
    options = {"proxy": proxy_url, "noproxy": "", "header": header}
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
        options["data-binary"] = json.dumps(body, ensure_ascii=True)
        args += ["--header", "Content-Type: application/json"]
    config = "".join(f"{key} = {json.dumps(value)}\n" for key, value in options.items())
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


def models(data, is_api_key=False):
    if is_api_key:
        entries = data.get("models")
        if not isinstance(entries, list):
            return []
        names = set()
        for entry in entries:
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str):
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


def probe_api_key(proxy_url, api_key):
    status, data = get_json(proxy_url, GEMINI_MODELS, f"x-goog-api-key: {api_key}")
    if status == 200 and isinstance(data.get("models"), list):
        return checked(
            "partial" if data.get("nextPageToken") else "ok",
            models=models(data, is_api_key=True),
        )
    return checked("reauth_required" if status in (400, 401, 403) else "error")


def probe_oauth(proxy_url, profile):
    token = read_token(profile)
    if token is None:
        return checked("error")
    credential = token.get("token")
    if not isinstance(credential, dict):
        return checked("error")
    access_token = credential.get("access_token")
    if not isinstance(access_token, str) or not re.fullmatch(
        r"[A-Za-z0-9._~+/-]{1,4096}={0,2}", access_token
    ):
        return checked("error")
    header = f"Authorization: Bearer {access_token}"
    metadata = {"metadata": {"ideType": "ANTIGRAVITY", "ideName": "antigravity"}}
    with ThreadPoolExecutor(max_workers=2) as executor:
        user = executor.submit(get_json, proxy_url, GOOGLE_USERINFO, header)
        assist = executor.submit(
            get_json, proxy_url, CODE_ASSIST + "loadCodeAssist", header, metadata
        )
        user_status, user_data = user.result()
        assist_status, assist_data = assist.result()
    project = text(assist_data.get("cloudaicompanionProject")) or text(
        token.get("project_id")
    )
    expiry = credential.get("expiry")
    if type(expiry) in (int, float):
        try:
            expiry = datetime.fromtimestamp(expiry, timezone.utc).isoformat(
                timespec="seconds"
            )
        except (ValueError, OverflowError, OSError):
            expiry = None
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
    paid = assist_data.get("paidTier")
    credits = paid.get("availableCredits") if isinstance(paid, dict) else None
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
                CODE_ASSIST + "fetchAvailableModels",
                header,
                project_body,
            )
            summary = (
                executor.submit(
                    get_json,
                    proxy_url,
                    CODE_ASSIST + "retrieveUserQuotaSummary",
                    header,
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


def test_api_key(proxy_url, api_key, model, prompt):
    if not MODEL.fullmatch(model):
        raise ValueError("Invalid Gemini test model")
    status, payload = get_json(
        proxy_url,
        f"{GEMINI_API}/models/{model}:generateContent",
        f"x-goog-api-key: {api_key}",
        {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"maxOutputTokens": 1024},
        },
        timeout=20,
    )
    if status != 200:
        return {"status": status}
    candidates = payload.get("candidates")
    candidate = candidates[0] if isinstance(candidates, list) and candidates else None
    candidate = candidate if isinstance(candidate, dict) else {}
    content = candidate.get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    answer = (
        "".join(
            part["text"]
            for part in parts
            if isinstance(part, dict)
            and isinstance(part.get("text"), str)
            and part.get("thought") is not True
        )
        if isinstance(parts, list)
        else ""
    )
    feedback = payload.get("promptFeedback")
    stop = candidate.get("finishReason") or (
        feedback.get("blockReason") if isinstance(feedback, dict) else None
    )
    usage = {}
    counts = payload.get("usageMetadata")
    if isinstance(counts, dict):
        for source, target in (
            ("promptTokenCount", "input_tokens"),
            ("candidatesTokenCount", "output_tokens"),
            ("cachedContentTokenCount", "cache_read_input_tokens"),
        ):
            value = counts.get(source)
            if type(value) is int and value >= 0:
                usage[target] = value
        cached = usage.get("cache_read_input_tokens", 0)
        if "input_tokens" in usage and cached <= usage["input_tokens"]:
            usage["input_tokens"] -= cached
        elif cached:
            usage.pop("input_tokens", None)
    return {
        "status": status,
        "text": answer[:4000],
        "stop_reason": text(stop, 64),
        "usage": usage,
    }


if __name__ == "__main__":
    request = json.load(sys.stdin)
    if sys.argv[1] == "api_key" and re.fullmatch(
        r"[A-Za-z0-9_-]{20,256}", request["api_key"]
    ):
        result = probe_api_key(request["proxy_url"], request["api_key"])
    elif sys.argv[1] == "test_chat" and re.fullmatch(
        r"[A-Za-z0-9_-]{20,256}", request["api_key"]
    ):
        result = test_api_key(
            request["proxy_url"],
            request["api_key"],
            request["model"],
            request["prompt"],
        )
    elif sys.argv[1] == "oauth":
        result = probe_oauth(request["proxy_url"], sys.argv[2])
    else:
        result = checked("error")
    print(json.dumps(result))
