import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { deadPort } from "./kit.ts";

const listenOn = async (port: number, host?: string) => {
  const server = createServer().listen(port, host);
  return once(server, "listening").then(() => { server.close(); return "listening"; }, (err: NodeJS.ErrnoException) => err.code);
};

test("a dead port refuses each connection while a listen there fails", async (t) => {
  const port = await deadPort(t);
  if (process.platform === "linux") {
    for (const host of ["127.0.0.1", "0.0.0.0", "::", undefined]) assert.equal(await listenOn(port, host), "EADDRINUSE", `listen on ${host ?? "the default host"}`);
  }
  const socket = connect(port, "127.0.0.1");
  assert.equal(await once(socket, "connect").then(() => "connected", (err: NodeJS.ErrnoException) => err.code), "ECONNREFUSED");
});
