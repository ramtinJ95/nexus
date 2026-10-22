# Gondolin's /init runs this as root on every boot from the image, just before it starts sandboxd, so no exec
# can see the guest without it. Gondolin sets no hostname, which leaves the kernel's at "(none)", and sudo
# then warns on every call that it cannot resolve it. Docker owns /etc/hosts and /etc/hostname inside its
# containers, so the image cannot ship them, and they are written here. A pylon resumed from a checkpoint
# keeps the name of the boot that made the checkpoint.
printf 'pylon\n' > /etc/hostname
# Both families, or a lookup that asks for IPv6 first falls through to Gondolin's DNS and gets a synthetic address.
# glibc answers an IPv4 lookup of a ::1 entry with 127.0.0.1, so either loopback may come back for IPv4.
printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\tpylon\n::1\tpylon\n' > /etc/hosts
printf 'pylon' > /proc/sys/kernel/hostname
