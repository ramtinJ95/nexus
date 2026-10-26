# Runs a 4-byte real-mode guest (out 0xE9 'N'; hlt) under /dev/kvm and prints what it wrote.
import ctypes, fcntl, mmap, os, struct
KVM_GET_API_VERSION, KVM_CREATE_VM, KVM_GET_VCPU_MMAP_SIZE = 0xAE00, 0xAE01, 0xAE04
KVM_CREATE_VCPU, KVM_RUN = 0xAE41, 0xAE80
KVM_SET_USER_MEMORY_REGION = 0x4020AE46
KVM_GET_SREGS, KVM_SET_SREGS, KVM_SET_REGS = 0x8138AE83, 0x4138AE84, 0x4090AE82
kvm = os.open("/dev/kvm", os.O_RDWR)
print("api version", fcntl.ioctl(kvm, KVM_GET_API_VERSION))
vm = fcntl.ioctl(kvm, KVM_CREATE_VM, 0)
mem = mmap.mmap(-1, 0x1000, mmap.MAP_SHARED | mmap.MAP_ANONYMOUS)
mem[0:5] = bytes([0xB0, ord("N"), 0xE6, 0xE9, 0xF4])  # mov al,'N'; out 0xE9,al; hlt
addr = ctypes.addressof(ctypes.c_char.from_buffer(mem))
fcntl.ioctl(vm, KVM_SET_USER_MEMORY_REGION, struct.pack("IIQQQ", 0, 0, 0x1000, 0x1000, addr))
vcpu = fcntl.ioctl(vm, KVM_CREATE_VCPU, 0)
size = fcntl.ioctl(kvm, KVM_GET_VCPU_MMAP_SIZE, 0)
run = mmap.mmap(vcpu, size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
sregs = bytearray(312); fcntl.ioctl(vcpu, KVM_GET_SREGS, sregs)
struct.pack_into("QIIHBBBBBBBB", sregs, 0, 0, 0xFFFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)  # cs base 0, selector 0
fcntl.ioctl(vcpu, KVM_SET_SREGS, bytes(sregs))
regs = bytearray(144); struct.pack_into("Q", regs, 16 * 8, 0x1000); struct.pack_into("Q", regs, 17 * 8, 0x2)  # rip, rflags
fcntl.ioctl(vcpu, KVM_SET_REGS, bytes(regs))
out = []
while True:
    fcntl.ioctl(vcpu, KVM_RUN, 0)
    reason = struct.unpack_from("I", run, 8)[0]
    if reason == 2:  # KVM_EXIT_IO
        direction, size_, port, count, offset = struct.unpack_from("BBHIQ", run, 32)
        out.append(chr(run[offset]))
    elif reason == 5:  # KVM_EXIT_HLT
        print("guest wrote", "".join(out), "then halted"); break
    else:
        print("exit reason", reason); break
