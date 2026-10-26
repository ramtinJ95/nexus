import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
for path in sys.argv[1:]:
    data = open(path, "rb").read()
    r = libc.syscall(175, ctypes.c_char_p(data), ctypes.c_ulong(len(data)), ctypes.c_char_p(b""))
    print(path, "ok" if r == 0 else f"errno {ctypes.get_errno()}")
