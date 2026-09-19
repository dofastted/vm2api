# Claude Code wrap patches (cache)

Wrap `native_messages` sends `wireMessages` and **does not** run Claude Code
`addCacheBreakpoints`. Client markers on the last `tool_use` / `tool_result`
wander every tool round and freeze Anthropic `cache_read` at the tools+system
prefix (~45k).

## Split of work

| Layer | What it does |
|---|---|
| Node `prepareCliHopBody` | Strip **all** message/tool/system `cache_control`. Wrap owns tools + system. |
| `crates/kin-kernel` `stamp_cli_hop_message_breakpoints` | After hop: drop leftover markers, stamp the last **non-thinking** block (Claude Code) **and** the previous user (needed so +assistant+user tool loops still overlap last turn). `{type:ephemeral}` (missing ttl = 5m). |

Do not re-stamp last user in Node; wrap would then see two message markers plus tools/system and 400 (often surfaced as Connection error).

Rebuild `bin/kin-kernel` after this change (`npm run build:kernel`). Slot `.kin/kin-kernel.bin` is copied from that binary on wrap sync.
