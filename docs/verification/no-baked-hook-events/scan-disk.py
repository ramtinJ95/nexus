import sys, re
pat = re.compile(rb'\{"kind":"session\.[a-z-]+"[^{}]{0,300}\}')
needle = sys.argv[2].encode()
seen = set()
with open(sys.argv[1], 'rb') as f:
    off = 0; tail = b''
    while True:
        chunk = f.read(64 << 20)
        if not chunk: break
        buf = tail + chunk
        for m in pat.finditer(buf):
            if needle in m.group(0) and m.group(0) not in seen:
                seen.add(m.group(0)); print(off - len(tail) + m.start(), m.group(0).decode(errors='replace'), flush=True)
        tail = buf[-512:]; off += len(chunk)
