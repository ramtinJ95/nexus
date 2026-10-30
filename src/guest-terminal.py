# A program on a pty in a pylon, such as Herdr's client for `nexus attach`. guest-terminal.ts runs it over a raw
# pipe as `python3 -c <bootstrap> <source bytes> <cols> <rows> <term> <program...>`. The bootstrap reads exactly this
# file from stdin and runs it, so the rest of stdin is free for frames, and the probe's request URL, whose length is
# limited, carries only the bootstrap. It must run on Python 3.9, which the Mac's tests run it with.
#
# stdin carries frames: a type byte, a 4-byte big-endian length, then the payload. Type 0 is keys for the program.
# Type 1 is a resize, whose payload is the cols and rows as 2-byte big-endian numbers. The end of stdin hangs the
# terminal up, as closing an ssh session does, so Herdr's client detaches and its session stays. stdout is what the
# program writes to its terminal, unframed. The exit code is the program's, or 128 plus the signal that ended it.
# Diagnostics go to stderr, which the probe logs.
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

KEYS = 0
RESIZE = 1
# How long the program has to exit after a hang-up before its process group is killed.
HANGUP_GRACE_S = 2
# Once the program exits, its output is read until this long passes with none, so a background process that still
# holds the terminal cannot keep the relay alive.
DRAIN_QUIET_S = 0.1
TICK_S = 0.1
# Keys waiting for the program to read them. Past this the program has stopped reading, and the terminal hangs up.
# stdin is always read, because its end is the hang-up.
MAX_PENDING = 16 << 20


def log(message):
    sys.stderr.write(f"guest-terminal: {message}\n")
    sys.stderr.flush()


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def start(cols, rows, term, program):
    pid, master = pty.fork()
    if pid == 0:
        try:
            # Herdr refuses a terminal of zero size, so the size is set before the program starts.
            set_size(0, cols, rows)
            os.environ["TERM"] = term
            # Python ignores SIGPIPE, and an ignored signal stays ignored across exec.
            signal.signal(signal.SIGPIPE, signal.SIG_DFL)
            os.execvp(program[0], program)
        except Exception as err:
            # The child's stderr is the terminal, so the person attaching reads why.
            os.write(2, f"guest-terminal: cannot run {program[0]}: {err}\r\n".encode())
        finally:
            os._exit(127)
    return pid, master


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def read_master(master):
    """The terminal's next output, b"" once no process holds its other side, or None when it has none yet."""
    try:
        return os.read(master, 65536)
    except BlockingIOError:
        return None
    except OSError as err:
        if err.errno == errno.EIO:
            return b""
        raise


def exit_code(status):
    code = os.waitstatus_to_exitcode(status)
    return 128 - code if code < 0 else code


def main(argv):
    cols, rows, term, program = int(argv[0]), int(argv[1]), argv[2], argv[3:]
    pid, master = start(cols, rows, term, program)
    os.set_blocking(master, False)
    # bytearrays, which drop bytes from the front without copying the rest, so a big paste costs linear work.
    frames = bytearray()
    pending = bytearray()
    stdin_open = True
    stdout_open = True
    master_open = True
    hung_up_at = None
    killed = False
    status = None

    def hang_up():
        nonlocal master, hung_up_at
        # Closing the master hangs the terminal up, and the kernel sends SIGHUP to the program, its session leader.
        if master is not None:
            os.close(master)
            master = None
        pending.clear()
        if hung_up_at is None:
            hung_up_at = time.monotonic()

    def output(data):
        nonlocal stdout_open
        if not stdout_open:
            return
        try:
            write_all(1, data)
        except BrokenPipeError:
            stdout_open = False
            hang_up()

    while status is None:
        reading = [0] if stdin_open else []
        if master is not None and master_open:
            reading.append(master)
        writing = [master] if master is not None and master_open and pending else []
        readable, writable, _ = select.select(reading, writing, [], TICK_S)

        if 0 in readable:
            chunk = os.read(0, 65536)
            if not chunk:
                stdin_open = False
                hang_up()
            frames += chunk
            while len(frames) >= 5:
                kind, length = struct.unpack(">BI", frames[:5])
                if len(frames) < 5 + length:
                    break
                payload = bytes(frames[5:5 + length])
                del frames[:5 + length]
                if master is None:
                    continue
                if kind == KEYS:
                    pending += payload
                    if len(pending) > MAX_PENDING:
                        log(f"the program left {len(pending)} bytes of keys unread, so the terminal hangs up")
                        hang_up()
                elif kind == RESIZE and length == 4:
                    # The kernel sends SIGWINCH to the program's foreground process group.
                    set_size(master, *struct.unpack(">HH", payload))
                else:
                    log(f"a frame of type {kind} and {length} bytes is neither keys nor a resize, so the terminal hangs up")
                    stdin_open = False
                    hang_up()

        if master is not None and master in writable:
            try:
                del pending[:os.write(master, pending)]
            except BlockingIOError:
                pass
            except OSError as err:
                if err.errno != errno.EIO:
                    raise
                pending.clear()

        if master is not None and master in readable:
            data = read_master(master)
            if data == b"":
                master_open = False
            elif data:
                output(data)

        done, wait_status = os.waitpid(pid, os.WNOHANG)
        if done:
            status = wait_status
        elif hung_up_at is not None and not killed and time.monotonic() - hung_up_at > HANGUP_GRACE_S:
            killed = True
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    while master is not None and master_open:
        readable, _, _ = select.select([master], [], [], DRAIN_QUIET_S)
        data = read_master(master) if readable else b""
        if not data:
            break
        output(data)
    sys.exit(exit_code(status))


main(sys.argv[2:])
