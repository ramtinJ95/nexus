#!/bin/sh
# Measures synced writes on a pylon's root disk under its current write cache setting.
# `measure.sh compare` measures under write back and write through in turn, with sudo, and restores the setting.
set -e
cache=/sys/block/vda/queue/write_cache
dir=$(mktemp -d "${HOME:-/tmp}/disk-measure.XXXXXX")
trap 'rm -rf "$dir"' EXIT
flushes() { awk '{print $16}' /sys/block/vda/stat; }
measure() {
	echo "write_cache: $(cat $cache)"
	before=$(flushes)
	printf 'dd 4k x100 oflag=dsync, new file:      '; dd if=/dev/zero of="$dir/a" bs=4k count=100 oflag=dsync 2>&1 | tail -1
	printf 'dd 4k x100 oflag=dsync, overwrite:     '; dd if=/dev/zero of="$dir/a" bs=4k count=100 oflag=dsync conv=notrunc 2>&1 | tail -1
	printf 'dd 1M x1024, no sync:                  '; dd if=/dev/zero of="$dir/b" bs=1M count=1024 2>&1 | tail -1
	printf 'dd 1M x1024 conv=fdatasync:            '; dd if=/dev/zero of="$dir/b" bs=1M count=1024 conv=fdatasync 2>&1 | tail -1
	printf 'append 4k + fsync x100:                '; node -e '
		const fs = require("node:fs"), fd = fs.openSync(process.argv[1], "w"), buf = Buffer.alloc(4096, 1), t = performance.now();
		for (let i = 0; i < 100; i++) { fs.writeSync(fd, buf); fs.fsyncSync(fd); }
		console.log(`${((performance.now() - t) / 100).toFixed(2)} ms/op`);' "$dir/c"
	echo "flush requests the guest sent: $(( $(flushes) - before ))"
	rm -f "$dir"/*
}
echo "kernel: $(uname -r)"
echo "root: $(findmnt -no SOURCE,FSTYPE,OPTIONS /)"
echo "scheduler: $(cat /sys/block/vda/queue/scheduler), rotational: $(cat /sys/block/vda/queue/rotational)"
if [ "$1" = compare ]; then
	was=$(cat $cache)
	for mode in "write back" "write through"; do
		echo "$mode" | sudo tee $cache >/dev/null
		echo; measure
	done
	echo "$was" | sudo tee $cache >/dev/null
	echo; echo "restored write_cache: $(cat $cache)"
else
	echo; measure
fi
