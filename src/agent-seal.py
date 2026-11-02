"""Seals the agents' transcripts in this pylon before a settle's final read, or unseals them. Runs as root.

Takes {"claude": dir, "pi": dir, "seal": bool, "user": name} on stdin, the user `user` unless it names another. A seal binds each dir read-only over itself, then stops every
process of the pylon's user that is not this helper's ancestor until none runs, and kills them. A process started
after the mounts cannot write to the dirs, and one started before them, which may hold a file open for writing, is
gone, so no call reaches a transcript after the seal. The mounts are not on the disk, so the pause after the read
drops them. An unseal unmounts them, for a pylon its thread wants running again before that pause.
"""
import json
import os
import pwd
import signal
import subprocess
import sys
import time

state = json.load(sys.stdin)
user = pwd.getpwnam(state.get("user", "user"))
dirs = [state["claude"], state["pi"]]


def mounted(path):
    with open("/proc/self/mountinfo") as f:
        return any(line.split()[4] == path for line in f)


def ancestors():
    pids, pid = set(), os.getpid()
    while pid > 1:
        pids.add(pid)
        with open(f"/proc/{pid}/stat") as f:
            pid = int(f.read().rsplit(")", 1)[1].split()[1])
    return pids


def users_processes(keep):
    found = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) in keep:
            continue
        try:
            with open(f"/proc/{entry}/status") as f:
                fields = dict(line.split(":", 1) for line in f if ":" in line)
        except OSError:
            continue
        if int(fields["Uid"].split()[0]) == user.pw_uid:
            found[int(entry)] = fields["State"].split()[0]
    return found


if not state["seal"]:
    for path in dirs:
        if mounted(path):
            subprocess.run(["umount", path], check=True)
    sys.exit(0)

for path in dirs:
    # A dir that does not exist yet is made as the user, so the mount covers it and no writer can make it.
    subprocess.run(["runuser", "-u", user.pw_name, "--", "mkdir", "-p", path], check=True)
    if not mounted(path):
        subprocess.run(["mount", "--bind", path, path], check=True)
    subprocess.run(["mount", "-o", "remount,bind,ro", path], check=True)

keep = ancestors()
# A stopped process forks nothing, so once a pass finds none running, no process of the user can start another.
for _ in range(200):
    running = [pid for pid, s in users_processes(keep).items() if s not in ("T", "t", "Z", "X")]
    if not running:
        break
    for pid in running:
        try:
            os.kill(pid, signal.SIGSTOP)
        except ProcessLookupError:
            pass
    time.sleep(0.02)
else:
    sys.exit("agent-seal.py: the user's processes kept starting others, so the transcripts are not sealed")
for pid in users_processes(keep):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
print("sealed")
