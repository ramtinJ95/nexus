/**
 * Who may call what: each kind of caller against every route, the wrong methods, unknown paths and the attach upgrade,
 * as the status and refusal each gets. auth-matrix.txt holds the answers, and NEXUS_AUTH_MATRIX_UPDATE=1 rewrites it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { tokenDigest } from "../../protocol/deploy.ts";
import type { NodeName, TailnetNodeId } from "../../ids.ts";
import { laptop, phone, testApi, attachTo } from "../../test-support/api-kit.ts";

const update = process.env.NEXUS_AUTH_MATRIX_UPDATE === "1";
const file = new URL("./auth-matrix.txt", import.meta.url);

const firebat = "nFIREBAT" as TailnetNodeId;
const bench = "nBENCH" as TailnetNodeId;
const callers: readonly { who: string; id: TailnetNodeId | null; token?: string }[] = [
  { who: "deployer", id: laptop },
  { who: "person", id: phone },
  { who: "control-node", id: firebat, token: "firebat-token" },
  { who: "control-node-without-key", id: firebat },
  { who: "reporter", id: bench, token: "bench-token" },
  { who: "reporter-wrong-key", id: bench, token: "firebat-token" },
  { who: "node-without-key", id: bench },
  { who: "stranger", id: "nSTRANGER" as TailnetNodeId },
  { who: "unnamed", id: null },
];

const t0 = "th-000000000000";
const requests: readonly (readonly [string, string, unknown?])[] = [
  ["GET", "/v1/health"], ["GET", "/v1/health?x=1"], ["POST", "/v1/health", {}],
  ["GET", "/v1/whoami"], ["GET", "/v1/whoami?x=1"], ["POST", "/v1/whoami", {}],
  ["POST", "/v1/join", { bogus: 1 }], ["POST", "/v1/join?x=1", { bogus: 1 }], ["GET", "/v1/join"],
  ["GET", "/v1/nosuch"], ["GET", "/v1/nosuch?x=1"], ["POST", "/v1/nosuch", {}], ["GET", "/v1/%zz"],
  ["GET", "/v1/deployer/nosuch"], ["POST", "/v1/deployer/nosuch", {}],
  ["GET", "/v1/deployer/release"], ["GET", "/v1/deployer/release?x=1"], ["POST", "/v1/deployer/release", {}],
  ["POST", "/v1/deployer/report", { bogus: 1 }], ["GET", "/v1/deployer/report"],
  ["POST", "/v1/deployer/releases", { bogus: 1 }], ["POST", "/v1/deployer/drain", { bogus: 1 }],
  ["GET", "/v1/release"], ["PUT", "/v1/release", { bogus: 1 }], ["DELETE", "/v1/release", {}],
  ["GET", "/v1/usage"], ["GET", "/v1/usage?since=7d"], ["GET", "/v1/usage/backfill"], ["POST", "/v1/usage/backfill", {}], ["DELETE", "/v1/usage/backfill", {}],
  ["GET", "/v1/events"], ["GET", "/v1/events?kind=thread.failed"], ["GET", `/v1/threads/${t0}/events`], ["GET", `/v1/threads/${t0}/claude/events`],
  ["POST", `/v1/threads/${t0}/review`, {}], ["POST", `/v1/threads/${t0}/review/cancel`, {}], ["POST", `/v1/threads/${t0}/land`, {}], ["POST", `/v1/threads/${t0}/land`, { bogus: 1 }],
  ["POST", "/v1/questions/q-nosuch/answer", { option: "yes" }],
  ["POST", `/v1/threads/${t0}/previews`, {}], ["DELETE", `/v1/threads/${t0}/previews/3000`, {}],
  ["POST", `/v1/threads/${t0}/sessions`, {}], ["DELETE", `/v1/threads/${t0}/sessions/s1`, {}], ["POST", `/v1/threads/${t0}/sessions/s1/focus`, {}],
  ["GET", `/v1/threads/${t0}/files`], ["GET", `/v1/threads/${t0}/files/content?path=a`], ["GET", `/v1/threads/${t0}/image?path=a`],
  ["GET", `/v1/threads/${t0}/changes`], ["GET", `/v1/threads/${t0}/diff`],
  ["GET", "/v1/threads"], ["GET", "/v1/threads?deleted=false"], ["POST", "/v1/threads", { bogus: 1 }],
  ["GET", "/v1/queued"], ["GET", `/v1/queued/${t0}`], ["POST", `/v1/threads/${t0}/start`, {}],
  ["GET", `/v1/threads/${t0}`], ["DELETE", `/v1/threads/${t0}`, {}], ["PUT", `/v1/threads/${t0}`, {}],
  ["POST", `/v1/threads/${t0}/seen`, {}], ["POST", `/v1/threads/${t0}/unseen`, {}],
  ["POST", `/v1/threads/${t0}/archive`, {}], ["GET", `/v1/threads/${t0}/archive`], ["POST", `/v1/threads/${t0}/unarchive`, {}],
  ["POST", `/v1/threads/${t0}/activity`, {}], ["POST", `/v1/threads/${t0}/messages`, { text: "hi" }],
  ["POST", `/v1/threads/${t0}/abort`, {}], ["POST", `/v1/threads/${t0}/retry`, {}], ["POST", `/v1/threads/${t0}/pylon/retry`, {}],
  ["GET", `/v1/threads/${t0}/conversation`],
  ["PATCH", "/v1/projects/nosuch", { bogus: 1 }], ["GET", "/v1/projects"], ["POST", "/v1/projects", { bogus: 1 }],
  ["GET", "/v1/items"], ["POST", "/v1/items", { bogus: 1 }], ["GET", "/v1/items/it-nosuch"], ["POST", "/v1/items/it-nosuch/cancel", {}], ["POST", "/v1/items/it-nosuch/approve", {}],
  ["GET", "/v1/nodes"], ["GET", "/v1/nodes/nosuch/health"], ["GET", "/v1/nodes/nosuch/metrics?from=0"], ["GET", "/v1/nodes/rj-firebat/metrics"],
  ["GET", "/v1/images"], ["POST", "/v1/images", { bogus: 1 }], ["GET", "/v1/images/current"],
  ["POST", "/v1/images/build", {}], ["POST", "/v1/images/rollout", { bogus: 1 }], ["POST", "/v1/images/rollback", {}],
  ["GET", "/v1/doctor"], ["GET", "/v1/checks"], ["GET", "/v1/checks/changes"], ["POST", "/v1/checks/seen", { bogus: 1 }],
  ["GET", "/"], ["GET", "/threads/new"], ["GET", "/projects/new"], ["GET", "/usage"], ["GET", "/pipeline"], ["GET", "/cluster"], ["GET", "/health"], ["GET", "/threads/closed"], ["GET", "/threads/quiet"],
  ["GET", `/threads/${t0}`], ["GET", `/threads/${t0}/stream`], ["GET", "/nodes/nosuch"], ["GET", "/assets/nosuch.js"],
];

/** One request from 127.0.0.2, which the API at 127.0.0.1 sees as another machine, or from its own address. */
function send(port: number, method: string, path: string, body: unknown, headers: Record<string, string>, local: boolean): Promise<string> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, method, path, agent: false, ...local ? {} : { localAddress: "127.0.0.2" },
      headers: { host: `127.0.0.1:${port}`, ...payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }, ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      const json = res.headers["content-type"] === "application/json";
      res.on("end", () => {
        const said = !json ? "" : res.statusCode! >= 400 ? ` ${(JSON.parse(text) as { error: string }).error}` : path.startsWith("/v1/whoami") ? ` ${text}` : "";
        resolve(`${res.statusCode}${said}`);
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("each caller gets the allow, deny or 404 auth-matrix.txt records for every route", async (t) => {
  const s = await testApi(t, {
    deployment: { self: firebat, deployers: new Set([laptop, firebat]), keys: { [firebat]: tokenDigest("firebat-token"), [bench]: tokenDigest("bench-token") } },
  });
  s.registry.nodes.upsertNode({ name: "rj-bench" as NodeName, tailnetHost: "rj-bench.tail.ts.net", tailnetNodeId: bench });
  const lines: string[] = [];
  for (const { who, id, token } of callers) {
    s.callAs(id);
    const authorization: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };
    for (const [method, path, body] of requests) lines.push(`${who} ${method} ${path} -> ${await send(s.port, method, path, body, authorization, false)}`);
    lines.push(`${who} GET /v1/health from its own machine -> ${await send(s.port, "GET", "/v1/health", undefined, authorization, true)}`);
    lines.push(`${who} GET /v1/health?x=1 from its own machine -> ${await send(s.port, "GET", "/v1/health?x=1", undefined, authorization, true)}`);
    for (const path of ["/v1/%68ealth", "/v1/health#x"]) lines.push(`${who} GET ${path} from its own machine under host evil.example -> ${await send(s.port, "GET", path, undefined, { ...authorization, host: "evil.example" }, true)}`);
    lines.push(`${who} GET /v1/health from its own machine under host evil.example -> ${await send(s.port, "GET", "/v1/health", undefined, { ...authorization, host: "evil.example" }, true)}`);
    lines.push(`${who} POST /v1/threads without JSON -> ${await send(s.port, "POST", "/v1/threads", undefined, authorization, false)}`);
    lines.push(`${who} GET /v1/projects under host evil.example -> ${await send(s.port, "GET", "/v1/projects", undefined, { ...authorization, host: "evil.example" }, false)}`);
    lines.push(`${who} GET /v1/whoami under host evil.example -> ${await send(s.port, "GET", "/v1/whoami", undefined, { ...authorization, host: "evil.example" }, false)}`);
    const attach = await attachTo(s.port, `/v1/threads/${t0}/attach?cols=100&rows=30`, authorization);
    assert.ok("status" in attach, `${who} opened no terminal`);
    lines.push(`${who} attach -> ${attach.status} ${attach.body.error}`);
  }
  const text = `${lines.join("\n")}\n`;
  if (update) return void await writeFile(file, text);
  assert.equal(text, await readFile(file, "utf8"));
});
