"""Reads the model calls agents in this pylon recorded, from where the last read of each transcript stopped.

Takes {"claude": dir, "pi": dir, "offsets": {path: [offset, before]}, "limit": bytes} on stdin, where `before` is the
SHA-256 of the up to 4 KiB just before the offset. Every *.jsonl under the Claude dir is a Claude Code transcript, a
subagent's included, and every one under the pi dir a pi session. Prints one JSON line per call, then
{"offsets": {...}, "more": bool} with each file read further. A file shorter than its offset, or whose bytes before
it no longer hash to `before`, was replaced, so it is read from the start. Only whole lines are read. Once the calls
printed pass `limit` bytes, the files left keep their offsets and `more` is true.
"""
import hashlib
import json
import os
import sys
from datetime import datetime

state = json.load(sys.stdin)
offsets = state["offsets"]
limit = state["limit"]
calls = {}
moved = {}
printed = 0


def count(value):
    return value if type(value) is int and value >= 0 else 0


def millis(stamp):
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def add(call_id, agent, model, at, tokens):
    global printed
    if not isinstance(call_id, str) or not isinstance(model, str) or model == "<synthetic>" or at is None or sum(tokens) == 0:
        return
    seen = calls.get(call_id)
    if seen is None:
        printed += len(call_id) + len(model) + 120
        calls[call_id] = [agent, model, at, *tokens]
    else:
        seen[3:] = [max(a, b) for a, b in zip(seen[3:], tokens)]


def claude(record):
    message = record.get("message")
    if record.get("type") != "assistant" or not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
        return
    u = message["usage"]
    tokens = [count(u.get(k)) for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
    add(f"claude:{message.get('id')}" if isinstance(message.get("id"), str) else None, "claude", message.get("model"), millis(record.get("timestamp")), tokens)


def pi(record):
    kind = record.get("type")
    message = record.get("message") if kind == "message" else record
    if kind not in ("message", "usage") or not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
        return
    if kind == "message" and message.get("role") != "assistant":
        return
    u = message["usage"]
    tokens = [count(u.get(k)) for k in ("input", "output", "cacheWrite", "cacheRead")]
    # A fork copies entries with their IDs and times into a new session, so an entry's ID and time name its call.
    response = message.get("responseId") if kind == "message" else None
    entry, stamp = record.get("id"), record.get("timestamp")
    call_id = f"pi:{response}" if isinstance(response, str) else f"pi:{entry}@{stamp}" if isinstance(entry, str) and isinstance(stamp, str) else None
    at = message.get("timestamp") if type(message.get("timestamp")) is int else millis(record.get("timestamp"))
    add(call_id, "pi", message.get("model"), at, tokens)


def before(f, offset):
    start = max(0, offset - 4096)
    f.seek(start)
    return hashlib.sha256(f.read(offset - start)).hexdigest()


def read(path, parse):
    size = os.path.getsize(path)
    start, hashed = offsets.get(path, [0, None])
    with open(path, "rb") as f:
        if start > size or (start > 0 and before(f, start) != hashed):
            start = 0
        f.seek(start)
        position = start
        for line in f:
            if not line.endswith(b"\n") or printed > limit:
                break
            position += len(line)
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict):
                parse(record)
        if position != offsets.get(path, [None])[0]:
            moved[path] = [position, before(f, position)]


for root, parse in ((state["claude"], claude), (state["pi"], pi)):
    for directory, _, files in sorted(os.walk(root)):
        for name in sorted(files):
            if name.endswith(".jsonl") and printed <= limit:
                read(os.path.join(directory, name), parse)

out = sys.stdout
for call_id, (agent, model, at, *tokens) in calls.items():
    out.write(json.dumps({"id": call_id, "agent": agent, "model": model, "at": at, "input": tokens[0], "output": tokens[1], "cacheWrite": tokens[2], "cacheRead": tokens[3]}) + "\n")
out.write(json.dumps({"offsets": moved, "more": printed > limit}) + "\n")
