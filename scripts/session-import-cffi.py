#!/usr/bin/env python3
"""KIN sessionKey → OAuth via Portunex CookieAuth (curl_cffi).

  GET  claude.ai/api/organizations                      Chrome 146
  POST platform.claude.com/v1/oauth/{org}/authorize    Chrome 146, Origin claude.com
  POST platform.claude.com/v1/oauth/token              Chrome 146 (same impersonate)
  GET  api.anthropic.com/api/claude_cli/bootstrap      claude-code  (full OAuth only)
  PATCH …/account/settings  grove_enabled=true         claude-code  (full OAuth only)

Inference/setup-token uses the same Portunex chain with scope=user:inference
and skips bootstrap/grove. One Chrome identity for orgs/authorize/token.
Stdout: one JSON object. Logs go to stderr. Never prints raw tokens.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sys
import time
from urllib.parse import parse_qs, urlparse

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
CLAUDE_WEB = "https://claude.ai"
CAI_AUTHORIZE = "https://claude.com/cai/oauth/authorize"
PLATFORM = "https://platform.claude.com"
ANTHROPIC_API = "https://api.anthropic.com"
TOKEN_URLS = (
    f"{PLATFORM}/v1/oauth/token",
    f"{ANTHROPIC_API}/v1/oauth/token",
)
BOOTSTRAP_URL = f"{ANTHROPIC_API}/api/claude_cli/bootstrap?entrypoint=claude-vscode&model=claude-opus-5"
GROVE_PATHS = (
    f"{ANTHROPIC_API}/api/oauth/account/settings",
    f"{PLATFORM}/api/oauth/account/settings",
    f"{ANTHROPIC_API}/api/oauth/settings",
)
SCOPE_API = (
    "user:profile user:inference user:sessions:claude_code "
    "user:mcp_servers user:file_upload"
)
SCOPE_INFERENCE = "user:inference"
UA_CHROME146 = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)
UA_CLI = "claude-code/2.1.241"
BETA_OAUTH = "oauth-2025-04-20"
IMPERSONATES = ("chrome146", "chrome136", "chrome", "chrome131", "chrome124")


def is_session_stale(text: str) -> bool:
    raw = (text or "").lower()
    return (
        "session_stale" in raw
        or "not fresh enough" in raw
        or "session is not fresh" in raw
    )


def is_rate_limited(status: int, text: str) -> bool:
    if status == 429:
        return True
    raw = (text or "").lower()
    return "rate_limit_error" in raw or "rate limited" in raw


def is_cf_html(text: str, status: int = 0) -> bool:
    raw = text or ""
    head = raw[:500].lower()
    return (
        "just a moment" in head
        or "cf-mitigated" in head
        or "cdn-cgi/challenge" in head
        or "cf-browser-verification" in head
        or (status in (403, 429, 503) and head.lstrip().startswith("<!doctype"))
    )


def public_body(resp) -> str:
    text = resp.text or ""
    if is_cf_html(text, resp.status_code):
        return "cloudflare_challenge"
    stripped = text.lstrip()
    if stripped.startswith(("{", "[")):
        return stripped[:400].replace("\n", " ")
    return stripped[:80].replace("\n", " ")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def redact(s: str, keep: int = 8) -> str:
    if not s:
        return ""
    if len(s) <= keep * 2:
        return s[:4] + "…"
    return s[:keep] + "…" + s[-6:]


def load_cffi():
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError as e:
        raise SystemExit("curl_cffi not installed") from e
    return cffi_requests


def session_cookies(sk: str) -> dict:
    return {"sessionKey": sk}


def chrome_json_headers(*, origin: str, referer: str, sec_fetch_site: str) -> dict:
    return {
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Origin": origin,
        "Referer": referer,
        "User-Agent": UA_CHROME146,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": sec_fetch_site,
    }


def orgs_headers() -> dict:
    return chrome_json_headers(
        origin=CLAUDE_WEB,
        referer=f"{CLAUDE_WEB}/new",
        sec_fetch_site="same-origin",
    )


def authorize_headers() -> dict:
    return {
        **chrome_json_headers(
            origin="https://claude.com",
            referer=f"{CAI_AUTHORIZE}?code=true",
            sec_fetch_site="same-site",
        ),
        "Content-Type": "application/json",
    }


def token_headers() -> dict:
    return {
        **chrome_json_headers(
            origin="https://claude.com",
            referer=f"{CAI_AUTHORIZE}?code=true",
            sec_fetch_site="same-site",
        ),
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
    }



def cli_headers(access_token: str) -> dict:
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
        "User-Agent": UA_CLI,
        "anthropic-beta": BETA_OAUTH,
        "anthropic-version": "2023-06-01",
    }


def call(cffi_requests, method: str, url: str, impersonate, **kwargs):
    """Stateless request: no Session / CookieJar. Only cookies= we pass."""
    fn = getattr(cffi_requests, method)
    if impersonate:
        return fn(url, impersonate=impersonate, **kwargs)
    return fn(url, **kwargs)


def normalize_proxy(raw: str) -> str:
    proxy = (raw or "").strip()
    if proxy.startswith("socks5://") and not proxy.startswith("socks5h://"):
        return "socks5h://" + proxy[len("socks5://"):]
    return proxy


def token_exchange_main() -> int:
    proxy = normalize_proxy(os.environ.get("PROXY_URL") or "")
    if not proxy:
        print("proxy_required", file=sys.stderr)
        return 2
    code = (os.environ.get("AUTH_CODE") or "").strip()
    verifier = (os.environ.get("CODE_VERIFIER") or "").strip()
    state = (os.environ.get("OAUTH_STATE") or "").strip()
    redirect_uri = (os.environ.get("OAUTH_REDIRECT_URI") or "").strip() or REDIRECT_URI
    token_urls = tuple(
        u.strip()
        for u in (os.environ.get("OAUTH_TOKEN_URLS") or "").split(",")
        if u.strip()
    ) or TOKEN_URLS
    if not code or not verifier:
        print("code and verifier required", file=sys.stderr)
        return 2
    cffi_requests = load_cffi()
    proxies = {"http": proxy, "https": proxy}
    token_body = {
        "code": code,
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    }
    if state:
        token_body["state"] = state
    last = None
    headers = token_headers()
    for url in token_urls:
        for name in IMPERSONATES:
            print(f"[token] POST {url} impersonate={name} ua=chrome146", file=sys.stderr)
            try:
                tr = call(
                    cffi_requests,
                    "post",
                    url,
                    name,
                    headers=headers,
                    json=token_body,
                    proxies=proxies,
                    timeout=60,
                )
            except Exception as e:  # noqa: BLE001
                last = f"{type(e).__name__}: {e}"
                print(last, file=sys.stderr)
                continue
            if is_cf_html(tr.text or "", tr.status_code):
                last = f"{tr.status_code} cloudflare_challenge impersonate={name or 'none'}"
                print(last, file=sys.stderr)
                continue
            if tr.status_code != 200:
                last = f"{tr.status_code} {public_body(tr)}"
                print(last, file=sys.stderr)
                if is_rate_limited(tr.status_code, tr.text or ""):
                    break
                continue
            token = tr.json() or {}
            if not token.get("access_token"):
                last = "no access_token"
                continue
            sys.stdout.write(json.dumps(token, separators=(",", ":")))
            sys.stdout.write("\n")
            return 0
    print(last or "token exchange failed", file=sys.stderr)
    return 2


def bootstrap_cli(cffi_requests, access_token: str, proxies):
    last = None
    for name in (None, "chrome146", "chrome136"):
        print(f"[4/5] GET bootstrap impersonate={name or 'none'}", file=sys.stderr)
        try:
            resp = call(
                cffi_requests,
                "get",
                BOOTSTRAP_URL,
                name,
                headers=cli_headers(access_token),
                proxies=proxies,
                timeout=60,
            )
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            print(f"[4/5] bootstrap warn {last}", file=sys.stderr)
            continue
        if resp.status_code == 200:
            data = resp.json() or {}
            account = data.get("oauth_account") or data.get("account") or {}
            print("[4/5] bootstrap ok", file=sys.stderr)
            return data, account, True
        last = f"{resp.status_code} {public_body(resp)}"
        print(f"[4/5] bootstrap warn {last}", file=sys.stderr)
    return {}, {}, False


def enable_grove(cffi_requests, access_token: str, proxies):
    headers = {**cli_headers(access_token), "Content-Type": "application/json"}
    last = None
    for url in GROVE_PATHS:
        print(f"[5/5] PATCH grove {url.split('://', 1)[-1].split('/', 1)[0]}", file=sys.stderr)
        try:
            resp = call(
                cffi_requests,
                "patch",
                url,
                None,
                headers=headers,
                json={"grove_enabled": True},
                proxies=proxies,
                timeout=60,
            )
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            print(f"[5/5] grove warn {last}", file=sys.stderr)
            continue
        if resp.status_code in (200, 202, 204):
            print(f"[5/5] grove ok status={resp.status_code}", file=sys.stderr)
            return True, resp.status_code
        last = f"{resp.status_code} {public_body(resp)}"
        print(f"[5/5] grove warn {last}", file=sys.stderr)
    return False, last


def main() -> int:
    if (os.environ.get("IMPORT_MODE") or "").strip() == "token_exchange":
        return token_exchange_main()
    sk = (os.environ.get("SESSION_KEY") or (sys.argv[1] if len(sys.argv) > 1 else "")).strip().strip("\"'")
    proxy = normalize_proxy(os.environ.get("PROXY_URL") or "")
    scope_name = (os.environ.get("SCOPE") or "full").strip() or "full"
    if not sk.startswith("sk-ant-sid"):
        print("expected sk-ant-sid* sessionKey", file=sys.stderr)
        return 2
    if not proxy:
        print("proxy_required", file=sys.stderr)
        return 2
    scope = SCOPE_INFERENCE if scope_name == "inference" else SCOPE_API
    cffi_requests = load_cffi()
    proxies = {"http": proxy, "https": proxy}
    cookies = session_cookies(sk)

    org_uuid = (os.environ.get("ORG_UUID") or "").strip() or None
    impersonate = "chrome146"
    if org_uuid:
        print(f"[1/5] org={org_uuid} supplied skip GET organizations", file=sys.stderr)
    else:
        r = None
        last = None
        impersonate = None
        for name in IMPERSONATES:
            print(f"[1/5] GET /api/organizations impersonate={name}", file=sys.stderr)
            try:
                r = call(
                    cffi_requests,
                    "get",
                    f"{CLAUDE_WEB}/api/organizations",
                    name,
                    cookies=cookies,
                    headers=orgs_headers(),
                    proxies=proxies,
                    timeout=60,
                )
            except Exception as e:  # noqa: BLE001
                last = f"orgs request failed: {type(e).__name__}: {e}"
                print(last, file=sys.stderr)
                continue
            if is_cf_html(r.text or "", r.status_code):
                last = f"orgs failed: {r.status_code} cloudflare_challenge impersonate={name}"
                print(last, file=sys.stderr)
                continue
            if r.status_code != 200:
                print(f"orgs failed: {r.status_code} {public_body(r)}", file=sys.stderr)
                return 2
            impersonate = name
            break
        else:
            print(last or "orgs failed: no chrome impersonate available", file=sys.stderr)
            return 2

        orgs = r.json()
        if not isinstance(orgs, list) or not orgs:
            print("no organizations", file=sys.stderr)
            return 2
        team = next((o for o in orgs if o.get("raven_type") == "team"), None)
        org = team or orgs[0]
        org_uuid = org.get("uuid")
        print(f"[1/5] org={org_uuid} raven={org.get('raven_type')}", file=sys.stderr)

    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = b64url(secrets.token_bytes(32))
    auth_url = f"{PLATFORM}/v1/oauth/{org_uuid}/authorize"
    base_body = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": scope,
        "state": state,
        "code_challenge": challenge,
    }
    extra_body = {
        **base_body,
        "organization_uuid": org_uuid,
        "code_challenge_method": "S256",
    }
    print(f"[2/5] POST platform authorize {auth_url}", file=sys.stderr)
    r = None
    last_auth = None
    seen_imp = set()
    auth_imps = []
    for name in (impersonate, *IMPERSONATES):
        if name in seen_imp:
            continue
        seen_imp.add(name)
        auth_imps.append(name)
    for name in auth_imps:
        for body in (base_body, extra_body):
            try:
                r = call(
                    cffi_requests,
                    "post",
                    auth_url,
                    name,
                    cookies=cookies,
                    headers=authorize_headers(),
                    json=body,
                    proxies=proxies,
                    timeout=60,
                )
            except Exception as e:  # noqa: BLE001
                last_auth = f"{type(e).__name__}: {e}"
                print(f"[2/5] authorize error {last_auth}", file=sys.stderr)
                continue
            if r.status_code == 200:
                impersonate = name
                break
            last_auth = public_body(r)
            if is_session_stale(r.text or "") or is_session_stale(last_auth):
                print(
                    "session_stale_relogin: Session is not fresh enough. "
                    "Re-login claude.ai and copy a new sessionKey.",
                    file=sys.stderr,
                )
                return 2
            print(f"[2/5] authorize retry {r.status_code} impersonate={name} {last_auth}", file=sys.stderr)
        if r is not None and r.status_code == 200:
            break
    if r is None or r.status_code != 200:
        print(f"authorize failed: {getattr(r, 'status_code', '?')} {last_auth}", file=sys.stderr)
        return 2
    redirect = (r.json() or {}).get("redirect_uri") or ""
    parsed = urlparse(redirect)
    qs = parse_qs(parsed.query)
    auth_code = (qs.get("code") or [None])[0]
    resp_state = (qs.get("state") or [None])[0]
    if not auth_code:
        print("no code in redirect_uri", file=sys.stderr)
        return 2
    print(f"[2/5] platform authorize code={redact(auth_code)}", file=sys.stderr)

    token_body = {
        "code": auth_code,
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    }
    if resp_state:
        token_body["state"] = resp_state

    token = None
    last = None
    headers = token_headers()
    token_imps = []
    seen_imp = set()
    for name in (impersonate, *IMPERSONATES):
        if not name or name in seen_imp:
            continue
        seen_imp.add(name)
        token_imps.append(name)
    for url in TOKEN_URLS:
        for name in token_imps:
            print(f"[3/5] POST chrome token {url} impersonate={name}", file=sys.stderr)
            try:
                tr = call(
                    cffi_requests,
                    "post",
                    url,
                    name,
                    headers=headers,
                    json=token_body,
                    proxies=proxies,
                    timeout=60,
                )
            except Exception as e:  # noqa: BLE001
                last = str(e)
                print(f"[3/5] error {last}", file=sys.stderr)
                continue
            if is_cf_html(tr.text or "", tr.status_code):
                last = f"{tr.status_code} cloudflare_challenge impersonate={name or 'none'}"
                print(f"[3/5] {last}", file=sys.stderr)
                continue
            if tr.status_code != 200:
                last = f"{tr.status_code} {public_body(tr)}"
                print(f"[3/5] {last}", file=sys.stderr)
                if is_rate_limited(tr.status_code, tr.text or ""):
                    break
                continue
            token = tr.json() or {}
            if not token.get("access_token"):
                last = "no access_token"
                continue
            print("[3/5] chrome token ok", file=sys.stderr)
            break
        if token and token.get("access_token"):
            break
    if not token or not token.get("access_token"):
        print(f"token exchange failed: {last}", file=sys.stderr)
        return 2

    if scope_name == "inference":
        boot_account, bootstrap_ok = {}, False
        grove_ok, grove_status = False, "skipped"
        print("[4/5] skip bootstrap/grove for inference setup-token", file=sys.stderr)
    else:
        _boot_data, boot_account, bootstrap_ok = bootstrap_cli(
            cffi_requests, token["access_token"], proxies,
        )
        grove_ok, grove_status = enable_grove(cffi_requests, token["access_token"], proxies)
        if not bootstrap_ok:
            print("[4/5] bootstrap failed (commit anyway)", file=sys.stderr)
        if not grove_ok:
            print(f"[5/5] grove failed (commit anyway) {grove_status}", file=sys.stderr)

    tok_acct = token.get("account") or {}
    tok_org = token.get("organization") or {}
    expires_in = int(token.get("expires_in") or 0)
    now = int(time.time())
    out = {
        "type": "setup-token" if scope_name == "inference" else "oauth",
        "platform": "anthropic",
        "access_token": token.get("access_token"),
        "refresh_token": token.get("refresh_token") or "",
        "token_type": token.get("token_type") or "Bearer",
        "expires_in": expires_in,
        "expires_at": now + (expires_in or 28800),
        "scope": token.get("scope") or scope,
        "org_uuid": (
            boot_account.get("organization_uuid")
            or boot_account.get("org_uuid")
            or tok_org.get("uuid")
            or org_uuid
        ),
        "account_uuid": (
            boot_account.get("account_uuid")
            or boot_account.get("uuid")
            or tok_acct.get("uuid")
            or ""
        ),
        "email_address": (
            boot_account.get("account_email")
            or boot_account.get("email")
            or tok_acct.get("email_address")
            or ""
        ),
        "email": (
            boot_account.get("account_email")
            or boot_account.get("email")
            or tok_acct.get("email_address")
            or ""
        ),
        "source": "sessionKey-portunex-cffi",
        "bootstrap_ok": bootstrap_ok,
        "grove_ok": grove_ok,
        "converted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    print(
        f"[ok] source=portunex-cffi bootstrap={bootstrap_ok} grove={grove_ok} "
        f"expires_in={expires_in} at={redact(out['access_token'])} "
        f"rt={redact(out['refresh_token'])}",
        file=sys.stderr,
    )
    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
