// Runs the dashboard's built client.js against the start dialog the stack serves, in jsdom, and prints what the form
// shows and sends. Needs jsdom on NODE_PATH and the stack from stack.ts after drive.sh, which adds project spread.
//   NODE_PATH=<dir>/node_modules node docs/verification/placement-spread/start-form.mjs
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// require, unlike import, finds jsdom on NODE_PATH.
const { JSDOM } = createRequire(import.meta.url)("jsdom");

const base = "http://127.0.0.1:7471";
const html = await (await fetch(`${base}/threads/new?project=nexus`, { headers: { host: "127.0.0.1" } })).text();
const dom = new JSDOM(html, { url: `${base}/threads/new?project=nexus`, runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
const sent = [];
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.fetch = async (path, init = {}) => {
  if (init.method === "POST" && path === "/v1/threads") {
    sent.push(JSON.parse(init.body));
    return new window.Response(JSON.stringify({ id: "th-000000000000" }), { status: 201 });
  }
  return new window.Response("", { status: 204 });
};
const client = (await readFile(new URL("../../../dist/dashboard/client.js", import.meta.url), "utf8")).replace(/^import"\.\/chunk-[A-Z0-9]+\.js";/, "");
window.eval(client);

const doc = window.document;
const form = doc.getElementById("start");
const placeholders = () => ["cpus", "memoryGiB", "diskGiB"].map((name) => `${name} ${form.elements[name].placeholder}`).join(", ");
const pick = (id) => {
  const radio = doc.querySelector(`#start input[name=project][value="${id}"]`);
  radio.checked = true;
  radio.dispatchEvent(new window.Event("input", { bubbles: true }));
};
console.log(`nexus picked: ${placeholders()}`);
pick("spread");
console.log(`spread picked: ${placeholders()}`);
pick("nexus");
console.log(`nexus picked again: ${placeholders()}`);

form.elements.worker.value = "harness";
for (const r of form.querySelectorAll("input[name=worker]")) r.dispatchEvent(new window.Event("change", { bubbles: true }));
form.elements.title.value = "from the form";
form.elements.memoryGiB.value = "12";
form.elements.cpus.value = "2";
form.requestSubmit();
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`sent with memory 12 and cpus 2: ${JSON.stringify(sent.at(-1))}`);

form.elements.memoryGiB.value = "";
form.elements.cpus.value = "";
window.eval("starting = false");
form.requestSubmit();
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`sent with the size fields empty: ${JSON.stringify(sent.at(-1))}`);
window.close();
