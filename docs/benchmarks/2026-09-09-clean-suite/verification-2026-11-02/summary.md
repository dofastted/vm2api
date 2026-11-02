# Clean benchmark verification · 2026-11-02

- Target: `external /v1/messages`
- Request order: sequential
- User-Agent: `kin-console-test/1.0`
- Started: 2026-11-02T08:22:22.100Z
- Finished: 2026-11-02T08:23:45.627Z

| ID | Model | HTTP | Time | Verdict | Failed checks |
|---|---|---:|---:|---|---|
| 01-tools-list | claude-sonnet-5 | 200 | 6.8s | 干净 |  |
| 02-vision | claude-opus-4-6 | 200 | 8.3s | 干净 |  |
| 03-web-search | claude-opus-4-8 | 200 | 22.0s | 干净 |  |
| 04-identity | claude-opus-5 | 200 | 17.9s | 干净 |  |
| 05-roleplay | claude-opus-5 | 200 | 5.1s | 干净 |  |
| 06-prompt-leak | claude-sonnet-5 | 200 | 7.3s | 不干净 | no_cc_identity |
| 07-forced-weather | claude-sonnet-5 | 200 | 4.0s | 干净 |  |

Result: 6/7 clean; 1 dirty.

The existing `results/` archive remains unchanged; this dated directory contains the fresh verification.
