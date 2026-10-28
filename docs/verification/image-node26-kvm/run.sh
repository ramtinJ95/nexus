#!/bin/sh
# Runs the image's nexus-kvm as the pylon-vm controller would, as root, on this pylon, with shim/modprobe and
# shim/insmod in place of kmod's, then the KVM probe as user, then unloads what it loaded. Prints a transcript.
set -u
here=$(cd "$(dirname "$0")" && pwd)
step="$here/../../../images/pylon/nexus-kvm"
unload() { sudo python3 -I -c "
import ctypes; libc = ctypes.CDLL(None, use_errno=True)
for m in [b'kvm_intel', b'kvm_amd', b'kvm', b'irqbypass', b'overlay']: libc.syscall(176, ctypes.c_char_p(m), 0o4000)"; }
echo "\$ uname -r; grep -o -m1 -w 'vmx\|svm' /proc/cpuinfo"
uname -r; grep -o -m1 -w 'vmx\|svm' /proc/cpuinfo
echo "\$ ls -l /dev/kvm; grep -E '^(kvm|irqbypass|overlay)' /proc/modules (before)"
ls -l /dev/kvm 2>&1; grep -E '^(kvm|irqbypass|overlay)' /proc/modules | cut -d' ' -f1
echo "\$ sudo nexus-kvm; echo exit \$?"
sudo env PATH="$here/shim:/usr/sbin:/usr/bin:/sbin:/bin" sh "$step"; echo "exit $?"
echo "\$ ls -l /dev/kvm; grep -E '^(kvm|irqbypass|overlay)' /proc/modules"
ls -l /dev/kvm; grep -E '^(kvm|irqbypass|overlay)' /proc/modules | cut -d' ' -f1
echo "\$ sudo nexus-kvm; echo exit \$?   # a second boot step on a loaded guest"
sudo env PATH="$here/shim:/usr/sbin:/usr/bin:/sbin:/bin" sh "$step"; echo "exit $?"
echo "\$ python3 -I kvm-probe.py   # as user, not root"
id -un; timeout 20 python3 -I "$here/kvm-probe.py"
unload
echo "\$ sudo nexus-kvm with an insmod that loads nothing; echo exit \$?"
fake=$(mktemp -d); printf '#!/bin/sh\nexit 0\n' > "$fake/insmod"; chmod +x "$fake/insmod"
sudo env PATH="$fake:$here/shim:/usr/sbin:/usr/bin:/sbin:/bin" sh "$step"; echo "exit $?"
echo "\$ sudo nexus-kvm with an insmod that fails as kmod's does on a host without nested VMX; echo exit \$?"
printf '#!/bin/sh\necho "insmod: ERROR: could not insert module $1: Operation not supported" >&2\nexit 1\n' > "$fake/insmod"
sudo env PATH="$fake:$here/shim:/usr/sbin:/usr/bin:/sbin:/bin" sh "$step"; echo "exit $?"
rm -r "$fake"
echo "\$ ls -l /dev/kvm; grep -E '^(kvm|irqbypass|overlay)' /proc/modules (after unloading)"
ls -l /dev/kvm 2>&1; grep -E '^(kvm|irqbypass|overlay)' /proc/modules | cut -d' ' -f1
