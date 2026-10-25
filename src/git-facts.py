import json
import os
import signal
import subprocess
import sys


def expired(signum, frame):
    raise TimeoutError("git observation exceeded its deadline")


signal.signal(signal.SIGALRM, expired)
signal.setitimer(signal.ITIMER_REAL, 2.5)
os.environ["GIT_OPTIONAL_LOCKS"] = "0"


def git(*args, allowed=(0,), dirty=False):
    process = subprocess.Popen(
        ["git", "-c", "core.fsmonitor=false", *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    try:
        output = process.stdout.read(1 if dirty else 256 * 1024 + 1)
        if dirty and output:
            return True
        if len(output) > 256 * 1024:
            raise ValueError("git observation exceeds the read limit")
        if process.wait() not in allowed:
            raise ValueError("git observation command failed")
        return False if dirty else output.decode("utf-8").rstrip("\n")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def observe():
    if git("rev-parse", "--is-inside-work-tree") != "true":
        raise ValueError("checkout is not a working tree")
    branch = git("symbolic-ref", "--quiet", "--short", "HEAD", allowed=(0, 1)) or None
    head = git("rev-parse", "--verify", "--quiet", "HEAD", allowed=(0, 1))
    if not head:
        head = git("hash-object", "-t", "tree", "--stdin")
    refs = git("for-each-ref", "--count=1001", "--format=%(refname)%09%(objectname)%09%(upstream)%09%(symref)", "refs/heads/", "refs/remotes/")
    rows = [line.split("\t") for line in refs.splitlines()]
    if len(rows) > 1000:
        raise ValueError("git observation exceeds 1000 refs")
    remotes = git("remote").splitlines()
    published = {row[0] for row in rows if row[0].startswith("refs/remotes/") and not row[3]}
    branches = []
    for ref, commit, upstream, symref in rows:
        if not ref.startswith("refs/heads/"):
            continue
        name = ref.removeprefix("refs/heads/")
        candidates = [f"refs/remotes/{remote}/{name}" for remote in remotes if f"refs/remotes/{remote}/{name}" in published]
        origin = f"refs/remotes/origin/{name}"
        pushed = upstream if upstream in published else origin if origin in candidates else candidates[0] if len(candidates) == 1 else None
        branches.append({"name": name, "head": commit, "pushedAs": pushed.removeprefix("refs/remotes/") if pushed else None})
    dirty = git("status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none", dirty=True)
    return {"head": head, "branch": branch, "dirty": dirty, "branches": branches}


try:
    result = json.dumps(observe(), ensure_ascii=True)
    if len(result) > 60 * 1024:
        raise ValueError("git observation exceeds the reply limit")
    print(result)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
