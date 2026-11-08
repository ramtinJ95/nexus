import json
import os
import signal
import subprocess
import sys


def expired(signum, frame):
    raise TimeoutError("git observation exceeded its deadline")


signal.signal(signal.SIGALRM, expired)
signal.signal(signal.SIGTERM, expired)
signal.setitimer(signal.ITIMER_REAL, 2.5)
os.environ["GIT_OPTIONAL_LOCKS"] = "0"
os.environ["GIT_NO_LAZY_FETCH"] = "1"
# Also refuse transports on Git versions that predate GIT_NO_LAZY_FETCH.
os.environ["GIT_ALLOW_PROTOCOL"] = ""
os.environ["GIT_TERMINAL_PROMPT"] = "0"
reply_limit = int(sys.argv[1])


def git(*args, allowed=(0,), dirty=False, raw=False):
    process = subprocess.Popen(
        ["git", "-c", "core.fsmonitor=false", *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    try:
        output = process.stdout.read(1 if dirty else 256 * 1024 + 1)
        if dirty and output:
            return True
        if len(output) > 256 * 1024:
            raise ValueError("git observation exceeds the read limit")
        if process.wait() not in allowed:
            raise ValueError("git observation command failed")
        return False if dirty else output.decode("utf-8") if raw else output.decode("utf-8").removesuffix("\n")
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        # macOS refuses to signal a group whose only members are zombies, as git is once it exits unreaped after its first byte.
        except (ProcessLookupError, PermissionError):
            pass
        process.wait()
        process.stdout.close()


def observe():
    if git("rev-parse", "--is-inside-work-tree") != "true":
        raise ValueError("checkout is not a working tree")
    branch = git("symbolic-ref", "--quiet", "HEAD", allowed=(0, 1)).removeprefix("refs/heads/") or None
    head = git("rev-parse", "--verify", "--quiet", "HEAD", allowed=(0, 1))
    born = bool(head)
    if not born:
        head = git("hash-object", "-t", "tree", "--stdin")
    refs = git("for-each-ref", "--count=1001", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(symref)%00", "refs/heads/", "refs/remotes/", raw=True)
    rows = [record.split("\0") for record in refs.split("\0\n")[:-1]]
    if len(rows) > 1000:
        raise ValueError("git observation exceeds 1000 refs")
    remotes = git("remote").split("\n")
    tracking = [row[0] for row in rows if row[0].startswith("refs/remotes/") and not row[3]]
    # A clone, fetch or checkout writes these refs too. Only a push from this checkout logs this message.
    pushes = git("log", "-z", "--walk-reflogs", "--no-show-signature", "--fixed-strings", "--grep-reflog=update by push", "--format=%gD", *tracking, "--") if tracking else ""
    published = {entry.rpartition("@{")[0] for entry in pushes.split("\0")} & set(tracking)
    tips = {row[0]: row[1] for row in rows if row[0] in tracking}
    local = {row[0] for row in rows if row[0].startswith("refs/heads/")}
    branches = []
    for ref, commit, upstream, symref in rows:
        if not ref.startswith("refs/heads/"):
            continue
        name = ref.removeprefix("refs/heads/")
        candidates = [f"refs/remotes/{remote}/{name}" for remote in remotes if f"refs/remotes/{remote}/{name}" in published]
        origin = f"refs/remotes/origin/{name}"
        pushed = upstream if upstream in published else origin if origin in candidates else candidates[0] if len(candidates) == 1 else None
        branches.append({"name": name, "head": commit, "pushedAs": pushed.removeprefix("refs/remotes/") if pushed else None})
    # A push from elsewhere, or one cut short before git logged it, leaves origin/<name> holding only a fetch. It still
    # counts when the entry that set the branch's tip is this checkout's commit, or created the branch from HEAD or a
    # local branch whose reflog records committing that tip. Any other HEAD commit proves nothing for this name. At most
    # 32 branches are read, within the deadline.
    fetched = [b for b in branches if b["pushedAs"] is None and tips.get(f"refs/remotes/origin/{b['name']}") == b["head"]][:32]
    sources = {}
    for b in fetched:
        entry = git("log", "--walk-reflogs", "--no-show-signature", "--max-count=1", "--format=%gs", f"refs/heads/{b['name']}", "--")
        source = entry.removeprefix("branch: Created from ") if entry.startswith("branch: Created from ") else None
        source = source if source is None or source == "HEAD" or source.startswith("refs/") else f"refs/heads/{source}"
        if entry.startswith("commit"):
            b["pushedAs"] = f"origin/{b['name']}"
        elif (source == "HEAD" and born) or source in local:
            sources.setdefault(source, []).append(b)
    for ref, claimed in sources.items():
        made = git("log", "-z", "--walk-reflogs", "--no-show-signature", "--max-count=4096", "--basic-regexp", "--grep-reflog=^commit", "--format=%H", ref, "--").split("\0")
        for b in claimed:
            if b["head"] in made:
                b["pushedAs"] = f"origin/{b['name']}"
    dirty = git("status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none", dirty=True)
    return {"head": head, "branch": branch, "dirty": dirty, "branches": branches}


try:
    result = json.dumps(observe(), ensure_ascii=True)
    if len(result) > reply_limit:
        raise ValueError("git observation exceeds the reply limit")
    print(result)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
