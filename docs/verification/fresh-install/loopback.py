"""Adds or removes a /32 address on the loopback interface, as `ip addr add <ip>/32 dev lo label <name>` would, for
   a host without iproute2: python3 loopback.py lo:<n> <ip> up|down. It refuses a label that holds another address,
   and removes only a label that holds this one."""
import fcntl, socket, struct, sys
name, ip, up = sys.argv[1], sys.argv[2], sys.argv[3] == "up"
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
def req(addr): return struct.pack("16sH2s4s8s", name.encode(), socket.AF_INET, b"\0\0", socket.inet_aton(addr), b"\0" * 8)
try:
    held = socket.inet_ntoa(fcntl.ioctl(s, 0x8915, req("0.0.0.0"))[20:24])  # SIOCGIFADDR
except OSError:
    held = None
if up:
    if held not in (None, ip):
        sys.exit(f"{name} already holds {held}, so it is not this test's")
    fcntl.ioctl(s, 0x8916, req(ip))                 # SIOCSIFADDR
    fcntl.ioctl(s, 0x891C, req("255.255.255.255"))  # SIOCSIFNETMASK
elif held == ip:
    flags = struct.unpack("16sH", fcntl.ioctl(s, 0x8913, struct.pack("16sH14s", name.encode(), 0, b"\0" * 14))[:18])[1]
    fcntl.ioctl(s, 0x8914, struct.pack("16sH14s", name.encode(), flags & ~1, b"\0" * 14))
