# drive-sandboxd.py <init tail> <smoke check argv as JSON>, as root: boots the real /usr/bin/sandboxd behind the
# given init tail as PID 1 of new PID and mount namespaces, with a pty bound over its virtio port, and drives it
# with Gondolin's exec protocol. Prints one JSON line per result.
import json, os, select, struct, subprocess, sys, time, tty

def enc(v):
    def head(major, n):
        if n < 24: return bytes([major << 5 | n])
        for size, code in ((1, 24), (2, 25), (4, 26), (8, 27)):
            if n < 1 << (8 * size): return bytes([major << 5 | code]) + n.to_bytes(size, "big")
    if isinstance(v, bool): return b"\xf5" if v else b"\xf4"
    if isinstance(v, int): return head(0, v)
    if isinstance(v, bytes): return head(2, len(v)) + v
    if isinstance(v, str): return head(3, len(v.encode())) + v.encode()
    if isinstance(v, list): return head(4, len(v)) + b"".join(map(enc, v))
    return head(5, len(v)) + b"".join(enc(k) + enc(x) for k, x in v.items())

def dec(b, i=0):
    major, n = b[i] >> 5, b[i] & 31
    i += 1
    if major == 7: return {20: False, 21: True, 22: None}.get(n), i
    if n >= 24:
        size = 1 << (n - 24)
        n, i = int.from_bytes(b[i:i + size], "big"), i + size
    if major == 0: return n, i
    if major == 1: return -1 - n, i
    if major in (2, 3): return (b[i:i + n] if major == 2 else b[i:i + n].decode()), i + n
    out = [] if major == 4 else {}
    for _ in range(n):
        if major == 4:
            x, i = dec(b, i); out.append(x)
        else:
            k, i = dec(b, i); x, i = dec(b, i); out[k] = x
    return out, i

master, slave = os.openpty()
tty.setraw(slave)
tail, check = sys.argv[1], json.loads(sys.argv[2])
init = subprocess.Popen(["unshare", "--mount", "--pid", "--fork", "--kill-child", "--mount-proc", "sh", "-c",
    f"mount --bind {os.ttyname(slave)} /dev/virtio-ports/virtio-port && {tail}"], stderr=subprocess.DEVNULL)
buf, next_id = b"", 0

def send(t, id, p):
    frame = enc({"v": 1, "t": t, "id": id, "p": p})
    os.write(master, struct.pack(">I", len(frame)) + frame)

def frames(deadline):
    global buf
    while time.monotonic() < deadline:
        while len(buf) >= 4 and len(buf) >= 4 + struct.unpack(">I", buf[:4])[0]:
            n = struct.unpack(">I", buf[:4])[0]
            msg, buf = dec(buf[4:4 + n])[0], buf[4 + n:]
            yield msg
        if init.poll() is not None: return
        if select.select([master], [], [], 0.1)[0]: buf += os.read(master, 65536)

def run(argv, stdin=None, timeout=15):
    global next_id
    next_id += 1
    id, out = next_id, b""
    send("exec_request", id, {"cmd": argv[0], "argv": argv[1:], "env": ["PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], "stdin": stdin is not None})
    for msg in frames(time.monotonic() + timeout):
        if msg.get("id") != id: continue
        if msg["t"] == "exec_output":
            out += msg["p"]["data"]
            if stdin is not None and b"ready" in out:
                send("stdin_data", id, {"data": stdin}); stdin = None
        if msg["t"] == "exec_response": return {"exitCode": msg["p"]["exit_code"], "output": out.decode()}
    return {"exitCode": None, "output": out.decode(), "pid1": "gone" if init.poll() is not None else "running"}

def report(name, result):
    print(json.dumps({"name": name, **result}), flush=True)

report("smoke check", run(check))
for _ in range(20):
    run(["python3", "-c", "import subprocess,sys; subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)",
         "python3", "-c", "import subprocess; subprocess.run(['cat','/proc/net/tcp'],stdout=subprocess.DEVNULL)"])
run(["setsid", "-f", "sh", "-c", "exit 0"])
report("SIGPIPE in a plain exec and in one started through Python", run(["sh", "-c", "grep SigIgn /proc/self/status; python3 -c 'import subprocess; subprocess.run([\"grep\", \"SigIgn\", \"/proc/self/status\"])'"]))
report("stdin written after the command closed it", run(["sh", "-c", "exec 0<&-; echo ready; sleep 1"], stdin=b"x" * 65536))
report("after 20 guest commands and a detached start", run(["sh", "-c", "sleep 2; echo PID 1 is $(ps -o comm= -p 1); echo zombies: $(ps -eo stat= | grep -c ^Z)"]))
init.kill()
