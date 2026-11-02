# Clean benchmark verification · claude-opus-5-5 · 2026-11-02

- Target: `external /v1/messages`
- Model override: `claude-opus-5-5` for every case
- Request order: sequential
- User-Agent: `kin-console-test/1.0`
- Started: 2026-11-02T08:35:25.997Z
- Finished: 2026-11-02T08:37:00.350Z

| ID | Model | HTTP | Time | Verdict | Failed checks |
|---|---|---:|---:|---|---|
| 01-tools-list | claude-opus-5-5 | 200 | 7.3s | 干净 |  |
| 02-vision | claude-opus-5-5 | 200 | 7.1s | 干净 |  |
| 03-web-search | claude-opus-5-5 | 200 | 22.3s | 干净 |  |
| 04-identity | claude-opus-5-5 | 200 | 19.8s | 干净 |  |
| 05-roleplay | claude-opus-5-5 | 200 | 5.6s | 干净 |  |
| 06-prompt-leak | claude-opus-5-5 | 200 | 13.9s | 不干净 | no_cc_identity |
| 07-forced-weather | claude-opus-5-5 | 200 | 6.3s | 干净 |  |

Result: 6/7 clean; 1 dirty.
