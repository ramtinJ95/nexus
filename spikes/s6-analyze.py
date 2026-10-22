#!/usr/bin/env python3
"""Validate S6 evidence and print reproducible measurement tables (no network)."""
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics

HERE = Path(__file__).resolve().parent
LOGS = HERE / "evidence" / "logs"
PORTS = (8443, 10000, 10001, 10002, 18443, 40000)
NAME = "infra-testbench.example.ts.net"


def rows(name):
    return [json.loads(line) for line in (LOGS / name).read_text().splitlines()]


def main():
    for name in ("s6-host.py", "s6-run.py", "s6-analyze.py"):
        ast.parse((HERE / name).read_text())
    run = rows("s6-run.txt")
    measures = rows("s6-measurements.txt")
    gateway = rows("s6-gateway.txt")
    assert run[0]["host_source_sha256"] == hashlib.sha256((HERE / "s6-host.py").read_bytes()).hexdigest()
    adds = [r for r in run if r.get("action") == "add"]
    removes = [r for r in run if r.get("action") == "remove"]
    assert len(adds) == len(removes) == 36
    assert all(r["rc"] == 0 for r in adds + removes)
    assert Counter(r["port"] for r in adds) == Counter({p: 6 for p in PORTS})
    assert Counter(r["port"] for r in removes) == Counter({p: 6 for p in PORTS})
    assert len([r for r in run if r.get("phase") == "cycle_restored"]) == 6
    assert len(measures) == 96
    by_request = {r["request"]: r for r in gateway}
    assert len(by_request) == len(gateway) == 95
    assert all(set(r) == {"request", "host", "x_forwarded_proto"} for r in gateway)
    for row in measures:
        if row["mode"] == "one-removed" and row["port"] == 10001:
            assert row["http_status"] == "000" and row["curl_rc"] == 97
            assert row["request"] not in by_request
        else:
            assert row["http_status"] == "200" and row["curl_rc"] == 0 and row["host_matches"]
            assert row["received_host"] == f"{NAME}:{row['port']}"
            event = by_request[row["request"]]
            assert event["host"] == row["received_host"]
            assert event["x_forwarded_proto"] == "https"
        assert not row["timeout"]
    for suffix in ("", "-json"):
        assert (LOGS / f"s6-status-before{suffix}.txt").read_bytes() == (LOGS / f"s6-status-final{suffix}.txt").read_bytes()
        assert (LOGS / f"s6-status-diff{suffix}.txt").stat().st_size == 0
    all_active = json.loads((LOGS / "s6-status-all-active-json.txt").read_text())
    one_removed = json.loads((LOGS / "s6-status-one-removed-json.txt").read_text())
    assert set(all_active["TCP"]) == set(map(str, PORTS))
    for port in PORTS:
        assert all_active["TCP"][str(port)] == {"HTTPS": True}
        assert all_active["Web"][f"{NAME}:{port}"]["Handlers"]["/"] == {"Proxy": "http://127.0.0.1:18090"}
    del all_active["TCP"]["10001"]
    del all_active["Web"][f"{NAME}:10001"]
    assert all_active == one_removed
    assert any(r.get("gateway_stopped") and r.get("scratch_deleted") and r.get("loopback_port_rebind") for r in run)
    for path in LOGS.glob("s6-*.txt"):
        assert "tailscale-user-" not in path.read_text().lower(), path.name
    print("VALIDATION=PASS; syntax=3 scripts; source hash matches host; adds=36/36; removes=36/36")
    print("HTTP_200=95/95 expected successes; gateway_host_matches=95/95; x_forwarded_proto=https 95/95")
    print("Removed 10001: HTTP 000, curl 97, no gateway event; other five remain HTTP 200")
    print("Serve text/JSON diffs: 0 bytes each; gateway stopped; loopback rebind passed; scratch deleted")
    print("Identity header fields absent from all S6 evidence (allowlist at capture)")
    print()
    print("| Round | Port | No warm-up: Mac 1 s | Mac 2 s | Host warm-up s | Warm: Mac 1 s | Mac 2 s | HTTP (all five) | Timeout (all five) |")
    print("|---|---:|---:|---:|---:|---:|---:|---|---|")
    for round_ in range(1, 4):
        for port in PORTS:
            group = [r for r in measures if r["round"] == round_ and r["port"] == port and r["mode"] != "one-removed"]
            assert len(group) == 5
            print(f"| {round_} | {port} | " + " | ".join(f"{r['seconds']:.6f}" for r in group) + " | 200 | No |")
    print()
    for mode in ("cold", "warm"):
        for attempt in (1, 2):
            selected = [r for r in measures if r["mode"] == mode and r["origin"] == "mac" and r["attempt"] == attempt]
            assert len(selected) == 18
            times = [r["seconds"] for r in selected]
            print(f"{mode} Mac {attempt}: n=18, timeout=0, min={min(times):.6f}, median={statistics.median(times):.6f}, max={max(times):.6f} s")
    print()
    print("| Port after removing 10001 | HTTP | Total s | Curl exit | Timeout | Gateway Host correct |")
    print("|---:|---|---:|---:|---|---|")
    for r in measures:
        if r["mode"] == "one-removed":
            print(f"| {r['port']} | {r['http_status']} | {r['seconds']:.6f} | {r['curl_rc']} | No | {'Yes' if r['host_matches'] else 'No request reached gateway'} |")


if __name__ == "__main__":
    main()
