#!/usr/bin/env python3
"""Compile real OMP & Claude sessions into a redacted, byte-length-preserving 100K-context corpus.

Redaction strictly follows X:/crag-standalone/scripts/replay-history.py:
- Every string leaf is replaced by hashlib.shake_256(position).hexdigest((size + 1) // 2)[:size]
  preserving exact UTF-8 byte length with zero plaintext entropy.
- JSON nesting structure, tool_use/tool_result pairing, thinking blocks, and cache_control
  breakpoints are preserved while ensuring Anthropic /v1/messages and vm2api validity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import sys
from pathlib import Path
from typing import Any

DEFAULT_OMP_DIR = Path("/home/mci777/.omp/agent/sessions")
DEFAULT_CLAUDE_DIR = Path("/home/mci777/.claude/projects")
DEFAULT_MODEL = "claude-sonnet-4-5-20250929"

# Official Claude models enabled in vm2api seedDefaultPolicy() with >= 200K context window
# and full pricing coverage in builtin-rates.mjs.
OFFICIAL_CLAUDE_MODELS = frozenset(
    {
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-sonnet-5-5",
        "claude-opus-5",
        "claude-opus-5-5",
    }
)

ADAPTIVE_THINKING_MODELS = frozenset(
    {
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-sonnet-5-5",
        "claude-opus-5",
        "claude-opus-5-5",
    }
)

ADAPTIVE_REQUIRED_MODELS = frozenset({"claude-opus-5-5", "claude-sonnet-5-5"})

STANDARD_SCHEMA_TYPES = frozenset({"object", "string", "number", "integer", "boolean", "array", "null"})

PROTOCOL_KEYWORDS = frozenset(
    {
        "type",
        "text",
        "role",
        "user",
        "assistant",
        "system",
        "content",
        "input",
        "name",
        "model",
        "stream",
        "messages",
        "tools",
        "thinking",
        "signature",
        "tool_use",
        "tool_result",
        "tool_use_id",
        "is_error",
        "cache_control",
        "ephemeral",
        "max_tokens",
        "input_schema",
        "properties",
        "required",
        "additionalProperties",
        "description",
        "items",
        "object",
        "string",
        "boolean",
        "integer",
        "number",
        "array",
        "null",
        "adaptive",
        "enabled",
        "budget_tokens",
        "ttl",
        "5m",
        "1h",
        "title",
        "enum",
        "anyOf",
        "oneOf",
        "allOf",
        "default",
        "redacted_thinking",
        "data",
        "id",
        "session_key",
        "turn_index",
        "approx_tokens",
        "body_bytes",
        "body",
        "expected_usage",
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    }
)

NON_HEX_RE = re.compile(r"[^0-9a-f]")
HEX_ONLY_RE = re.compile(r"^[0-9a-f]*$")
DOTTED_VERSION_RE = re.compile(r"(\d)\.(\d)")
CONTEXT_1M_SUFFIX_RE = re.compile(r"\[1m\]$", re.IGNORECASE)


class RedactionTracker:
    """Tracks byte-length preservation counts and raw plaintext probes for zero-leakage audits."""

    def __init__(self, max_probes_per_session: int = 40) -> None:
        self.max_probes_per_session = max_probes_per_session
        self.byte_length_checked = 0
        self.byte_length_mismatches = 0
        self.probes_by_session: dict[str, list[str]] = {}

    def record_probe(self, session_tag: str, raw: str) -> None:
        if not isinstance(raw, str):
            return
        bucket = self.probes_by_session.setdefault(session_tag, [])
        if len(bucket) >= self.max_probes_per_session:
            return
        # Extract meaningful non-hex plaintext slices that cannot collide with masked [0-9a-f] text.
        text = raw.strip()
        if not text:
            return
        candidates: list[str] = []
        if len(text) >= 24:
            candidates.append(text[:32])
            if len(text) >= 96:
                mid = len(text) // 2
                candidates.append(text[mid : mid + 32])
        elif len(text) >= 10:
            candidates.append(text)
        for cand in candidates:
            if len(bucket) >= self.max_probes_per_session:
                break
            if cand in PROTOCOL_KEYWORDS:
                continue
            if not NON_HEX_RE.search(cand):
                continue
            if cand.startswith("fixture_") or cand.startswith("field_") or cand.startswith("toolu_"):
                continue
            if cand.startswith("claude-"):
                continue
            if cand not in bucket:
                bucket.append(cand)

    def mask_str(self, value: str, position: str, session_tag: str | None = None) -> str:
        if session_tag is not None:
            self.record_probe(session_tag, value)
        size = len(value.encode("utf-8"))
        if size == 0:
            return ""
        masked = hashlib.shake_256(position.encode("utf-8")).hexdigest((size + 1) // 2)[:size]
        self.byte_length_checked += 1
        if len(masked.encode("utf-8")) != size:
            self.byte_length_mismatches += 1
        return masked

    def mask_value(self, value: Any, position: str, session_tag: str | None = None) -> Any:
        if isinstance(value, str):
            return self.mask_str(value, position, session_tag)
        if isinstance(value, list):
            return [self.mask_value(item, f"{position}/{idx}", session_tag) for idx, item in enumerate(value)]
        if isinstance(value, dict):
            out: dict[str, Any] = {}
            for idx, (key, item) in enumerate(value.items()):
                if session_tag is not None and isinstance(key, str) and len(key) >= 10:
                    self.record_probe(session_tag, key)
                out[f"field_{idx}"] = self.mask_value(item, f"{position}/{idx}", session_tag)
            return out
        return None if value is None else False if isinstance(value, bool) else 0

    def mask_schema(self, schema: Any, position: str, session_tag: str | None = None) -> dict[str, Any]:
        if not isinstance(schema, dict):
            return {"type": "object"}
        out: dict[str, Any] = {}
        raw_type = schema.get("type")
        if isinstance(raw_type, str) and raw_type in STANDARD_SCHEMA_TYPES:
            out["type"] = raw_type
        elif isinstance(raw_type, list):
            clean_types = [t for t in raw_type if isinstance(t, str) and t in STANDARD_SCHEMA_TYPES]
            if clean_types:
                out["type"] = clean_types
        if isinstance(schema.get("description"), str) and schema["description"]:
            out["description"] = self.mask_str(schema["description"], f"{position}/description", session_tag)
        if isinstance(schema.get("title"), str) and schema["title"]:
            out["title"] = self.mask_str(schema["title"], f"{position}/title", session_tag)
        if isinstance(schema.get("properties"), dict):
            prop_map: dict[str, str] = {}
            masked_props: dict[str, Any] = {}
            for idx, (pkey, pval) in enumerate(schema["properties"].items()):
                if session_tag is not None and isinstance(pkey, str) and len(pkey) >= 10:
                    self.record_probe(session_tag, pkey)
                alias = f"field_{idx}"
                prop_map[pkey] = alias
                masked_props[alias] = self.mask_schema(pval, f"{position}/properties/{idx}", session_tag)
            out["properties"] = masked_props
            if isinstance(schema.get("required"), list):
                req = [prop_map[k] for k in schema["required"] if isinstance(k, str) and k in prop_map]
                if req:
                    out["required"] = req
        if "additionalProperties" in schema:
            ap = schema["additionalProperties"]
            if isinstance(ap, bool):
                out["additionalProperties"] = ap
            elif isinstance(ap, dict):
                out["additionalProperties"] = self.mask_schema(ap, f"{position}/additionalProperties", session_tag)
        if "items" in schema:
            items = schema["items"]
            if isinstance(items, dict):
                out["items"] = self.mask_schema(items, f"{position}/items", session_tag)
            elif isinstance(items, list):
                out["items"] = [
                    self.mask_schema(it, f"{position}/items/{i}", session_tag) for i, it in enumerate(items)
                ]
        for comb in ("anyOf", "oneOf", "allOf"):
            if isinstance(schema.get(comb), list):
                out[comb] = [
                    self.mask_schema(sub, f"{position}/{comb}/{i}", session_tag)
                    for i, sub in enumerate(schema[comb])
                ]
        if isinstance(schema.get("enum"), list) and schema["enum"]:
            out["enum"] = [
                self.mask_value(val, f"{position}/enum/{i}", session_tag) for i, val in enumerate(schema["enum"])
            ]
        if "default" in schema:
            out["default"] = self.mask_value(schema["default"], f"{position}/default", session_tag)
        if not out:
            out["type"] = "object"
        return out


def compact_json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def compact_json_str(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def normalize_model(raw_model: Any) -> str:
    if not isinstance(raw_model, str) or not raw_model.strip():
        return DEFAULT_MODEL
    bare = raw_model.strip().split("/")[-1]
    bare = CONTEXT_1M_SUFFIX_RE.sub("", bare).strip()
    if bare.lower().startswith("claude-"):
        bare = DOTTED_VERSION_RE.sub(r"\1-\2", bare).lower()
    else:
        return DEFAULT_MODEL
    if bare == "claude-sonnet-4-5":
        return "claude-sonnet-4-5-20250929"
    if bare in OFFICIAL_CLAUDE_MODELS:
        return bare
    return DEFAULT_MODEL


def thinking_config_for_model(model: str, has_thinking: bool) -> dict[str, Any] | None:
    if model in ADAPTIVE_REQUIRED_MODELS:
        return {"type": "adaptive"}
    if not has_thinking:
        return None
    if model in ADAPTIVE_THINKING_MODELS:
        return {"type": "adaptive"}
    return {"type": "enabled", "budget_tokens": 2048}


def safe_int(val: Any) -> int:
    if isinstance(val, bool):
        return 0
    if isinstance(val, (int, float)) and math.isfinite(val) and val > 0:
        return int(val)
    return 0


def parse_usage_dict(usage: Any, is_omp: bool = False) -> dict[str, int] | None:
    if not isinstance(usage, dict):
        return None
    if is_omp:
        inp = safe_int(usage.get("input"))
        out = safe_int(usage.get("output"))
        cr = safe_int(usage.get("cacheRead"))
        cw = safe_int(usage.get("cacheWrite"))
    else:
        inp = safe_int(usage.get("input_tokens"))
        out = safe_int(usage.get("output_tokens"))
        cr = safe_int(usage.get("cache_read_input_tokens"))
        cw = safe_int(usage.get("cache_creation_input_tokens"))
    if inp + cr + cw + out <= 0:
        return None
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_input_tokens": cr,
        "cache_creation_input_tokens": cw,
    }


def redact_tool_result_content(
    raw_content: Any,
    position: str,
    tracker: RedactionTracker,
    session_tag: str,
) -> str | list[dict[str, Any]]:
    if isinstance(raw_content, str):
        return tracker.mask_str(raw_content, f"{position}/content", session_tag)
    if isinstance(raw_content, list):
        blocks: list[dict[str, Any]] = []
        for idx, item in enumerate(raw_content):
            if isinstance(item, str):
                if item:
                    blocks.append({"type": "text", "text": tracker.mask_str(item, f"{position}/c/{idx}", session_tag)})
            elif isinstance(item, dict):
                btype = item.get("type")
                if btype == "text" and isinstance(item.get("text"), str) and item["text"]:
                    blocks.append(
                        {"type": "text", "text": tracker.mask_str(item["text"], f"{position}/c/{idx}", session_tag)}
                    )
                elif btype == "image":
                    mime = str(item.get("mimeType") or (item.get("source") or {}).get("media_type") or "image/png")
                    blocks.append(
                        {"type": "text", "text": tracker.mask_str(f"image:{mime}", f"{position}/c/{idx}", session_tag)}
                    )
        if blocks:
            return blocks
        return ""
    if raw_content is None:
        return ""
    return tracker.mask_str(compact_json_str(raw_content), f"{position}/content", session_tag)


def redact_tool_input(
    raw_input: Any,
    position: str,
    tracker: RedactionTracker,
    session_tag: str,
) -> dict[str, Any]:
    if isinstance(raw_input, str):
        try:
            parsed = json.loads(raw_input)
            if isinstance(parsed, dict):
                raw_input = parsed
            else:
                return {"field_0": tracker.mask_value(parsed, f"{position}/0", session_tag)}
        except Exception:
            return {"field_0": tracker.mask_str(raw_input, f"{position}/0", session_tag)}
    if isinstance(raw_input, dict):
        return tracker.mask_value(raw_input, position, session_tag)
    if raw_input is None:
        return {}
    return {"field_0": tracker.mask_value(raw_input, f"{position}/0", session_tag)}


def canonicalize_turns(
    raw_turns: list[dict[str, Any]],
    session_salt: str,
    tracker: RedactionTracker,
    session_tag: str,
    tool_names: dict[str, str],
) -> list[dict[str, Any]]:
    """Merge, redact, and enforce strict Anthropic alternation and 1:1 tool_use -> tool_result pairing.

    Input raw_turns: list of dicts with:
      - role: "user" | "assistant"
      - blocks: list of normalized unredacted block dicts:
          {"type": "text", "text": str}
          {"type": "thinking", "thinking": str, "signature": str | None}
          {"type": "tool_use", "raw_id": str, "raw_name": str, "raw_input": Any}
          {"type": "tool_result", "raw_tool_use_id": str, "raw_content": Any, "is_error": bool}
      - usage: optional parsed usage dict (for assistant turns)
      - model: optional raw model string (for assistant turns)

    Output: list of canonical redacted messages strictly alternating [user, assistant, user, ...]
    where each entry is {"role", "content", "usage", "model"} and every prefix messages[:2*k+1]
    is strictly legal Anthropic /v1/messages history.
    """
    if not raw_turns:
        return []

    # 1. Merge consecutive turns with the same role.
    merged: list[dict[str, Any]] = []
    for turn in raw_turns:
        role = turn.get("role")
        blocks = turn.get("blocks") or []
        if role not in ("user", "assistant") or not blocks:
            continue
        if merged and merged[-1]["role"] == role:
            merged[-1]["blocks"].extend(blocks)
            if turn.get("usage"):
                merged[-1]["usage"] = turn["usage"]
            if turn.get("model"):
                merged[-1]["model"] = turn["model"]
        else:
            merged.append(
                {
                    "role": role,
                    "blocks": list(blocks),
                    "usage": turn.get("usage"),
                    "model": turn.get("model"),
                }
            )

    # 2. Must start with a user turn.
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    if not merged:
        return []

    # 3. Redact and strictly pair tool_use (in assistant[i]) with tool_result (in user[i+1]).
    #    Anthropic requires:
    #    - U_0 has no tool_result blocks.
    #    - Every tool_use in A_k has a matching tool_result in U_{k+1}.
    #    - Every tool_result in U_{k+1} matches a tool_use in A_k.
    #    - Assistant block order: thinking -> text -> tool_use.
    #    - User block order: tool_result -> text.
    canonical: list[dict[str, Any]] = []
    tool_seq = 0

    def redact_user_text_blocks(blocks: list[dict[str, Any]], msg_idx: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for bidx, blk in enumerate(blocks):
            if blk.get("type") == "text":
                raw_text = blk.get("text")
                if isinstance(raw_text, str) and raw_text.strip():
                    masked = tracker.mask_str(raw_text, f"{session_salt}/m/{msg_idx}/u/{bidx}", session_tag)
                    if masked:
                        out.append({"type": "text", "text": masked})
        return out

    # Process U_0 (drop any orphan tool_result on first user message)
    u0_texts = redact_user_text_blocks(merged[0]["blocks"], 0)
    if not u0_texts:
        # If U_0 only had tool_results (e.g. post-compaction slice), convert its first tool_result into text
        # so the conversation still starts cleanly with a valid user text turn.
        for bidx, blk in enumerate(merged[0]["blocks"]):
            if blk.get("type") == "tool_result":
                rc = blk.get("raw_content")
                if isinstance(rc, str) and rc.strip():
                    u0_texts.append(
                        {"type": "text", "text": tracker.mask_str(rc, f"{session_salt}/m/0/u/{bidx}", session_tag)}
                    )
                    break
                if isinstance(rc, list):
                    for sidx, sub in enumerate(rc):
                        if isinstance(sub, dict) and sub.get("type") == "text" and isinstance(sub.get("text"), str) and sub["text"].strip():
                            u0_texts.append(
                                {
                                    "type": "text",
                                    "text": tracker.mask_str(
                                        sub["text"], f"{session_salt}/m/0/u/{bidx}/{sidx}", session_tag
                                    ),
                                }
                            )
                            break
                    if u0_texts:
                        break
    if not u0_texts:
        return []
    canonical.append({"role": "user", "content": u0_texts, "usage": None, "model": None})

    # Process subsequent (assistant, user) pairs.
    idx = 1
    while idx + 1 < len(merged):
        a_turn = merged[idx]
        u_turn = merged[idx + 1]
        if a_turn["role"] != "assistant" or u_turn["role"] != "user":
            break

        # Collect available tool_results in u_turn indexed by raw_tool_use_id (deduped in order).
        available_results: dict[str, dict[str, Any]] = {}
        for blk in u_turn["blocks"]:
            if blk.get("type") == "tool_result":
                tid = blk.get("raw_tool_use_id")
                if isinstance(tid, str) and tid and tid not in available_results:
                    available_results[tid] = blk

        a_msg_idx = len(canonical)
        u_msg_idx = a_msg_idx + 1

        a_thinking: list[dict[str, Any]] = []
        a_texts: list[dict[str, Any]] = []
        a_tool_uses: list[dict[str, Any]] = []
        u_tool_results: list[dict[str, Any]] = []
        seen_raw_tids: set[str] = set()

        for bidx, blk in enumerate(a_turn["blocks"]):
            btype = blk.get("type")
            pos = f"{session_salt}/m/{a_msg_idx}/a/{bidx}"
            if btype == "thinking":
                raw_th = blk.get("thinking")
                if isinstance(raw_th, str) and raw_th.strip():
                    masked_th = tracker.mask_str(raw_th, f"{pos}/thinking", session_tag)
                    raw_sig = blk.get("signature")
                    if isinstance(raw_sig, str) and raw_sig:
                        masked_sig = tracker.mask_str(raw_sig, f"{pos}/signature", session_tag)
                    else:
                        masked_sig = hashlib.shake_256(f"{pos}/signature".encode("utf-8")).hexdigest(32)
                    a_thinking.append({"type": "thinking", "thinking": masked_th, "signature": masked_sig})
            elif btype == "text":
                raw_txt = blk.get("text")
                if isinstance(raw_txt, str) and raw_txt.strip():
                    a_texts.append({"type": "text", "text": tracker.mask_str(raw_txt, f"{pos}/text", session_tag)})
            elif btype == "tool_use":
                raw_tid = blk.get("raw_id")
                raw_name = blk.get("raw_name")
                if not isinstance(raw_tid, str) or not raw_tid or raw_tid in seen_raw_tids:
                    continue
                if raw_tid not in available_results:
                    # Drop unmatched tool_use so tool_use -> tool_result pairing remains 100% valid.
                    continue
                seen_raw_tids.add(raw_tid)
                tracker.record_probe(session_tag, raw_tid)
                if isinstance(raw_name, str) and raw_name:
                    tracker.record_probe(session_tag, raw_name)
                mapped_name = tool_names.setdefault(str(raw_name or "tool"), f"fixture_{len(tool_names)}")
                new_tid = f"toolu_{session_salt[:8]}_{a_msg_idx}_{tool_seq:03d}"
                tool_seq += 1
                a_tool_uses.append(
                    {
                        "type": "tool_use",
                        "id": new_tid,
                        "name": mapped_name,
                        "input": redact_tool_input(blk.get("raw_input"), f"{pos}/input", tracker, session_tag),
                    }
                )
                res_blk = available_results[raw_tid]
                u_pos = f"{session_salt}/m/{u_msg_idx}/tr/{len(u_tool_results)}"
                u_tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": new_tid,
                        "content": redact_tool_result_content(res_blk.get("raw_content"), u_pos, tracker, session_tag),
                        "is_error": bool(res_blk.get("is_error")),
                    }
                )

        a_content = a_thinking + a_texts + a_tool_uses
        u_texts = redact_user_text_blocks(u_turn["blocks"], u_msg_idx)
        u_content = u_tool_results + u_texts

        # Both assistant and user must be non-empty; also assistant cannot contain ONLY thinking blocks.
        if not (a_texts or a_tool_uses) or not u_content:
            # Skip broken exchange without corrupting prior valid prefix.
            idx += 2
            continue

        canonical.append(
            {
                "role": "assistant",
                "content": a_content,
                "usage": a_turn.get("usage"),
                "model": a_turn.get("model"),
            }
        )
        canonical.append(
            {
                "role": "user",
                "content": u_content,
                "usage": None,
                "model": None,
            }
        )
        idx += 2

    return canonical


def parse_omp_file(
    path: Path,
    session_salt: str,
    tracker: RedactionTracker,
    session_tag: str,
) -> list[dict[str, Any]]:
    """Parse an OMP native .jsonl session file into one or more canonical conversation segments."""
    entries: dict[str, dict[str, Any]] = {}
    linear_rows: list[dict[str, Any]] = []
    leaf_id: str | None = None

    with path.open("rb") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if not isinstance(row, dict):
                continue
            if isinstance(row.get("cwd"), str):
                tracker.record_probe(session_tag, row["cwd"])
            eid = row.get("id")
            if isinstance(eid, str) and eid:
                entries[eid] = row
                leaf_id = eid
            linear_rows.append(row)

    # Walk parentId chain from leaf to root (exact replay-history.py branch model).
    if leaf_id and entries:
        chain: list[dict[str, Any]] = []
        cur: str | None = leaf_id
        seen: set[str] = set()
        while cur and cur in entries and cur not in seen:
            seen.add(cur)
            chain.append(entries[cur])
            parent = entries[cur].get("parentId")
            cur = parent if isinstance(parent, str) else None
        chain.reverse()
    else:
        chain = linear_rows

    # Split at compaction boundaries so each segment is a contiguous context window.
    raw_segments: list[list[dict[str, Any]]] = [[]]
    for row in chain:
        if row.get("type") == "compaction":
            if raw_segments[-1]:
                raw_segments.append([])
            summary = row.get("summary")
            if isinstance(summary, str) and summary.strip():
                raw_segments[-1].append(
                    {
                        "role": "user",
                        "blocks": [{"type": "text", "text": summary}],
                        "usage": None,
                        "model": None,
                    }
                )
            continue

        rtype = row.get("type")
        if rtype == "custom_message" and row.get("attribution") == "user":
            c = row.get("content")
            if isinstance(c, str) and c.strip():
                raw_segments[-1].append({"role": "user", "blocks": [{"type": "text", "text": c}]})
            continue

        if rtype != "message":
            continue
        msg = row.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        content = msg.get("content")

        if role == "user":
            blocks: list[dict[str, Any]] = []
            if isinstance(content, str) and content.strip():
                blocks.append({"type": "text", "text": content})
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                        if item["text"].strip():
                            blocks.append({"type": "text", "text": item["text"]})
                    elif isinstance(item, dict) and item.get("type") == "image":
                        mime = str(item.get("mimeType") or "image/png")
                        blocks.append({"type": "text", "text": f"image:{mime}"})
            if blocks:
                raw_segments[-1].append({"role": "user", "blocks": blocks})

        elif role == "assistant":
            if msg.get("stopReason") in ("error", "aborted") and not content:
                continue
            blocks = []
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    kind = item.get("type")
                    if kind == "thinking" and isinstance(item.get("thinking"), str) and item["thinking"].strip():
                        blocks.append(
                            {
                                "type": "thinking",
                                "thinking": item["thinking"],
                                "signature": item.get("signature") if isinstance(item.get("signature"), str) else None,
                            }
                        )
                    elif kind == "text" and isinstance(item.get("text"), str) and item["text"].strip():
                        blocks.append({"type": "text", "text": item["text"]})
                    elif kind == "toolCall" and item.get("id") and item.get("name"):
                        blocks.append(
                            {
                                "type": "tool_use",
                                "raw_id": str(item["id"]),
                                "raw_name": str(item["name"]),
                                "raw_input": item.get("arguments"),
                            }
                        )
            elif isinstance(content, str) and content.strip():
                blocks.append({"type": "text", "text": content})
            if blocks:
                raw_segments[-1].append(
                    {
                        "role": "assistant",
                        "blocks": blocks,
                        "usage": parse_usage_dict(msg.get("usage"), is_omp=True),
                        "model": msg.get("model"),
                    }
                )

        elif role == "toolResult":
            if msg.get("prunedAt"):
                continue
            tid = msg.get("toolCallId")
            if not isinstance(tid, str) or not tid:
                continue
            raw_segments[-1].append(
                {
                    "role": "user",
                    "blocks": [
                        {
                            "type": "tool_result",
                            "raw_tool_use_id": tid,
                            "raw_content": content,
                            "is_error": bool(msg.get("isError")),
                        }
                    ],
                }
            )

    segments_out: list[dict[str, Any]] = []
    # Prefer the richest segments first so a multi-compaction OMP file yields strong candidates quickly.
    for seg_idx, raw_turns in enumerate(raw_segments):
        if len(raw_turns) < 3:
            continue
        tool_names: dict[str, str] = {}
        seg_salt = f"{session_salt}_s{seg_idx}"
        canonical = canonicalize_turns(raw_turns, seg_salt, tracker, session_tag, tool_names)
        if len(canonical) < 3:
            continue
        models = [m["model"] for m in canonical if m["role"] == "assistant" and m.get("model")]
        model = normalize_model(models[-1] if models else None)
        tools = [{"name": mapped, "input_schema": {"type": "object"}} for mapped in tool_names.values()]
        segments_out.append(
            {
                "source": "omp",
                "session_tag": session_tag,
                "session_salt": seg_salt,
                "model": model,
                "system": None,
                "tools": tools,
                "messages": canonical,
            }
        )
    return segments_out


def parse_claude_file(
    path: Path,
    session_salt: str,
    tracker: RedactionTracker,
    session_tag: str,
) -> list[dict[str, Any]]:
    """Parse a Claude projects .jsonl session file (supporting both api-request-shape and plain transcript)."""
    shape_system: list[dict[str, Any]] | None = None
    shape_tools: list[dict[str, Any]] | None = None
    uuid_rows: dict[str, dict[str, Any]] = {}
    ordered_rows: list[dict[str, Any]] = []
    last_main_uuid: str | None = None

    with path.open("rb") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if not isinstance(row, dict):
                continue
            rtype = row.get("type")
            if isinstance(row.get("cwd"), str):
                tracker.record_probe(session_tag, row["cwd"])
            if rtype == "api-request-shape" and shape_system is None and isinstance(row.get("shape"), dict):
                sh = row["shape"]
                if isinstance(sh.get("system"), list) and sh["system"]:
                    shape_system = sh["system"]
                if isinstance(sh.get("tools"), list) and sh["tools"]:
                    shape_tools = sh["tools"]
            elif rtype in ("user", "assistant"):
                if row.get("isSidechain"):
                    continue
                uid = row.get("uuid")
                if isinstance(uid, str) and uid:
                    uuid_rows[uid] = row
                    last_main_uuid = uid
                ordered_rows.append(row)

    # Walk parentUuid chain if present and substantial; otherwise use linear order.
    selected_rows: list[dict[str, Any]]
    if last_main_uuid and uuid_rows:
        chain: list[dict[str, Any]] = []
        cur: str | None = last_main_uuid
        seen: set[str] = set()
        while cur and cur in uuid_rows and cur not in seen:
            seen.add(cur)
            chain.append(uuid_rows[cur])
            parent = uuid_rows[cur].get("parentUuid")
            cur = parent if isinstance(parent, str) else None
        chain.reverse()
        selected_rows = chain if len(chain) >= max(3, len(ordered_rows) // 4) else ordered_rows
    else:
        selected_rows = ordered_rows

    raw_turns: list[dict[str, Any]] = []
    last_asst_mid: str | None = None

    for row in selected_rows:
        rtype = row.get("type")
        msg = row.get("message")
        if not isinstance(msg, dict):
            continue
        if rtype == "user":
            last_asst_mid = None
            content = msg.get("content")
            blocks: list[dict[str, Any]] = []
            if isinstance(content, str):
                if content.strip():
                    blocks.append({"type": "text", "text": content})
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, str) and item.strip():
                        blocks.append({"type": "text", "text": item})
                    elif isinstance(item, dict):
                        btype = item.get("type")
                        if btype == "text" and isinstance(item.get("text"), str) and item["text"].strip():
                            blocks.append({"type": "text", "text": item["text"]})
                        elif btype == "tool_result" and item.get("tool_use_id"):
                            blocks.append(
                                {
                                    "type": "tool_result",
                                    "raw_tool_use_id": str(item["tool_use_id"]),
                                    "raw_content": item.get("content"),
                                    "is_error": bool(item.get("is_error")),
                                }
                            )
                        elif btype == "image":
                            mime = str((item.get("source") or {}).get("media_type") or "image/png")
                            blocks.append({"type": "text", "text": f"image:{mime}"})
            if blocks:
                raw_turns.append({"role": "user", "blocks": blocks})

        elif rtype == "assistant":
            raw_model = msg.get("model")
            if raw_model == "<synthetic>" or row.get("isApiErrorMessage"):
                continue
            content = msg.get("content")
            blocks = []
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    btype = item.get("type")
                    if btype == "thinking" and isinstance(item.get("thinking"), str) and item["thinking"].strip():
                        blocks.append(
                            {
                                "type": "thinking",
                                "thinking": item["thinking"],
                                "signature": item.get("signature") if isinstance(item.get("signature"), str) else None,
                            }
                        )
                    elif btype == "text" and isinstance(item.get("text"), str) and item["text"].strip():
                        blocks.append({"type": "text", "text": item["text"]})
                    elif btype == "tool_use" and item.get("id") and item.get("name"):
                        blocks.append(
                            {
                                "type": "tool_use",
                                "raw_id": str(item["id"]),
                                "raw_name": str(item["name"]),
                                "raw_input": item.get("input"),
                            }
                        )
            elif isinstance(content, str) and content.strip():
                blocks.append({"type": "text", "text": content})
            if not blocks:
                continue
            mid = msg.get("id")
            usage = parse_usage_dict(msg.get("usage"), is_omp=False)
            if mid and mid == last_asst_mid and raw_turns and raw_turns[-1]["role"] == "assistant":
                raw_turns[-1]["blocks"].extend(blocks)
                if usage:
                    raw_turns[-1]["usage"] = usage
            else:
                raw_turns.append(
                    {
                        "role": "assistant",
                        "blocks": blocks,
                        "usage": usage,
                        "model": raw_model,
                    }
                )
                last_asst_mid = mid if isinstance(mid, str) else None

    if len(raw_turns) < 3:
        return []

    tool_names: dict[str, str] = {}
    canonical = canonicalize_turns(raw_turns, session_salt, tracker, session_tag, tool_names)
    if len(canonical) < 3:
        return []

    # Redact system blocks (preserving exact UTF-8 byte lengths).
    redacted_system: list[dict[str, Any]] | None = None
    if shape_system:
        sys_blocks: list[dict[str, Any]] = []
        for sidx, sblk in enumerate(shape_system):
            if isinstance(sblk, dict) and isinstance(sblk.get("text"), str) and sblk["text"].strip():
                sys_blocks.append(
                    {
                        "type": "text",
                        "text": tracker.mask_str(sblk["text"], f"{session_salt}/sys/{sidx}", session_tag),
                    }
                )
            elif isinstance(sblk, str) and sblk.strip():
                sys_blocks.append(
                    {
                        "type": "text",
                        "text": tracker.mask_str(sblk, f"{session_salt}/sys/{sidx}", session_tag),
                    }
                )
        if sys_blocks:
            redacted_system = sys_blocks

    # Redact tools from api-request-shape, keeping mapped names consistent with messages.
    redacted_tools_by_name: dict[str, dict[str, Any]] = {}
    if shape_tools:
        for tidx, tdef in enumerate(shape_tools):
            if not isinstance(tdef, dict) or not isinstance(tdef.get("name"), str) or not tdef["name"]:
                continue
            raw_tname = tdef["name"]
            tracker.record_probe(session_tag, raw_tname)
            mapped_name = tool_names.setdefault(raw_tname, f"fixture_{len(tool_names)}")
            if mapped_name in redacted_tools_by_name:
                continue
            t_out: dict[str, Any] = {"name": mapped_name}
            if isinstance(tdef.get("description"), str) and tdef["description"]:
                t_out["description"] = tracker.mask_str(
                    tdef["description"], f"{session_salt}/tool/{tidx}/desc", session_tag
                )
            t_out["input_schema"] = tracker.mask_schema(
                tdef.get("input_schema"), f"{session_salt}/tool/{tidx}/schema", session_tag
            )
            redacted_tools_by_name[mapped_name] = t_out

    # Ensure every tool_use name present in canonical messages is declared in tools.
    for mapped in tool_names.values():
        if mapped not in redacted_tools_by_name:
            redacted_tools_by_name[mapped] = {"name": mapped, "input_schema": {"type": "object"}}

    models = [m["model"] for m in canonical if m["role"] == "assistant" and m.get("model")]
    model = normalize_model(models[-1] if models else None)
    return [
        {
            "source": "claude",
            "session_tag": session_tag,
            "session_salt": session_salt,
            "model": model,
            "system": redacted_system,
            "tools": list(redacted_tools_by_name.values()),
            "messages": canonical,
        }
    ]


def strip_cache_control_from_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for msg in messages:
        new_blocks: list[dict[str, Any]] = []
        for blk in msg["content"]:
            if "cache_control" in blk:
                nb = dict(blk)
                nb.pop("cache_control", None)
                new_blocks.append(nb)
            else:
                new_blocks.append(blk)
        cleaned.append({"role": msg["role"], "content": new_blocks})
    return cleaned


def set_last_non_thinking_cache_control(msg: dict[str, Any]) -> bool:
    for idx in range(len(msg["content"]) - 1, -1, -1):
        blk = msg["content"][idx]
        if blk.get("type") not in ("thinking", "redacted_thinking"):
            blk = dict(blk)
            blk["cache_control"] = {"type": "ephemeral"}
            msg["content"][idx] = blk
            return True
    return False


def cap_tools_for_budget(
    tools: list[dict[str, Any]] | None,
    used_tool_names: set[str],
    max_tools_bytes: int,
) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    # Always keep tools actually referenced by messages first, then add remaining real tool schemas
    # up to max_tools_bytes so multi-turn messages remain the primary context payload.
    required = [t for t in tools if t["name"] in used_tool_names]
    optional = [t for t in tools if t["name"] not in used_tool_names]
    kept = list(required)
    cur_bytes = len(compact_json_bytes(kept)) if kept else 2
    for tool in optional:
        t_bytes = len(compact_json_bytes(tool)) + 1
        if cur_bytes + t_bytes > max_tools_bytes:
            break
        kept.append(tool)
        cur_bytes += t_bytes
    return kept or None


def build_request_body(
    model: str,
    system: list[dict[str, Any]] | None,
    tools: list[dict[str, Any]] | None,
    prefix_messages: list[dict[str, Any]],
    max_bytes: int,
) -> dict[str, Any]:
    msgs = strip_cache_control_from_messages(prefix_messages)
    used_tools: set[str] = set()
    has_thinking = False
    for msg in msgs:
        for blk in msg["content"]:
            btype = blk.get("type")
            if btype == "tool_use":
                used_tools.add(blk["name"])
            elif btype == "thinking":
                has_thinking = True

    body: dict[str, Any] = {
        "model": model,
        "max_tokens": 4096,
        "stream": True,
    }
    thinking_cfg = thinking_config_for_model(model, has_thinking)
    if thinking_cfg is not None:
        body["thinking"] = thinking_cfg

    breakpoints = 0
    if system:
        sys_copy = [dict(b) for b in system]
        sys_copy[-1]["cache_control"] = {"type": "ephemeral"}
        breakpoints += 1
        body["system"] = sys_copy

    capped_tools = cap_tools_for_budget(tools, used_tools, max_tools_bytes=int(max_bytes * 0.55))
    if capped_tools:
        tools_copy = [dict(t) for t in capped_tools]
        if breakpoints < 4:
            tools_copy[-1]["cache_control"] = {"type": "ephemeral"}
            breakpoints += 1
        body["tools"] = tools_copy

    # Place up to 2 sliding cache_control breakpoints on recent user turns (total <= 4).
    if len(msgs) >= 3 and breakpoints < 3:
        if set_last_non_thinking_cache_control(msgs[-3]):
            breakpoints += 1
    if msgs and breakpoints < 4:
        if set_last_non_thinking_cache_control(msgs[-1]):
            breakpoints += 1

    body["messages"] = msgs
    return body


def compute_expected_usage(
    body_bytes: int,
    prev_body_bytes: int | None,
    raw_usage: dict[str, int] | None,
    next_asst_bytes: int,
) -> tuple[int, dict[str, int]]:
    est_tokens = max(1, round(body_bytes / 4))
    if raw_usage:
        raw_prompt = (
            raw_usage["input_tokens"]
            + raw_usage["cache_read_input_tokens"]
            + raw_usage["cache_creation_input_tokens"]
        )
        raw_out = raw_usage["output_tokens"]
        out_tokens = raw_out if 16 <= raw_out <= 16384 else max(64, min(4096, round(next_asst_bytes / 4)))
        # Use real recorded prompt usage directly when consistent with ~3.2-4.8 bytes/token.
        if (body_bytes / 4.8) <= raw_prompt <= (body_bytes / 3.2) and raw_out > 0:
            return raw_prompt, {
                "input_tokens": raw_usage["input_tokens"],
                "output_tokens": out_tokens,
                "cache_read_input_tokens": raw_usage["cache_read_input_tokens"],
                "cache_creation_input_tokens": raw_usage["cache_creation_input_tokens"],
            }
        # Otherwise preserve the real session's cache hit/write proportions scaled to est_tokens.
        if raw_prompt > 0:
            scale = est_tokens / raw_prompt
            cache_read = int(round(raw_usage["cache_read_input_tokens"] * scale))
            cache_create = int(round(raw_usage["cache_creation_input_tokens"] * scale))
            if cache_read + cache_create >= est_tokens:
                excess = (cache_read + cache_create) - (est_tokens - 1)
                if cache_create >= excess:
                    cache_create -= excess
                else:
                    cache_read = max(0, cache_read - (excess - cache_create))
                    cache_create = 0
            inp = max(1, est_tokens - cache_read - cache_create)
            return est_tokens, {
                "input_tokens": inp,
                "output_tokens": out_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_create,
            }
    else:
        out_tokens = max(64, min(4096, round(next_asst_bytes / 4)))

    if prev_body_bytes is None:
        cache_create = max(0, int(est_tokens * 0.85))
        cache_read = 0
        inp = max(1, est_tokens - cache_create)
    else:
        prev_tokens = max(1, round(prev_body_bytes / 4))
        cache_read = min(int(est_tokens * 0.94), int(prev_tokens * 0.95))
        delta = max(0, est_tokens - cache_read)
        cache_create = int(delta * 0.70)
        inp = max(1, est_tokens - cache_read - cache_create)

    return est_tokens, {
        "input_tokens": inp,
        "output_tokens": out_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_create,
    }


def extract_window_candidates(
    segment: dict[str, Any],
    min_bytes: int,
    max_bytes: int,
    max_turns_per_session: int,
    rng: random.Random,
) -> list[dict[str, Any]]:
    """Extract consecutive multi-turn Anthropic request prefixes landing inside [min_bytes, max_bytes].

    When a session grows beyond max_bytes, truncates naturally on real odd-length turn boundaries
    messages[:2*k+1] so user/assistant alternation and tool_use -> tool_result pairing stay 100% legal.
    """
    messages = segment["messages"]
    if len(messages) < 1:
        return []

    model = segment["model"]
    system = segment["system"]
    tools = segment["tools"]

    # Fast approximate byte lengths per message to quickly locate the [min_bytes, max_bytes] band.
    base_approx = (
        (len(compact_json_bytes(system)) if system else 0)
        + (min(len(compact_json_bytes(tools)), int(max_bytes * 0.55)) if tools else 0)
        + 256
    )
    msg_lens = [len(compact_json_bytes({"role": m["role"], "content": m["content"]})) + 1 for m in messages]

    in_band: list[tuple[int, dict[str, Any], int]] = []
    cum = base_approx

    for end_idx in range(0, len(messages), 2):
        # Prefix is messages[0 : end_idx + 1] (always ends on role == "user").
        if end_idx == 0:
            cum += msg_lens[0]
        else:
            cum += msg_lens[end_idx - 1] + msg_lens[end_idx]

        # Skip prefixes clearly below the band (with generous margin for cache_control/tools overhead).
        if cum < int(min_bytes * 0.85):
            continue
        # Stop once clearly past max_bytes (strict turn-boundary truncation).
        if cum > int(max_bytes * 1.25):
            break

        prefix = messages[: end_idx + 1]
        body = build_request_body(model, system, tools, prefix, max_bytes)
        b_bytes = len(compact_json_bytes(body))

        if b_bytes < min_bytes:
            continue
        if b_bytes > max_bytes:
            break

        in_band.append((end_idx, body, b_bytes))

    if not in_band:
        return []

    # When a session has more in-band turns than max_turns_per_session, pick a deterministic
    # contiguous slice so corpus byte lengths span [min_bytes, max_bytes] evenly while preserving
    # strict multi-turn prefix continuity.
    if len(in_band) > max_turns_per_session:
        start = rng.randint(0, len(in_band) - max_turns_per_session)
        selected = in_band[start : start + max_turns_per_session]
    else:
        selected = in_band

    candidates: list[dict[str, Any]] = []
    prev_body_bytes: int | None = None
    for end_idx, body, b_bytes in selected:
        next_asst = messages[end_idx + 1] if end_idx + 1 < len(messages) else None
        raw_usage = next_asst.get("usage") if next_asst else None
        next_asst_bytes = msg_lens[end_idx + 1] if end_idx + 1 < len(messages) else 1024
        approx_tokens, expected_usage = compute_expected_usage(b_bytes, prev_body_bytes, raw_usage, next_asst_bytes)
        prev_body_bytes = b_bytes
        candidates.append(
            {
                "source": segment["source"],
                "session_tag": segment["session_tag"],
                "turn_index": (end_idx // 2) + 1,
                "approx_tokens": approx_tokens,
                "body_bytes": b_bytes,
                "model": model,
                "stream": True,
                "body": body,
                "expected_usage": expected_usage,
            }
        )

    return candidates


def discover_jsonl_files(root: Path | None, min_file_bytes: int) -> list[Path]:
    if root is None or not root.exists():
        return []
    files: list[Path] = []
    for p in root.rglob("*.jsonl"):
        try:
            if p.is_file() and p.stat().st_size >= min_file_bytes:
                files.append(p)
        except OSError:
            continue
    files.sort(key=lambda p: p.relative_to(root).as_posix())
    return files


def collect_source_chains(
    source: str,
    root: Path | None,
    min_bytes: int,
    max_bytes: int,
    target_records: int,
    max_turns_per_session: int,
    rng: random.Random,
    tracker: RedactionTracker,
) -> list[list[dict[str, Any]]]:
    """Lazily scan shuffled source files until we have enough multi-turn chains to fill target_records."""
    if root is None or not root.exists() or target_records <= 0:
        return []
    # A valid session yielding >= min_bytes JSON body needs at least ~min_bytes/2 raw jsonl bytes.
    files = discover_jsonl_files(root, min_file_bytes=max(256, min_bytes // 2))
    if not files:
        return []

    rng.shuffle(files)
    chains: list[list[dict[str, Any]]] = []
    total_records = 0
    # Aim to collect slight headroom so multi-turn chains can be prioritized cleanly.
    desired_records = max(target_records + max_turns_per_session * 4, int(target_records * 1.25))

    for fpath in files:
        rel = fpath.relative_to(root).as_posix()
        session_salt = hashlib.sha256(f"{source}:{rel}".encode("utf-8")).hexdigest()[:16]
        session_tag = f"{source}:{session_salt}"
        try:
            if source == "omp":
                segments = parse_omp_file(fpath, session_salt, tracker, session_tag)
            else:
                segments = parse_claude_file(fpath, session_salt, tracker, session_tag)
        except Exception:
            continue

        best_chain: list[dict[str, Any]] = []
        for seg in segments:
            cand = extract_window_candidates(seg, min_bytes, max_bytes, max_turns_per_session, rng)
            if len(cand) > len(best_chain):
                best_chain = cand
            if len(best_chain) >= max_turns_per_session:
                break

        if best_chain:
            chains.append(best_chain)
            total_records += len(best_chain)
            if total_records >= desired_records and len(chains) >= max(1, target_records // max_turns_per_session):
                break

    return chains


def select_balanced_records(
    omp_chains: list[list[dict[str, Any]]],
    claude_chains: list[list[dict[str, Any]]],
    target_count: int,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Select up to target_count records balanced across OMP and Claude, preserving multi-turn chains."""
    # Prefer multi-turn chains (>= 2 turns) before single-turn chains while preserving deterministic order.
    omp_sorted = sorted(omp_chains, key=lambda c: (0 if len(c) >= 2 else 1, -len(c)))
    claude_sorted = sorted(claude_chains, key=lambda c: (0 if len(c) >= 2 else 1, -len(c)))

    omp_avail = sum(len(c) for c in omp_sorted)
    claude_avail = sum(len(c) for c in claude_sorted)

    if omp_avail and claude_avail:
        half = target_count // 2
        omp_quota = min(omp_avail, half)
        claude_quota = min(claude_avail, target_count - omp_quota)
        rem = target_count - (omp_quota + claude_quota)
        if rem > 0:
            extra_omp = min(omp_avail - omp_quota, rem)
            omp_quota += extra_omp
            rem -= extra_omp
        if rem > 0:
            extra_claude = min(claude_avail - claude_quota, rem)
            claude_quota += extra_claude
    elif omp_avail:
        omp_quota = min(omp_avail, target_count)
        claude_quota = 0
    else:
        omp_quota = 0
        claude_quota = min(claude_avail, target_count)

    def take_chains(chains: list[list[dict[str, Any]]], quota: int) -> list[list[dict[str, Any]]]:
        picked: list[list[dict[str, Any]]] = []
        used = 0
        for chain in chains:
            if used >= quota:
                break
            take = chain[: quota - used]
            if take:
                picked.append(take)
                used += len(take)
        return picked

    selected_chains = take_chains(claude_sorted, claude_quota) + take_chains(omp_sorted, omp_quota)
    records: list[dict[str, Any]] = []
    source_counts = {"omp": 0, "claude": 0}
    rec_num = 0
    for sess_idx, chain in enumerate(selected_chains, start=1):
        sess_key = f"sess-{sess_idx:03d}"
        for local_turn, item in enumerate(chain, start=1):
            rec_num += 1
            src = item["source"]
            source_counts[src] = source_counts.get(src, 0) + 1
            records.append(
                {
                    "_session_tag": item["session_tag"],
                    "_source": src,
                    "id": f"rec-{rec_num:04d}",
                    "session_key": sess_key,
                    "turn_index": local_turn,
                    "approx_tokens": item["approx_tokens"],
                    "body_bytes": item["body_bytes"],
                    "model": item["model"],
                    "stream": True,
                    "body": item["body"],
                    "expected_usage": item["expected_usage"],
                }
            )
    return records, source_counts


def percentile(sorted_vals: list[int], pct: float) -> int:
    if not sorted_vals:
        return 0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    rank = (pct / 100.0) * (len(sorted_vals) - 1)
    lo = math.floor(rank)
    hi = math.ceil(rank)
    if lo == hi:
        return sorted_vals[lo]
    return round(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (rank - lo))


def numeric_stats(values: list[int]) -> dict[str, int | float]:
    if not values:
        return {"min": 0, "p50": 0, "p95": 0, "max": 0, "mean": 0}
    s = sorted(values)
    return {
        "min": s[0],
        "p50": percentile(s, 50),
        "p95": percentile(s, 95),
        "max": s[-1],
        "mean": round(sum(s) / len(s), 2),
    }


def _check_masked_leaf_values(val: Any) -> int:
    """Count any string leaf inside redacted tool_use.input that is NOT strict lowercase hex."""
    if isinstance(val, str):
        return 0 if HEX_ONLY_RE.match(val) else 1
    if isinstance(val, list):
        return sum(_check_masked_leaf_values(x) for x in val)
    if isinstance(val, dict):
        bad = 0
        for k, v in val.items():
            if not isinstance(k, str) or not k.startswith("field_"):
                bad += 1
            bad += _check_masked_leaf_values(v)
        return bad
    return 0


def audit_corpus(
    records: list[dict[str, Any]],
    corpus_text: str,
    selected_tags: set[str],
    tracker: RedactionTracker,
    min_bytes: int,
    max_bytes: int,
) -> dict[str, Any]:
    """Verify zero plaintext leakage, exact UTF-8 byte-length preservation, and Anthropic validity."""
    probes: list[str] = []
    seen_probes: set[str] = set()
    for tag in sorted(selected_tags):
        for p in tracker.probes_by_session.get(tag, []):
            if p not in seen_probes:
                seen_probes.add(p)
                probes.append(p)

    leaks_found = 0
    for probe in probes:
        if probe in corpus_text:
            leaks_found += 1

    size_violations = 0
    role_violations = 0
    tool_pair_violations = 0
    cache_control_violations = 0
    non_hex_leaf_violations = 0

    for rec in records:
        body = rec["body"]
        actual_bytes = len(compact_json_bytes(body))
        if actual_bytes != rec["body_bytes"] or not (min_bytes <= actual_bytes <= max_bytes):
            size_violations += 1

        # Count cache_control breakpoints across system, tools, messages.
        cc_count = 0
        declared_tools: set[str] = set()
        for t in body.get("tools") or []:
            declared_tools.add(t["name"])
            if "cache_control" in t:
                cc_count += 1
            if isinstance(t.get("description"), str) and not HEX_ONLY_RE.match(t["description"]):
                non_hex_leaf_violations += 1
        for sb in body.get("system") or []:
            if "cache_control" in sb:
                cc_count += 1
            if not isinstance(sb.get("text"), str) or not sb["text"] or not HEX_ONLY_RE.match(sb["text"]):
                non_hex_leaf_violations += 1

        msgs = body.get("messages") or []
        if not msgs or msgs[0].get("role") != "user" or msgs[-1].get("role") != "user":
            role_violations += 1

        prev_role: str | None = None
        pending_tool_ids: list[str] = []
        for midx, msg in enumerate(msgs):
            role = msg.get("role")
            if role not in ("user", "assistant") or role == prev_role:
                role_violations += 1
            prev_role = role

            content = msg.get("content")
            if not isinstance(content, list) or not content:
                role_violations += 1
                continue

            if role == "assistant":
                if pending_tool_ids:
                    tool_pair_violations += len(pending_tool_ids)
                    pending_tool_ids = []
                for blk in content:
                    btype = blk.get("type")
                    if "cache_control" in blk:
                        if btype in ("thinking", "redacted_thinking"):
                            cache_control_violations += 1
                        else:
                            cc_count += 1
                    if btype == "thinking":
                        if not blk.get("thinking") or not HEX_ONLY_RE.match(blk["thinking"]):
                            non_hex_leaf_violations += 1
                        if not blk.get("signature") or not HEX_ONLY_RE.match(blk["signature"]):
                            non_hex_leaf_violations += 1
                    elif btype == "text":
                        if not blk.get("text") or not HEX_ONLY_RE.match(blk["text"]):
                            non_hex_leaf_violations += 1
                    elif btype == "tool_use":
                        pending_tool_ids.append(blk["id"])
                        if declared_tools and blk["name"] not in declared_tools:
                            tool_pair_violations += 1
                        non_hex_leaf_violations += _check_masked_leaf_values(blk.get("input"))
            else:
                found_results: list[str] = []
                for blk in content:
                    btype = blk.get("type")
                    if "cache_control" in blk:
                        cc_count += 1
                    if btype == "text":
                        if not blk.get("text") or not HEX_ONLY_RE.match(blk["text"]):
                            non_hex_leaf_violations += 1
                    elif btype == "tool_result":
                        found_results.append(blk["tool_use_id"])
                        rc = blk.get("content")
                        if isinstance(rc, str):
                            if not HEX_ONLY_RE.match(rc):
                                non_hex_leaf_violations += 1
                        elif isinstance(rc, list):
                            for sub in rc:
                                if not isinstance(sub.get("text"), str) or not HEX_ONLY_RE.match(sub["text"]):
                                    non_hex_leaf_violations += 1
                if midx == 0 and found_results:
                    tool_pair_violations += len(found_results)
                elif midx > 0:
                    if set(found_results) != set(pending_tool_ids) or len(found_results) != len(pending_tool_ids):
                        tool_pair_violations += 1
                pending_tool_ids = []

        if pending_tool_ids:
            tool_pair_violations += len(pending_tool_ids)
        if cc_count < 1 or cc_count > 4:
            cache_control_violations += 1

    ok = (
        leaks_found == 0
        and tracker.byte_length_mismatches == 0
        and size_violations == 0
        and role_violations == 0
        and tool_pair_violations == 0
        and cache_control_violations == 0
        and non_hex_leaf_violations == 0
    )
    return {
        "verified": True,
        "status": "pass" if ok else "fail",
        "probes_checked": len(probes),
        "leaks_found": leaks_found,
        "byte_length_checked": tracker.byte_length_checked,
        "byte_length_mismatches": tracker.byte_length_mismatches,
        "size_violations": size_violations,
        "role_alternation_violations": role_violations,
        "tool_pair_violations": tool_pair_violations,
        "cache_control_violations": cache_control_violations,
        "non_hex_leaf_violations": non_hex_leaf_violations,
    }


def structure_stats(records: list[dict[str, Any]]) -> dict[str, int]:
    with_system = 0
    with_tools = 0
    with_thinking = 0
    with_tool_pairs = 0
    with_cache_control = 0
    for rec in records:
        body = rec["body"]
        if body.get("system"):
            with_system += 1
        if body.get("tools"):
            with_tools += 1
        has_th = False
        has_tu = False
        has_cc = any("cache_control" in b for b in (body.get("system") or [])) or any(
            "cache_control" in t for t in (body.get("tools") or [])
        )
        for msg in body.get("messages") or []:
            for blk in msg.get("content") or []:
                if blk.get("type") == "thinking":
                    has_th = True
                elif blk.get("type") == "tool_use":
                    has_tu = True
                if "cache_control" in blk:
                    has_cc = True
        if has_th:
            with_thinking += 1
        if has_tu:
            with_tool_pairs += 1
        if has_cc:
            with_cache_control += 1
    return {
        "with_system": with_system,
        "with_tools": with_tools,
        "with_thinking": with_thinking,
        "with_tool_pairs": with_tool_pairs,
        "with_cache_control": with_cache_control,
    }


def compile_corpus(args: argparse.Namespace) -> dict[str, Any]:
    if args.min_bytes <= 0 or args.max_bytes < args.min_bytes:
        raise ValueError(f"invalid byte range: [{args.min_bytes}, {args.max_bytes}]")
    if args.target_count <= 0:
        raise ValueError("--target-count must be positive")

    tracker = RedactionTracker()
    # Derive independent RNG streams per source so presence/size of one source does not perturb the other.
    omp_rng = random.Random(args.seed ^ 0x5F3759DF)
    claude_rng = random.Random(args.seed ^ 0x9E3779B9)

    max_turns_per_session = 5
    omp_chains = collect_source_chains(
        "omp",
        args.omp_dir,
        args.min_bytes,
        args.max_bytes,
        args.target_count,
        max_turns_per_session,
        omp_rng,
        tracker,
    )
    claude_chains = collect_source_chains(
        "claude",
        args.claude_dir,
        args.min_bytes,
        args.max_bytes,
        args.target_count,
        max_turns_per_session,
        claude_rng,
        tracker,
    )

    records_with_meta, source_counts = select_balanced_records(omp_chains, claude_chains, args.target_count)
    if not records_with_meta:
        raise RuntimeError(
            f"no records found in [{args.min_bytes}, {args.max_bytes}] bytes from "
            f"omp_dir={args.omp_dir} and claude_dir={args.claude_dir}"
        )

    selected_tags = {r["_session_tag"] for r in records_with_meta}
    clean_records: list[dict[str, Any]] = []
    for rec in records_with_meta:
        clean_records.append(
            {
                "id": rec["id"],
                "session_key": rec["session_key"],
                "turn_index": rec["turn_index"],
                "approx_tokens": rec["approx_tokens"],
                "body_bytes": rec["body_bytes"],
                "model": rec["model"],
                "stream": rec["stream"],
                "body": rec["body"],
                "expected_usage": rec["expected_usage"],
            }
        )

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    corpus_path = out_dir / "corpus-100k.jsonl"
    manifest_path = out_dir / "manifest.json"

    lines = [compact_json_str(rec) for rec in clean_records]
    corpus_text = "\n".join(lines) + "\n"
    corpus_bytes = corpus_text.encode("utf-8")
    corpus_sha256 = hashlib.sha256(corpus_bytes).hexdigest()
    corpus_path.write_bytes(corpus_bytes)

    if args.verify_redaction:
        redaction_audit = audit_corpus(clean_records, corpus_text, selected_tags, tracker, args.min_bytes, args.max_bytes)
    else:
        redaction_audit = {
            "verified": False,
            "status": "skipped",
            "probes_checked": 0,
            "leaks_found": 0,
            "byte_length_checked": tracker.byte_length_checked,
            "byte_length_mismatches": tracker.byte_length_mismatches,
        }

    session_turn_counts: dict[str, int] = {}
    model_counts: dict[str, int] = {}
    for rec in clean_records:
        sk = rec["session_key"]
        session_turn_counts[sk] = session_turn_counts.get(sk, 0) + 1
        mdl = rec["model"]
        model_counts[mdl] = model_counts.get(mdl, 0) + 1

    manifest = {
        "corpus_file": corpus_path.name,
        "corpus_sha256": corpus_sha256,
        "seed": args.seed,
        "min_bytes": args.min_bytes,
        "max_bytes": args.max_bytes,
        "target_count": args.target_count,
        "count": len(clean_records),
        "unique_sessions": len(session_turn_counts),
        "multi_turn_sessions": sum(1 for c in session_turn_counts.values() if c >= 2),
        "source_counts": source_counts,
        "model_counts": dict(sorted(model_counts.items())),
        "body_bytes_stats": numeric_stats([r["body_bytes"] for r in clean_records]),
        "approx_tokens_stats": numeric_stats([r["approx_tokens"] for r in clean_records]),
        "structure_stats": structure_stats(clean_records),
        "redaction_audit": redaction_audit,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if args.verify_redaction and redaction_audit["status"] != "pass":
        raise RuntimeError(f"redaction audit failed: {json.dumps(redaction_audit)}")

    return manifest


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compile real OMP and Claude sessions into a redacted, byte-length-preserving 100K-context corpus."
    )
    parser.add_argument("--omp-dir", type=Path, default=DEFAULT_OMP_DIR, help="OMP sessions root directory")
    parser.add_argument("--claude-dir", type=Path, default=DEFAULT_CLAUDE_DIR, help="Claude projects root directory")
    parser.add_argument(
        "--out-dir",
        type=Path,
        required=True,
        help="Output directory for corpus-100k.jsonl and manifest.json",
    )
    parser.add_argument("--min-bytes", type=int, default=350000, help="Minimum serialized request body bytes")
    parser.add_argument("--max-bytes", type=int, default=450000, help="Maximum serialized request body bytes")
    parser.add_argument("--target-count", type=int, default=120, help="Target number of corpus records")
    parser.add_argument("--seed", type=int, default=20261128, help="Deterministic RNG seed")
    parser.add_argument(
        "--verify-redaction",
        action="store_true",
        help="Run zero-leakage probe scan, byte-length check, and Anthropic protocol audit",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    manifest = compile_corpus(args)
    print(
        json.dumps(
            {
                "out_dir": str(args.out_dir),
                "corpus_sha256": manifest["corpus_sha256"],
                "count": manifest["count"],
                "unique_sessions": manifest["unique_sessions"],
                "source_counts": manifest["source_counts"],
                "body_bytes_stats": manifest["body_bytes_stats"],
                "approx_tokens_stats": manifest["approx_tokens_stats"],
                "redaction_audit": manifest["redaction_audit"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
