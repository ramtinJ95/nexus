#!/usr/bin/env python3
"""S6 host fixture. Invoke only over the home SOCKS SSH route, under scratch."""
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path.home() / "nexus-spikes" / "s6"
PORTS = (8443, 10000, 10001, 10002, 18443, 40000)


def emit(value):
    print(json.dumps(value, sort_keys=True), flush=True)


def command(args):
    start = time.monotonic()
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=30)
        return dict(rc=p.returncode, stdout=p.stdout, stderr=p.stderr,
                    seconds=round(time.monotonic() - start, 6))
    except subprocess.TimeoutExpired:
        return dict(rc=124, stdout="", stderr="Command exceeded 30 s",
                    seconds=round(time.monotonic() - start, 6))


class Gateway(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Strict allowlist: never enumerate or log Tailscale-User-* or peer IPs.
        host = self.headers.get("Host", "")
        emit(dict(request=self.path, host=host,
                  x_forwarded_proto=self.headers.get("X-Forwarded-Proto", "")))
        body = (json.dumps(dict(host=host)) + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def main():
    action = sys.argv[1]
    if action == "gateway":
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 18090), Gateway)
        (ROOT / "ready").write_text("127.0.0.1:18090\n")
        server.serve_forever()
    elif action == "start":
        with (ROOT / "gateway.txt").open("x") as log:
            p = subprocess.Popen([sys.executable, str(ROOT / "s6-host.py"), "gateway"],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True)
        (ROOT / "pid").write_text(str(p.pid))
        for _ in range(100):
            if (ROOT / "ready").exists():
                emit(dict(gateway_ready=True, bind="127.0.0.1:18090"))
                break
            if p.poll() is not None:
                raise RuntimeError("Gateway exited during startup")
            time.sleep(0.05)
        else:
            raise RuntimeError("Gateway not ready within 5 s")
    elif action in ("add", "remove"):
        for value in sys.argv[2:]:
            port = int(value)
            assert port in PORTS
            args = (["tailscale", "serve", "--bg", f"--https={port}",
                     "http://127.0.0.1:18090"] if action == "add" else
                    ["tailscale", "serve", f"--https={port}", "off"])
            emit(dict(action=action, port=port, **command(args)))
    elif action == "versions":
        for args in (["tailscale", "version"], ["python3", "--version"], ["curl", "--version"]):
            emit(dict(command=args, **command(args)))
    elif action == "stop":
        if (ROOT / "pid").exists():
            pid = int((ROOT / "pid").read_text())
            proc = Path(f"/proc/{pid}/cmdline")
            if proc.exists() and proc.read_bytes():
                assert str(ROOT / "s6-host.py").encode() in proc.read_bytes().split(b"\0")
                os.kill(pid, signal.SIGTERM)
                for _ in range(100):
                    if not proc.exists() or not proc.read_bytes():
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Gateway did not stop within 5 s")
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", 18090))
        # Only known S6 files; fail rather than recursively erase unexpected data.
        allowed = {"s6-host.py", "gateway.txt", "pid", "ready"}
        assert not ROOT.is_symlink()
        assert {p.name for p in ROOT.iterdir()} <= allowed
        for path in ROOT.iterdir():
            path.unlink()
        ROOT.rmdir()
        emit(dict(gateway_stopped=True, loopback_port_rebind=True, scratch_deleted=True))
    else:
        raise ValueError("Unknown action")


if __name__ == "__main__":
    main()
