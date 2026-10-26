#!/usr/bin/env python3
"""Searches a process's environment, command line and every readable memory region for strings read from stdin,
one `label=text` per line, and prints which it found. A parent may read its child's memory under Yama scope 1."""
import re
import sys

pid = sys.argv[1]
needles = [line.rstrip("\n").split("=", 1) for line in sys.stdin if "=" in line]
found = {label: [] for label, _ in needles}
for name in ("environ", "cmdline"):
    with open(f"/proc/{pid}/{name}", "rb") as f:
        data = f.read()
    for label, text in needles:
        if text.encode() in data:
            found[label].append(name)
regions = scanned = 0
with open(f"/proc/{pid}/maps") as maps, open(f"/proc/{pid}/mem", "rb", 0) as mem:
    for line in maps:
        m = re.match(r"([0-9a-f]+)-([0-9a-f]+) r", line)
        if not m:
            continue
        start, end = int(m.group(1), 16), int(m.group(2), 16)
        try:
            mem.seek(start)
            chunk = mem.read(end - start)
        except (OSError, ValueError, OverflowError):
            continue
        regions += 1
        scanned += len(chunk)
        for label, text in needles:
            for encoded in (text.encode(), text.encode("utf-16-le")):
                if encoded in chunk and "memory" not in found[label]:
                    found[label].append("memory")
print(f"scanned pid {pid}: environ, cmdline and {regions} readable regions, {scanned // (1 << 20)} MiB")
for label, places in found.items():
    print(f"  {label}: {'found in ' + ', '.join(places) if places else 'not found'}")
