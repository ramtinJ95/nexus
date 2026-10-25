# Reads a pylon's checkout for the control plane's Files and Changes views. checkout-files.ts runs it with
# `python3 - <checkout> <op> [args...]` over a raw pipe and sends this file on stdin, because every pylon image has
# Python 3, and the probe takes a stream's argv in its request's URL, whose length is limited.
# It must run on Python 3.9, which the Mac's tests run it with.
#
# Ops, each printing to stdout:
#   snapshot <turn>        capture the working tree once for this durable run
#   list <path>             the directory's entries, as JSON
#   read <path> <max>       the file's bytes, at most <max> of them
#   changes <base>          the files that differ from <base>, as JSON
#   diff <base> [path...]   the unified diff from <base>, as JSON
# <base> is `start`, what the pylon booted at (refs/nexus/base), or `head`, or `turn` (the latest reply's start). Internal `turn:<id>` reads also verify the run ID. A base that names no commit is the
# empty tree: HEAD before the first commit, and the start of a pylon that booted an empty repository. Changes and
# diffs compare the working tree, untracked files included and ignored ones left out, through a scratch index, so
# the agent's own index is left alone.
#
# Exit 0 is an answer. Exit 3 is a refusal the caller can act on, printed as {"refused": kind, "message": text}.
# Any other exit is a failure, whose traceback goes to stderr, which the probe logs.
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading

MAX_ENTRIES = 2000
MAX_FILES = 3000
MAX_DIFF_BYTES = 4 << 20
# Below the control plane's deadline, so a slow git is refused rather than cut off.
GIT_TIMEOUT_S = 45


class Refused(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def main(argv):
    root = os.path.realpath(argv[0])
    op, args = argv[1], argv[2:]
    if not os.path.isdir(root):
        raise Refused("missing", "the pylon has no checkout at %s" % argv[0])
    if op == "list":
        answer(listing(root, args[0]))
    elif op == "read":
        sys.stdout.buffer.write(read(root, args[0], int(args[1])))
    elif op == "snapshot":
        def expired(signum, frame):
            raise subprocess.TimeoutExpired("turn snapshot", 60)
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(60)
        snapshot(root, args[0])
        signal.alarm(0)
        answer({})
    elif op == "changes":
        answer(changes(root, args[0]))
    elif op == "diff":
        answer(diff(root, args[0], args[1:]))
    else:
        raise ValueError("unknown op %r" % op)


def answer(value):
    # UTF-8 as it is, since escaping every non-ASCII character could take a diff past the control plane's limit. A
    # file name that is not UTF-8 prints with replacement characters.
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False).encode("utf-8", "replace"))


def inside(root, path):
    """The real path of `path`, relative to the checkout, which must stay inside it once symlinks resolve."""
    real = os.path.realpath(os.path.join(root, path))
    if real != root and not real.startswith(root + os.sep):
        raise Refused("outside", "%s is outside the checkout" % path)
    return real


def relative(root, real):
    return "" if real == root else os.path.relpath(real, root)


def listing(root, path):
    real = inside(root, path)
    if not os.path.lexists(real):
        raise Refused("missing", "%s does not exist" % path)
    if not os.path.isdir(real):
        raise Refused("kind", "%s is not a directory" % path)
    entries = []
    with os.scandir(real) as found:
        for entry in found:
            if entry.is_symlink():
                kind = "symlink"
            elif entry.is_dir(follow_symlinks=False):
                kind = "dir"
            elif entry.is_file(follow_symlinks=False):
                kind = "file"
            else:
                kind = "other"
            size = entry.stat(follow_symlinks=False).st_size if kind == "file" else None
            entries.append({"name": entry.name, "kind": kind, "size": size})
    entries.sort(key=lambda e: e["name"])
    return {"path": relative(root, real), "entries": entries[:MAX_ENTRIES], "truncated": len(entries) > MAX_ENTRIES}


def read(root, path, limit):
    real = inside(root, path)
    if not os.path.exists(real):
        raise Refused("missing", "%s does not exist" % path)
    if not os.path.isfile(real):
        raise Refused("kind", "%s is not a file" % path)
    with open(real, "rb") as f:
        content = f.read(limit + 1)
    # Read rather than stat, so a file that grows meanwhile is refused too.
    if len(content) > limit:
        raise Refused("large", "%s is over the %d-byte limit" % (path, limit))
    return content


def git_command(root, args):
    # The agent's git config must not change what the output is, such as by coloring it or by quoting paths.
    return ["git", "-C", root, "-c", "core.quotePath=false", "--literal-pathspecs", "--no-pager"] + args


def git(root, args, env=None):
    done = subprocess.run(git_command(root, args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=GIT_TIMEOUT_S)
    if done.returncode != 0:
        raise RuntimeError("git %s exited %d: %s" % (" ".join(args), done.returncode, done.stderr.decode(errors="replace")))
    return done.stdout


def resolve(root, name):
    found = subprocess.run(["git", "-C", root, "rev-parse", "--verify", "--quiet", name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return found.stdout.decode().strip() if found.returncode == 0 else None


def base_of(root, base):
    """The tree-ish to compare with, and the commit it is, or None where the base is the empty tree."""
    expected = base.split(":", 1)[1] if base.startswith("turn:") else None
    base = base.split(":", 1)[0]
    if base == "head":
        ref = "HEAD"
    elif base == "turn":
        ref = "refs/nexus/turn"
    elif base == "start":
        ref = "refs/nexus/base"
    else:
        raise ValueError("unknown base %r" % base)
    found = resolve(root, ref)
    if base == "turn" and found is not None and expected is not None:
        if git(root, ["show", "-s", "--format=%s", found]).decode().strip() != "Nexus turn " + expected:
            found = None
    if found is None:
        if base == "turn":
            raise Refused("no-base", "the checkout has no latest-turn snapshot: no turn has been captured yet, or its snapshot failed. Start another agent turn or ask for changes since HEAD instead")
        if base == "start":
            raise Refused("no-base", "the checkout has no refs/nexus/base, what its pylon booted at, because the pylon booted before Nexus recorded it. Ask for the changes since HEAD instead")
        if subprocess.run(["git", "-C", root, "rev-parse", "--git-dir"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            raise Refused("missing", "the checkout is not a git repository")
        # Before the first commit, HEAD names none.
        found = git(root, ["hash-object", "-t", "tree", "/dev/null"]).decode().strip()
    return found, resolve(root, found + "^{commit}")


def scratch_env(root, scratch):
    """An environment whose index is a copy of the checkout's with the whole working tree added to it."""
    index = os.path.join(scratch, "index")
    env = dict(os.environ, GIT_INDEX_FILE=index, GIT_OPTIONAL_LOCKS="0")
    # A copy keeps the index's stat data, so unchanged files are not hashed again. copy2 keeps the index's own mtime
    # too, which git compares each entry's with to catch a file changed in the same second the index was written.
    real = os.path.join(root, git(root, ["rev-parse", "--git-path", "index"]).decode().strip())
    if os.path.exists(real):
        shutil.copy2(real, index)
    else:
        git(root, ["read-tree", base_of(root, "head")[0]], env)
    git(root, ["add", "--all"], env)
    return env


def snapshot(root, turn):
    marker = os.path.join(root, git(root, ["rev-parse", "--git-path", "nexus-turn"]).decode().strip())
    if os.path.exists(marker):
        with open(marker) as f:
            if f.read() == turn:
                return
    # Invalidate first: a failed attempt must not show the preceding turn's changes.
    git(root, ["update-ref", "-d", "refs/nexus/turn"])
    with open(marker, "w") as f:
        f.write(turn)
    with tempfile.TemporaryDirectory() as scratch:
        env = scratch_env(root, scratch)
        tree = git(root, ["write-tree"], env).decode().strip()
        env.update(GIT_AUTHOR_NAME="Nexus", GIT_AUTHOR_EMAIL="nexus@localhost",
                   GIT_COMMITTER_NAME="Nexus", GIT_COMMITTER_EMAIL="nexus@localhost")
        commit = git(root, ["commit-tree", tree, "-m", "Nexus turn " + turn], env).decode().strip()
        git(root, ["update-ref", "refs/nexus/turn", commit])


DIFF_FLAGS = ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--no-relative"]
STATUSES = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed", "C": "copied", "T": "typechange"}


def changes(root, base):
    tree, commit = base_of(root, base)
    with tempfile.TemporaryDirectory() as scratch:
        env = scratch_env(root, scratch)
        status = git(root, DIFF_FLAGS + ["-z", "--name-status", tree], env).decode(errors="replace").split("\0")
        counts = git(root, DIFF_FLAGS + ["-z", "--numstat", tree], env).decode(errors="replace").split("\0")
    lines = {}
    i = 0
    while i < len(counts) and counts[i] != "":
        added, deleted, path = counts[i].split("\t", 2)
        if path == "":  # a rename or copy: the old path and the new one follow
            path = counts[i + 2]
            i += 2
        i += 1
        binary = added == "-"
        lines[path] = (None if binary else int(added), None if binary else int(deleted))
    files = []
    i = 0
    while i < len(status) and status[i] != "":
        letter = status[i][0]
        if letter not in STATUSES:
            raise RuntimeError("git reported status %r" % status[i])
        if letter in "RC":
            old, path = status[i + 1], status[i + 2]
            i += 3
        else:
            old, path = None, status[i + 1]
            i += 2
        added, deleted = lines.get(path, (None, None))
        files.append({"path": path, "oldPath": old, "status": STATUSES[letter], "additions": added, "deletions": deleted})
    return {"base": {"kind": base.split(":", 1)[0], "commit": commit}, "files": files[:MAX_FILES], "truncated": len(files) > MAX_FILES}


def diff(root, base, paths):
    tree, commit = base_of(root, base)
    for path in paths:
        inside(root, path)
    with tempfile.TemporaryDirectory() as scratch:
        env = scratch_env(root, scratch)
        command = git_command(root, DIFF_FLAGS + ["--src-prefix=a/", "--dst-prefix=b/", tree, "--"] + paths)
        # stderr into a file, so git never waits on a full stderr pipe while its stdout is read.
        with open(os.path.join(scratch, "stderr"), "w+b") as err:
            proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=err, env=env)
            # Only the start is read, and git is killed past the cap, so it never writes the whole of a huge diff. A
            # read from a pipe has no timeout of its own, so a watchdog kills git at the deadline.
            expired = threading.Event()
            watchdog = threading.Timer(GIT_TIMEOUT_S, lambda: (expired.set(), proc.kill()))
            watchdog.start()
            try:
                text = proc.stdout.read(MAX_DIFF_BYTES + 1)
                truncated = len(text) > MAX_DIFF_BYTES
                if truncated:
                    proc.kill()
                proc.wait()
            finally:
                watchdog.cancel()
            if not truncated:
                if expired.is_set():
                    raise subprocess.TimeoutExpired(command, GIT_TIMEOUT_S)
                if proc.returncode != 0:
                    err.seek(0)
                    raise RuntimeError("git diff exited %d: %s" % (proc.returncode, err.read().decode(errors="replace")))
    if truncated:
        # Whole lines only.
        text = text[: text.rfind(b"\n", 0, MAX_DIFF_BYTES) + 1]
    return {"base": {"kind": base.split(":", 1)[0], "commit": commit}, "diff": text.decode(errors="replace"), "truncated": truncated}


try:
    main(sys.argv[1:])
except Refused as refused:
    answer({"refused": refused.kind, "message": str(refused)})
    sys.exit(3)
except subprocess.TimeoutExpired:
    answer({"refused": "slow", "message": "git took over %d s to read the checkout" % GIT_TIMEOUT_S})
    sys.exit(3)
