// Preloaded into the real src/pylon-vm/daemon.ts in place of its runtime, as src/pylon-vm/fake-runtime.ts is, so each
// running pylon is a real controller process: it publishes controller.pid and answers on control.sock. Its VM is a
// child node process standing in for QEMU, which holds VM_MIB of memory and keeps VM_BUSY percent of one CPU busy.
// inspect answers as a controller does, with the record's labels and the resources the boot gave it.
//
//   node --import ./vm-stand-in.ts src/pylon-vm/daemon.ts <instance dir>
import { spawn } from "node:child_process";
import { registerHooks } from "node:module";
import type { Action, BootSpec, SandboxRecord } from "../../../src/pylon-vm/contracts.ts";
import { SandboxRuntime as Fake } from "../../../src/pylon-vm/fake-runtime.ts";

export { lifecycleQueue, NotRunning, readIntent, runsBesideQueue } from "../../../src/pylon-vm/fake-runtime.ts";

const vm = `const held = Buffer.alloc(${Number(process.env.VM_MIB ?? 64)} << 20, 1);
setInterval(() => { const t = Date.now(); while (Date.now() - t < ${Number(process.env.VM_BUSY ?? 0)}); held[0]++; }, 100);`;

export class SandboxRuntime extends Fake {
  private readonly record: SandboxRecord;
  private readonly spec: BootSpec;
  private readonly bootedAt = new Date().toISOString();
  constructor(dir: string, record: SandboxRecord, spec: BootSpec) {
    super(dir, record, spec);
    this.record = record;
    this.spec = spec;
  }
  override async boot(): Promise<void> {
    await super.boot();
    spawn(process.execPath, ["-e", vm], { stdio: "ignore" });
    console.log(`controller: ${this.record.name} booted its VM stand-in`);
  }
  override async handle(action: Action): Promise<unknown> {
    if (action.action !== "inspect") throw new Error(`no VM runs in this verification, so ${action.action} has nothing to act on`);
    const status = { name: this.record.name, state: "running", resources: this.spec.resources, bootedAt: this.bootedAt, setupRecorded: true, previews: {} };
    return { name: this.record.name, labels: this.record.labels, status };
  }
}

registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "./runtime.ts" && context.parentURL?.endsWith("/daemon.ts") ? next(import.meta.url, context) : next(specifier, context),
});
