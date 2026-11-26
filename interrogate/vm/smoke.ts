// One boot through pylon-vm with Gondolin's default image, one command, then destroy.
import { create, destroy, exec, pids, rssMiB } from "./kit.ts";

const name = "smoke";
try {
  const c = await create(name, 1);
  console.log("create ms", Math.round(c.ms), JSON.stringify(c.reply).slice(0, 300));
  console.log("pids", JSON.stringify(pids(name)), "rss", rssMiB(pids(name).controller), rssMiB(pids(name).qemu));
  const r = await exec(name, "uname -a; cat /etc/os-release | head -2; id; nproc; free -m | head -2");
  console.log("exec", JSON.stringify(r).slice(0, 800));
} catch (e) {
  console.log("FAILED", String(e));
  try { console.log((await import("node:fs")).readFileSync("/tmp/nx-a1f/instances/smoke/controller.log", "utf8").slice(-3000)); } catch (x) { console.log(String(x)); }
} finally {
  console.log("destroy", JSON.stringify(await destroy(name).catch((e) => String(e))));
}
