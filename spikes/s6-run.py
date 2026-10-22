#!/usr/bin/env python3
"""Run from the Mac. No work-tailnet CLI; all remote actions use home SOCKS.

Initial status files must already exist (captured before any remote mutation).
Refuses nonempty baseline configs and existing S6 scratch/evidence. Fresh curl
process per request; no retries, certificate bypass, verbose header dumps, or
connection reuse. Three paired cold/warm cycles, with two Mac GETs per port.
"""
import difflib
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time

HERE = Path(__file__).resolve().parent
LOGS = HERE / "evidence" / "logs"
PORTS = (8443, 10000, 10001, 10002, 18443, 40000)
NAME = "infra-testbench.example.ts.net"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o",
       "ProxyCommand=nc -X 5 -x localhost:1055 %h %p", "infra-testbench"]
ENV = ('export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" '
       'PI_SANDBOX_HOME="$HOME/nexus-spikes/state" '
       'npm_config_cache="$HOME/nexus-spikes/npm-cache" '
       'TMPDIR="$HOME/nexus-spikes/tmp"; cd "$HOME/nexus-spikes" && ')
TRANSCRIPT = None
MEASUREMENTS = None


def record(value):
    line = json.dumps(value, sort_keys=True)
    print(line, flush=True)
    TRANSCRIPT.write(line + "\n")
    TRANSCRIPT.flush()


def remote(cmd, data=None, timeout=220):
    p = subprocess.run(SSH + [ENV + cmd], input=data, capture_output=True,
                       text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"SSH command failed ({p.returncode}): {p.stderr}")
    if p.stderr:
        record(dict(ssh_stderr=p.stderr))
    return p.stdout


def host(action, ports=()):
    out = remote(shlex.join(["python3", "s6/s6-host.py", action, *map(str, ports)]))
    rows = [json.loads(line) for line in out.splitlines()]
    for row in rows:
        record(row)
    return rows


def snapshot(phase):
    for suffix, cmd in (("", "tailscale serve status 2>&1"),
                        ("-json", "tailscale serve status --json")):
        data = remote(cmd)
        (LOGS / f"s6-status-{phase}{suffix}.txt").write_text(data)


def fetch(port, round_, mode, origin, attempt):
    tag = f"r{round_}-{mode}-{origin}-{attempt}-{port}"
    args = ["curl", "--max-time", "20", "-sS", "--write-out",
            '\nS6_METRICS %{http_code} %{time_total}\n']
    if origin == "mac":
        args += ["--socks5-hostname", "localhost:1055"]
    args += [f"https://{NAME}:{port}/?probe={tag}"]
    start = time.monotonic()
    if origin == "mac":
        p = subprocess.run(args, capture_output=True, text=True, timeout=25)
        rc, out, err = p.returncode, p.stdout, p.stderr
    else:
        # SSH itself must succeed even when the bounded curl fails.
        result = remote(shlex.join(args) + '; rc=$?; printf "S6_RC %s\\n" "$rc"', timeout=45)
        out, code = result.rsplit("S6_RC ", 1)
        rc, err = int(code.strip()), ""
    body, metrics = out.rsplit("\nS6_METRICS ", 1)
    status, seconds = metrics.strip().split()
    received_host = json.loads(body)["host"] if status == "200" else None
    row = dict(round=round_, mode=mode, origin=origin, attempt=attempt,
               port=port, request=f"/?probe={tag}", http_status=status,
               seconds=float(seconds), timeout=rc == 28, curl_rc=rc,
               received_host=received_host,
               host_matches=received_host == f"{NAME}:{port}", stderr=err,
               wall_seconds=round(time.monotonic() - start, 6))
    record(row)
    MEASUREMENTS.write(json.dumps(row, sort_keys=True) + "\n")
    MEASUREMENTS.flush()
    return row


def main():
    global TRANSCRIPT, MEASUREMENTS
    baseline = {}
    for suffix in ("", "-json"):
        baseline[suffix] = (LOGS / f"s6-status-before{suffix}.txt").read_text()
    # Deliberately narrow fixture: never take ownership of existing Serve entries.
    assert json.loads(baseline["-json"]) == {}, "Nonempty Serve baseline: stop for review"
    assert not (LOGS / "s6-run.txt").exists(), "Evidence exists; do not overwrite"
    with (LOGS / "s6-run.txt").open("x") as transcript, (LOGS / "s6-measurements.txt").open("x") as measurements:
        TRANSCRIPT, MEASUREMENTS = transcript, measurements
        staged, active = False, set()
        try:
            # Check again before mutations, preserving the original snapshots.
            assert json.loads(remote("tailscale serve status --json")) == {}
            source = (HERE / "s6-host.py").read_text()
            remote("mkdir s6 && cat > s6/s6-host.py", data=source)
            staged = True
            digest = remote("sha256sum s6/s6-host.py").split()[0]
            assert digest == hashlib.sha256(source.encode()).hexdigest()
            record(dict(host_source_sha256=digest, utc_started=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
            record(dict(mac_curl_version=subprocess.run(["curl", "--version"], capture_output=True, text=True, check=True).stdout))
            host("versions")
            host("start")
            for round_ in range(1, 4):
                for mode in ("cold", "warm"):
                    record(dict(phase="add", round=round_, mode=mode))
                    # Register ownership before the batch, including uncertain failures.
                    active.update(PORTS)
                    additions = host("add", PORTS)
                    accepted = [row["port"] for row in additions if row["rc"] == 0]
                    active.difference_update(row["port"] for row in additions if row["rc"] not in (0, 124))
                    record(dict(round=round_, mode=mode, accepted=accepted))
                    if mode == "warm":
                        for port in accepted:
                            fetch(port, round_, mode, "host", 0)
                    for port in accepted:
                        for attempt in (1, 2):
                            fetch(port, round_, mode, "mac", attempt)
                    if round_ == 3 and mode == "warm":
                        snapshot("all-active")
                        if 10001 not in accepted:
                            raise RuntimeError("Cannot test independent removal: 10001 refused")
                        assert host("remove", [10001])[0]["rc"] == 0
                        active.remove(10001)
                        snapshot("one-removed")
                        for port in accepted:
                            row = fetch(port, round_, "one-removed", "mac", 1)
                            assert (row["http_status"] == "000" and row["curl_rc"] != 0) if port == 10001 else (row["http_status"] == "200" and row["host_matches"])
                    for row in host("remove", sorted(active)):
                        assert row["rc"] == 0, "Serve removal failed"
                        active.remove(row["port"])
                    assert json.loads(remote("tailscale serve status --json")) == {}
                    record(dict(phase="cycle_restored", round=round_, mode=mode))
        finally:
            # No reset; only ports attempted by this fixture from an empty baseline.
            for port in sorted(active):
                assert host("remove", [port])[0]["rc"] == 0
            if staged:
                gateway = remote("cat s6/gateway.txt")
                (LOGS / "s6-gateway.txt").write_text(gateway)
                host("stop")
            snapshot("final")
            for suffix in ("", "-json"):
                final = (LOGS / f"s6-status-final{suffix}.txt").read_text()
                diff = "".join(difflib.unified_diff(baseline[suffix].splitlines(True), final.splitlines(True), fromfile="before", tofile="final"))
                (LOGS / f"s6-status-diff{suffix}.txt").write_text(diff)
                record(dict(status_format="json" if suffix else "text", diff=diff, identical=not diff))
                assert not diff, "Serve config not restored"


if __name__ == "__main__":
    main()
