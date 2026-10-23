import { test } from "node:test";
import assert from "node:assert/strict";
import { listeningFacts, parseListening } from "./listening.ts";
import { fakeGuest } from "./fake-guest.ts";

const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const tail = "00000000:00000000 00:00000000 00000000  1000        0 22000 1 0000000000000000 100 0 0 10 0";
const row = (i: number, local: string, remote: string, state: string) => `   ${i}: ${local} ${remote} ${state} ${tail}`;
const v4Any = "00000000:0000";
const v6Any = "00000000000000000000000000000000:0000";

const tcp = [
  header,
  row(0, "0100007F:0016", v4Any, "0A"), // sshd on 127.0.0.1:22
  row(1, "00000000:0BB8", v4Any, "0A"), // 0.0.0.0:3000
  row(2, "0100007F:1F90", v4Any, "0A"), // 127.0.0.1:8080
  row(3, "0A00020F:1F91", v4Any, "0A"), // 10.0.2.15:8081
  row(6, "0200007F:1F96", v4Any, "0A"), // 127.0.0.2:8086, which ingress never dials
  row(4, "0100007F:0BB8", "0100007F:D3C2", "01"), // an established connection to 3000
  row(5, "0100007F:1F94", "0100007F:D3C3", "06"), // a closing one from 8084
].join("\n");
const tcp6 = [
  header,
  row(0, "00000000000000000000000000000000:1435", v6Any, "0A"), // [::]:5173
  row(1, "00000000000000000000000001000000:1F92", v6Any, "0A"), // [::1]:8082
  row(2, "0000000000000000FFFF00000100007F:1F93", v6Any, "0A"), // [::ffff:127.0.0.1]:8083
  row(3, "00000000000000000000000000000000:0BB8", v6Any, "0A"), // [::]:3000 beside 0.0.0.0:3000
  row(4, "0000000000000000FFFF00000F02000A:1F95", v6Any, "0A"), // [::ffff:10.0.2.15]:8085
  row(5, "0000000000000000FFFF00000200007F:1F97", v6Any, "0A"), // [::ffff:127.0.0.2]:8087
  row(6, "0000000000000000FFFF000000000000:1F98", v6Any, "0A"), // [::ffff:0.0.0.0]:8088
].join("\n");

test("listening ports are those a connection to the guest's 127.0.0.1 reaches, without Nexus's sshd, each once and in order", () => {
  assert.deepEqual(parseListening(`${tcp}\n${tcp6}\n`), [3000, 5173, 8080, 8083, 8088]);
  assert.deepEqual(parseListening(header), [], "nothing listens");
});

test("ports are read in one exec, and a failed read rejects rather than reporting none", async () => {
  const guest = fakeGuest(() => ({ exitCode: 0, output: `${tcp}\n` }));
  assert.deepEqual(await listeningFacts(guest, 3000), [{ port: 3000 }, { port: 8080 }]);
  assert.equal(guest.execs.length, 1);
  const failing = fakeGuest(() => ({ exitCode: 1, output: "cat: /proc/net/tcp: No such file or directory" }));
  await assert.rejects(listeningFacts(failing, 3000), /reading \/proc\/net\/tcp exited 1/);
});
