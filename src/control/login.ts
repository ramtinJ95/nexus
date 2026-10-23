/**
 * Signs the control plane's harness in with ChatGPT: `node src/control/login.ts <config.json>`, as the control
 * plane's user. Stop the control plane first, because only one process may hold the credentials file.
 *
 * The browser's callback goes to port 1455 on this machine. From another machine, forward the port
 * (`ssh -L 1455:127.0.0.1:1455 <host>`), or paste the address the browser ends on when that page fails to load.
 */
import { createInterface } from "node:readline/promises";
import { harnessModels, loginChatGpt, openCredentials } from "../harness/credentials.ts";
import { readConfig } from "./main.ts";

const configPath = process.argv[2];
if (configPath === undefined) {
  console.error("usage: node src/control/login.ts <config.json>");
  process.exit(2);
}
const config = await readConfig(configPath);
const credentials = await openCredentials(config.harness.credentials);
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  await loginChatGpt(harnessModels(credentials), credentials, {
    async prompt(prompt) {
      if (prompt.type !== "manual_code" && prompt.type !== "text") throw new Error(`this login asks for a ${prompt.type}, which the CLI does not take`);
      return terminal.question(`${prompt.message} `, prompt.signal === undefined ? {} : { signal: prompt.signal });
    },
    notify(event) {
      if (event.type === "auth_url") console.log(`Open ${event.url}\n${event.instructions ?? ""}`);
      else if (event.type === "device_code") console.log(`Enter ${event.userCode} at ${event.verificationUri}`);
      else console.log(event.message);
    },
  });
} finally {
  terminal.close();
}
console.log(`Signed in. The login is in ${config.harness.credentials}`);
