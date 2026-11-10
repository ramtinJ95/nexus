import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { request as tlsRequest } from "node:https";
import { callText, until } from "../test-support/kit.ts";
import { dir, testApi, withThread } from "../test-support/api-kit.ts";
import { testCertificate } from "../test-certificate.ts";

const allowed = [{}, { "sec-fetch-site": "none" }, { "sec-fetch-site": "same-origin" }];
const refused = [{ "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }];
const link = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

test("a checkout read from another site or another origin of this one is refused before it wakes the pylon, and one from the CLI or the dashboard wakes it", async (t) => {
  const s = await withThread(t);
  const files = `/v1/threads/${s.thread.id}/files?path=`;
  const woken = [...s.woken];
  for (const headers of [...refused, ...refused.map((h) => ({ ...h, ...link })), { origin: "https://127.0.0.1:10200" }]) {
    const reply = await s.call("GET", files, undefined, headers);
    assert.equal(reply.status, 403, JSON.stringify(headers));
    assert.match(reply.body.error, /does not answer pages from/);
  }
  assert.deepEqual(s.woken, woken, "no refused read woke the pylon");
  assert.equal(s.registry.threads.thread(s.thread.id)!.lastHumanActivityAt, s.thread.lastHumanActivityAt, "no refused read counted as the person's");
  for (const headers of [...allowed, { origin: `http://127.0.0.1:${s.port}` }]) {
    const before: number = s.woken.length;
    assert.notEqual((await s.call("GET", files, undefined, headers)).status, 403, JSON.stringify(headers));
    assert.equal(s.woken.length, before + 1, `${JSON.stringify(headers)} woke the pylon`);
  }
});

test("a stream opens for the dashboard and the CLI, and for no page of another site or origin, even as a link", async (t) => {
  const s = await withThread(t);
  for (const path of ["/v1/events?follow=true", `/v1/threads/${s.thread.id}/events`, `/threads/${s.thread.id}/stream`]) {
    for (const headers of [...refused, ...refused.map((h) => ({ ...h, ...link })), { origin: "https://127.0.0.1:10200" }]) {
      assert.equal((await s.call("GET", path, undefined, headers)).status, 403, `${path} with ${JSON.stringify(headers)}`);
    }
    for (const headers of [...allowed, { origin: `http://127.0.0.1:${s.port}` }]) {
      const stream = s.events(path, headers);
      assert.equal((await stream.response).statusCode, 200, `${path} with ${JSON.stringify(headers)}`);
      stream.close();
      await stream.ended;
    }
  }
});

test("a link from another site opens a page of the dashboard, but nothing another site loads or frames does, nor a link to the API", async (t) => {
  const s = await testApi(t);
  const page = async (headers: Record<string, string>) => (await callText({ host: "127.0.0.1", port: s.port, method: "GET", path: "/", headers })).status;
  for (const headers of [...allowed, ...[...refused, ...allowed].map((h) => ({ ...h, ...link }))]) {
    assert.equal(await page(headers), 200, JSON.stringify(headers));
  }
  for (const site of refused) {
    for (const headers of [{ ...site, ...link, "sec-fetch-dest": "iframe" }, { ...site, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }]) {
      assert.equal(await page(headers), 403, JSON.stringify(headers));
    }
    assert.equal((await s.call("GET", "/v1/threads", undefined, { ...site, ...link })).status, 403, "a link to the API");
    assert.equal((await s.call("POST", "/v1/projects", {}, { ...site, ...link })).status, 403, "a form sent from another site");
  }
});

test("the HTTPS listener is its own origin: the plain-HTTP dashboard's origin and another site are refused there, its own pages are not", async (t) => {
  const certificate = await testCertificate(await mkdtemp(join(dir, "sites-tls-")));
  const s = await testApi(t, { https: { port: 0, certificate: async () => certificate } });
  await until("HTTPS started", () => s.httpsPort !== undefined);
  const tls = (path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    tlsRequest({ hostname: "127.0.0.1", port: s.httpsPort, path, agent: false, ca: certificate.cert, servername: "dashboard.example.ts.net", headers: { host: `127.0.0.1:${s.httpsPort}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    }).on("error", reject).end();
  });
  for (const headers of [...refused, { origin: `http://127.0.0.1:${s.port}` }]) assert.equal(await tls("/v1/threads", headers), 403, JSON.stringify(headers));
  for (const headers of [...allowed, { "sec-fetch-site": "same-origin", origin: `https://127.0.0.1:${s.httpsPort}` }]) assert.equal(await tls("/v1/threads", headers), 200, JSON.stringify(headers));
  assert.equal(await tls("/", { "sec-fetch-site": "same-site", ...link }), 200, "a link from the plain-HTTP dashboard or a preview opens the page");
});
