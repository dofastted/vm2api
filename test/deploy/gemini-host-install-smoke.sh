#!/usr/bin/env bash
set -euo pipefail

[[ $# == 2 && $(id -u) == 0 ]]
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
source=$(realpath -- "$1")
public_key=$(realpath -- "$2")
fixture=$(mktemp -d /opt/gemini-test.XXXXXX)
pid=''
stop() {
    if [[ -z $pid ]]; then return; fi
    if kill -0 "$pid" 2>/dev/null; then kill "$pid"; fi
    wait "$pid"
    pid=''
}
trap 'stop; rm -rf -- "$fixture"' EXIT
mkdir -m 755 -p "$fixture"/{scripts,src/lib/gemini,source,payload}
install -m 644 "$root"/scripts/{gemini-host.py,gemini-host-egress.sh,gemini_host_account.py,install-gemini-payload.mjs} "$fixture/scripts/"
install -m 644 "$root/src/lib/gemini/payload.mjs" "$fixture/src/lib/gemini/"
install -m 644 "$public_key" "$fixture/public-key"
for member in manifest.json manifest.sig agy craggemini libagy_bridge.so; do
    install -m 644 "$source/$member" "$fixture/source/$member"
done

socket="$fixture/control.sock"
start() {
    python3 -I "$fixture/scripts/gemini-host.py" --state "$fixture/state" \
        --payload "$fixture/payload/current" --payload-source "$fixture/source" \
        --public-key "$fixture/public-key" --egress "$fixture/unneeded-kin-egress" \
        --socket "$socket" --gateway-group root --uid-base 29000 &
    pid=$!
    for attempt in {1..50}; do
        if [[ -S $socket ]]; then return; fi
        kill -0 "$pid"
        sleep .1
    done
    return 1
}
request() {
    local body=${2-}
    if [[ -z $body ]]; then body='{}'; fi
    python3 - "$socket" "$1" "$body" <<'PY'
import http.client
import socket
import sys

client = http.client.HTTPConnection("localhost", timeout=40)
with socket.socket(socket.AF_UNIX) as transport:
    transport.settimeout(40)
    transport.connect(sys.argv[1])
    client.sock = transport
    client.request("POST", "/" + sys.argv[2], sys.argv[3], {"Content-Type": "application/json"})
    sys.stdout.buffer.write(client.getresponse().read())
PY
}

mv "$fixture/public-key" "$fixture/held-key"
start
request list | python3 -c 'import json,sys; data=json.load(sys.stdin); assert (data["payload_state"], data["payload_issue"]) == ("not_configured", "gemini_public_key_missing")'
mv "$fixture/held-key" "$fixture/public-key"
request list | python3 -c 'import json,sys; data=json.load(sys.stdin); assert (data["payload_state"], data["payload_issue"], data["environments"]) == ("install_on_create", None, []) and data["oauth_runtime_issue"] in ("gemini_egress_unavailable", "gemini_oauth_tools_missing")'
KIN_GEMINI_HOST_SOCKET="$socket" node --input-type=module - "$root/src/lib/gemini/routes.mjs" <<'JS'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const { createGeminiPanelHandler } = await import(pathToFileURL(process.argv[2]))
const handler = createGeminiPanelHandler({ json: (_response, status, body) => ({ status, body }) })
const result = await handler({ method: 'GET' }, { setHeader() {} }, '/api/panel/gemini')
assert.equal(result.body.data.available, true)
assert.equal(result.body.data.payload_state, 'install_on_create')
assert.equal(result.body.data.payload_issue, null)
assert.deepEqual(result.body.data.environments, [])
JS
[[ ! -e $fixture/payload/current ]]
create='{"name":"Fixture","proxy_id":"fixture","proxy_url":"socks5h://192.0.2.1:1080"}'
mv "$fixture/source" "$fixture/held-source"
request create "$create" | python3 -c 'import json,sys; assert json.load(sys.stdin)["code"] == "gemini_payload_source_missing"'
mv "$fixture/held-source" "$fixture/source"
mv "$fixture/source/agy" "$fixture/held-agy"
request create "$create" | python3 -c 'import json,sys; assert json.load(sys.stdin)["code"] == "gemini_payload_incomplete"'
mv "$fixture/held-agy" "$fixture/source/agy"
printf '%064d' 0 > "$fixture/source/manifest.sig"
request create "$create" | python3 -c 'import json,sys; assert json.load(sys.stdin)["code"] == "gemini_payload_invalid"'
[[ ! -e $fixture/state/environments.json && ! -e $fixture/payload/current ]]
install -m 644 "$source/manifest.sig" "$fixture/source/manifest.sig"
request create "$create" | python3 -c 'import json,sys; data=json.load(sys.stdin); assert (data["name"], data["auth_state"], data["kernel_version"]) == ("Fixture", "unverified", "0.3.0-rc.1")'
[[ -x $fixture/payload/current/craggemini && -x $fixture/payload/current/agy ]]
stop
start
request list | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["payload_state"] == "installed" and data["environments"][0]["name"] == "Fixture"'
chmod -x "$fixture/payload/current/agy"
request list | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["payload_issue"] == "gemini_payload_incomplete" and data["environments"][0]["kernel_version"] is None'
chmod +x "$fixture/payload/current/agy"
request list | python3 -c 'import json,sys; assert json.load(sys.stdin)["payload_state"] == "installed"'
stop

python3 - "$fixture" <<'PY'
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys

root = Path(sys.argv[1])
control = root / "control.sock"
address = "\0gemini-host-smoke-" + root.name
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
    stale.bind(str(control))
with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as listener:
    listener.bind(address)
    listener.settimeout(10)
    host = subprocess.Popen([
        sys.executable, "-I", str(root / "scripts/gemini-host.py"),
        "--state", str(root / "state"), "--payload", str(root / "payload/current"),
        "--public-key", str(root / "public-key"), "--egress", str(root / "unneeded-kin-egress"),
        "--socket", str(control), "--gateway-group", "root", "--uid-base", "29000",
    ], env={**os.environ, "NOTIFY_SOCKET": "@" + address[1:]})
    try:
        assert listener.recv(64) == b"READY=1"
        assert stat.S_IMODE(control.stat().st_mode) == 0o660
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(str(control))
    finally:
        host.terminate()
        assert host.wait(timeout=10) == 0
PY
printf '%s\n' 'Gemini host: readiness notification, missing prerequisites, signature enforcement, lazy install and restart persistence passed.'

python3 -I - "$fixture/scripts/gemini_host_account.py" <<'PY'
import runpy
import sys
from unittest.mock import patch

module = runpy.run_path(sys.argv[1])
probe = module["probe_oauth"]
proxy = "socks5h://fixture:secret@192.0.2.1:1080"

def google(proxy_url, url, header, body=None):
    assert proxy_url == proxy
    if url == module["GEMINI_MODELS"]:
        assert header == "x-goog-api-key: fixture"
        return 200, {"models": [{"name": "models/gemini-3.1-pro"}], "nextPageToken": "page"}
    assert header == "Authorization: Bearer fixture"
    if url == module["GOOGLE_USERINFO"]:
        return 200, {"email": "test@example.invalid", "access_token": "never expose"}
    if url.endswith("loadCodeAssist"):
        return 200, {"cloudaicompanionProject": "example", "paidTier": {
            "name": "Pro", "availableCredits": [{"creditType": "AI", "creditAmount": "0"}]}}
    assert body == {"project": "example"}
    if url.endswith("retrieveUserQuotaSummary"):
        return 200, {"groups": [{"displayName": "Gemini Pro", "buckets": [
            {"bucketId": "pro-weekly", "window": "weekly"},
            {"bucketId": "pro-5h", "window": "5h", "remainingFraction": 0, "resetTime": "2030-01-02T05:00:00Z"},
            {"bucketId": "pro-disabled", "window": "5h", "remainingFraction": 1, "disabled": True},
            {"bucketId": "pro-invalid", "window": "5h", "remainingFraction": False},
        ]}]}
    assert url.endswith("fetchAvailableModels")
    return 200, {"models": {"gemini-3.1-pro": {"quotaInfo": {"remainingFraction": 0}}, "gemini-unknown": {}}}

with patch.dict(probe.__globals__, {
    "get_json": google, "read_token": lambda _: {
        "token": {"access_token": "fixture", "refresh_token": "never expose", "expiry": "2030-01-01T00:00:00Z"},
        "id_token_email": "stored@example.invalid", "region": "fixture-region", "tier_display_name": "Stored tier",
    },
}):
    info = probe(proxy, None)
    assert (info["state"], info["email"], info["plan"], info["project_id"]) == ("ok", "test@example.invalid", "Pro", "example")
    assert info["models"] == ["gemini-3.1-pro", "gemini-unknown"]
    assert info["quotas"] == [{"model": "gemini-3.1-pro", "remaining_fraction": 0, "reset_at": None}]
    assert info["quota_groups"] == [{"name": "Gemini Pro", "windows": [
        {"id": "pro-5h", "period": "5h", "remaining_fraction": 0, "reset_at": "2030-01-02T05:00:00Z"},
        {"id": "pro-weekly", "period": "weekly", "remaining_fraction": None, "reset_at": None},
    ]}]
    assert info["credits"] == [{"type": "AI", "amount": "0"}]
    assert info["region"] == "fixture-region" and info["expires_at"] == "2030-01-01T00:00:00Z"
    assert "never expose" not in str(info) and proxy not in str(info)
    api = module["probe_api_key"](proxy, "fixture")
    assert api["state"] == "partial" and api["models"] == ["gemini-3.1-pro"] and "email" not in api and "quota_groups" not in api

    def summary_unavailable(proxy_url, url, header, body=None):
        if url.endswith("retrieveUserQuotaSummary"):
            return 403, {}
        return google(proxy_url, url, header, body)

    with patch.dict(probe.__globals__, {"get_json": summary_unavailable}):
        fallback = probe(proxy, None)
        assert fallback["state"] == "ok" and "quota_groups" not in fallback and fallback["quotas"] == info["quotas"]

with patch.dict(probe.__globals__, {"get_json": lambda *_: (401, {})}):
    assert module["probe_api_key"](proxy, "fixture")["state"] == "reauth_required"
print("Gemini account reads: OAuth and API key fixtures, quota zero, credential redaction and failure status passed.")
PY
