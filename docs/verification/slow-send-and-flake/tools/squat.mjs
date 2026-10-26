// Holds many ephemeral 127.0.0.1 listeners that answer HTTP with an empty body, as other test files do.
import { createServer } from "node:http";
const servers = [];
async function one() {
  const s = createServer((_q, r) => r.end(""));
  await new Promise((a) => s.listen(0, "127.0.0.1", a));
  servers.push(s);
  if (servers.length > 3500) servers.shift().close();
}
for (;;) { await Promise.all(Array.from({ length: 50 }, one)); await new Promise((a) => setTimeout(a, 5)); }
