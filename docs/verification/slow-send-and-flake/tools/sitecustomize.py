# Emulates XNU's killpg1 (bsd/kern/kern_sig.c): group members in SZOMB are skipped, and a group with members but none
# signalled returns EPERM. Linux signals zombies successfully. Loaded through PYTHONPATH by the git-facts helper.
import errno, os
_killpg = os.killpg
def _states(pgid):
    states = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            stat = open(f"/proc/{pid}/stat").read()
        except OSError:
            continue
        fields = stat[stat.rindex(")") + 2:].split()
        if int(fields[2]) == pgid:
            states.append(fields[0])
    return states
def killpg(pgid, sig):
    states = _states(pgid)
    if states and all(s == "Z" for s in states):
        if os.environ.get("XNU_KILLPG_LOG"):
            open(os.environ["XNU_KILLPG_LOG"], "a").write("EPERM\n")
        raise PermissionError(errno.EPERM, "Operation not permitted")
    return _killpg(pgid, sig)
os.killpg = killpg
