// Throwaway egress guard for GitHub, as a Gondolin onRequest hook. Two policies share one parsing front end, so the
// policy shape is the only thing that differs between them:
//   A, deny-list: refuse the merge, approve and land operations named in the brief (items 5-9), pass the rest.
//   B, allow-list: on api.github.com pass reads and a named set of write routes and GraphQL mutations, refuse the
//      rest; on github.com pass only git smart HTTP; refuse uploads.github.com.
// "off" refuses nothing but still records what A, B and a naive text matcher would have decided, so a run against
// GitHub shows which shapes GitHub itself accepts.
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { parse, Kind } from "graphql";

const API_HOSTS = new Set(["api.github.com", "uploads.github.com"]);
const GITHUB_HOSTS = new Set([...API_HOSTS, "github.com"]);
const OVERRIDE_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override"];

// ---------- front end: what the request is ----------

function normPath(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  p = p.replace(/\/+/g, "/").replace(/(.)\/$/, "$1").toLowerCase();
  return p.replace(/^\/repositories\/\d+(?=\/|$)/, "/repos/~/~");
}

function decodeBody(buf, encoding) {
  if (!buf.length) return "";
  const e = (encoding ?? "identity").trim().toLowerCase();
  try {
    if (e === "identity" || e === "") return buf.toString("utf8");
    if (e === "gzip" || e === "x-gzip") return gunzipSync(buf).toString("utf8");
    if (e === "deflate") return inflateSync(buf).toString("utf8");
    if (e === "br") return brotliDecompressSync(buf).toString("utf8");
  } catch { return null; }
  return null;
}

const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// Every operation in the document (not only the one operationName selects), each with its root fields, fragments
// expanded and arguments resolved against variables and variable defaults.
function graphqlOps(item) {
  if (typeof item?.query !== "string") return { error: "no query string" };
  let doc;
  try { doc = parse(item.query); } catch (e) { return { error: `parse: ${e.message.slice(0, 60)}` }; }
  const fragments = new Map(doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
  const ops = [];
  for (const op of doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION)) {
    const vars = { ...item.variables };
    for (const v of op.variableDefinitions ?? []) if (!(v.variable.name.value in vars) && v.defaultValue) vars[v.variable.name.value] = value(v.defaultValue, {});
    const roots = [];
    const walk = (set, seen) => {
      for (const s of set.selections) {
        if (s.kind === Kind.FIELD) roots.push({ name: s.name.value, args: Object.fromEntries((s.arguments ?? []).map((a) => [a.name.value, value(a.value, vars)])) });
        else if (s.kind === Kind.INLINE_FRAGMENT) walk(s.selectionSet, seen);
        else if (s.kind === Kind.FRAGMENT_SPREAD && !seen.has(s.name.value) && fragments.has(s.name.value)) walk(fragments.get(s.name.value).selectionSet, new Set([...seen, s.name.value]));
      }
    };
    walk(op.selectionSet, new Set());
    ops.push({ type: op.operation, name: op.name?.value, roots });
  }
  return { ops };
}

function value(node, vars) {
  switch (node.kind) {
    case Kind.VARIABLE: return vars?.[node.name.value];
    case Kind.OBJECT: return Object.fromEntries(node.fields.map((f) => [f.name.value, value(f.value, vars)]));
    case Kind.LIST: return node.values.map((v) => value(v, vars));
    case Kind.NULL: return null;
    case Kind.INT: case Kind.FLOAT: return Number(node.value);
    default: return node.value; // string, enum, boolean
  }
}

// The refs a git-receive-pack request updates, from its pkt-line command list. null when it cannot be read.
function receivePackRefs(buf) {
  const refs = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString("latin1"), 16);
    if (Number.isNaN(len)) return null;
    if (len === 0) return refs;
    if (len < 4 || i + len > buf.length) return null;
    const cmd = buf.subarray(i + 4, i + len).toString("latin1").split("\0")[0].trim();
    i += len;
    if (cmd.startsWith("shallow ")) continue;
    const parts = cmd.split(" ");
    if (parts.length !== 3) return null;
    refs.push(parts[2]);
  }
  return null;
}

// ---------- policies ----------

const REPO = "/repos/[^/]+/[^/]+";
const route = (re) => new RegExp(`^${REPO}${re}$`);
const R = {
  prMerge: route("/pulls/\\d+/merge"),
  merges: route("/merges"),
  reviews: route("/pulls/\\d+/reviews"),
  reviewEvents: route("/pulls/\\d+/reviews/\\d+/events"),
  refsDefault: null, // built per default branch
  refs: route("/git/refs"),
  contents: route("/contents/.+"),
};

const eventOf = (body, q) => [body?.event, q.get("event")].filter((e) => e !== undefined && e !== null);

function denyA(req, ctx) {
  const { host, method, np, q, bodyText, body } = req;
  if (host === "github.com") {
    if (/\/git-receive-pack$/.test(np)) {
      const refs = receivePackRefs(req.raw);
      if (refs === null) return "receive-pack body unreadable";
      if (refs.includes(`refs/heads/${ctx.defaultBranch}`)) return `git push to ${ctx.defaultBranch}`;
    }
    return null;
  }
  if (np === "/graphql") {
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) {
      const g = graphqlOps(item);
      if (g.error) return `graphql unreadable (${g.error})`;
      for (const op of g.ops) for (const f of op.roots) {
        if (["mergePullRequest", "enablePullRequestAutoMerge", "enqueuePullRequest"].includes(f.name)) return `graphql ${f.name}`;
        if (["addPullRequestReview", "submitPullRequestReview"].includes(f.name) && String(f.args.input?.event ?? f.args.event ?? "").toUpperCase() === "APPROVE") return `graphql ${f.name} APPROVE`;
      }
    }
    return null;
  }
  if (method === "GET" || method === "HEAD") return null;
  if (R.prMerge.test(np)) return "rest merge pull request";
  if (method === "POST" && R.merges.test(np)) return "rest merge branch";
  if (R.reviews.test(np) || R.reviewEvents.test(np)) {
    if (bodyText && body === undefined) return "review body unreadable";
    if (eventOf(body, q).some((e) => String(e).toUpperCase() === "APPROVE")) return "rest review APPROVE";
  }
  if (np === `${np.match(/^\/repos\/[^/]+\/[^/]+/)?.[0]}/git/refs/heads/${ctx.defaultBranch}`) return `rest ref update on ${ctx.defaultBranch}`;
  if (method === "POST" && R.refs.test(np) && String(body?.ref ?? "").toLowerCase() === `refs/heads/${ctx.defaultBranch}`) return `rest ref create ${ctx.defaultBranch}`;
  if (R.contents.test(np) && ["PUT", "DELETE"].includes(method)) {
    const branch = body?.branch ?? q.get("branch");
    if (branch === undefined || branch === null || String(branch).toLowerCase() === ctx.defaultBranch) return `rest contents write on ${ctx.defaultBranch}`;
  }
  return null;
}

const B_MUTATIONS = new Set([
  "createPullRequest", "updatePullRequest", "addComment", "updateIssueComment", "deleteIssueComment",
  "addPullRequestReview", "submitPullRequestReview", "deletePullRequestReview", "addPullRequestReviewComment",
  "addPullRequestReviewThread", "addPullRequestReviewThreadReply", "requestReviews", "addReaction", "removeReaction",
  "markPullRequestReadyForReview", "convertPullRequestToDraft",
]);
const B_REVIEW_EVENTS = new Set(["COMMENT", "REQUEST_CHANGES"]);
const B_REST = [
  ["POST", route("/pulls")],
  ["PATCH", route("/pulls/\\d+")],
  ["POST", route("/issues/\\d+/comments")],
  ["PATCH", route("/issues/comments/\\d+")],
  ["DELETE", route("/issues/comments/\\d+")],
  ["POST", route("/pulls/\\d+/comments")],
  ["POST", route("/pulls/\\d+/comments/\\d+/replies")],
  ["POST", R.reviews, "event"],
  ["POST", R.reviewEvents, "event"],
  ["PUT", route("/pulls/\\d+/reviews/\\d+")],
  ["DELETE", route("/pulls/\\d+/reviews/\\d+")],
  ["POST", route("/pulls/\\d+/requested_reviewers")],
  ["DELETE", route("/pulls/\\d+/requested_reviewers")],
];

function denyB(req, ctx) {
  const { host, method, np, q, bodyText, body, headers } = req;
  if (OVERRIDE_HEADERS.some((h) => headers.has(h))) return "method override header";
  if (host === "uploads.github.com") return "uploads.github.com not allowed";
  if (host === "github.com") {
    const m = np.match(/^\/[^/]+\/[^/]+?(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (!m) return "github.com path is not git smart HTTP";
    if (m[1] === "info/refs") return method === "GET" && /^git-(upload|receive)-pack$/.test(q.get("service") ?? "") ? null : "info/refs shape";
    if (method !== "POST") return "git rpc method";
    if (m[1] === "git-upload-pack") return null;
    const refs = receivePackRefs(req.raw);
    if (refs === null) return "receive-pack body unreadable";
    if (refs.includes(`refs/heads/${ctx.defaultBranch}`)) return `git push to ${ctx.defaultBranch}`;
    return null;
  }
  if (np === "/graphql") {
    if (method !== "POST") return "graphql over GET";
    if ([...q.keys()].length) return "graphql with query-string parameters";
    if (Array.isArray(body)) return "graphql batch";
    const g = graphqlOps(body);
    if (g.error) return `graphql unreadable (${g.error})`;
    for (const op of g.ops) {
      if (op.type === "query") continue;
      if (op.type !== "mutation") return `graphql ${op.type}`;
      for (const f of op.roots) {
        if (f.name === "__typename") continue;
        if (!B_MUTATIONS.has(f.name)) return `graphql mutation ${f.name} not allowed`;
        if (f.name === "addPullRequestReview" || f.name === "submitPullRequestReview") {
          const e = f.args.input?.event ?? f.args.event;
          if (!(e === undefined && f.name === "addPullRequestReview") && !B_REVIEW_EVENTS.has(e)) return `graphql ${f.name} event ${e}`;
        }
      }
    }
    return null;
  }
  if (method === "GET" || method === "HEAD") return null;
  if ([...q.keys()].length) return "write with query-string parameters";
  const hit = B_REST.find(([m, re]) => m === method && re.test(np));
  if (!hit) return `rest ${method} ${np} not allowed`;
  if (bodyText && (body === null || typeof body !== "object" || Array.isArray(body))) return "write body is not a JSON object";
  if (hit[2] === "event" && body?.event !== undefined && !B_REVIEW_EVENTS.has(body.event)) return `rest review event ${body.event}`;
  return null;
}

// What a matcher that greps the raw path and raw body text would have refused, for the text-vs-parse question.
function denyNaive(req, ctx) {
  const p = req.url.pathname;
  const t = req.raw.toString("latin1");
  if (/\/pulls\/\d+\/merge$/.test(p) && req.method !== "GET") return "path merge";
  if (/\/merges$/.test(p) && req.method === "POST") return "path merges";
  if (/mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest/.test(t)) return "text merge mutation";
  if (/"event"\s*:\s*"APPROVE"|event\s*:\s*APPROVE/.test(t)) return "text APPROVE";
  if (new RegExp(`/git/refs/heads/${ctx.defaultBranch}$`).test(p) && req.method !== "GET") return "path ref main";
  if (/\/contents\//.test(p) && req.method === "PUT" && !/"branch"/.test(t)) return "path contents";
  if (/git-receive-pack$/.test(p) && t.includes(`refs/heads/${ctx.defaultBranch}`)) return "text push main";
  return null;
}

// ---------- the hook ----------

export function makeGuard({ mode, defaultBranch, log, onSeen }) {
  const ctx = { defaultBranch };
  return async (request) => {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (!GITHUB_HOSTS.has(host)) return undefined;
    const method = request.method.toUpperCase();
    const raw = Buffer.from(await request.arrayBuffer());
    onSeen?.(request, raw);
    const bodyText = decodeBody(raw, request.headers.get("content-encoding"));
    const np = normPath(url.pathname);
    const req = { url, host, method, np, q: url.searchParams, raw, headers: request.headers, bodyText, body: bodyText ? json(bodyText) : undefined };
    const decisions = np === null
      ? { A: "path undecodable", B: "path undecodable" }
      : { A: bodyText === null && host !== "github.com" ? "body encoding unreadable" : denyA(req, ctx), B: bodyText === null && host !== "github.com" ? "body encoding unreadable" : denyB(req, ctx) };
    const naive = denyNaive(req, ctx);
    const gql = np === "/graphql" && req.body ? (Array.isArray(req.body) ? req.body : [req.body]).map((i) => graphqlOps(i).ops?.map((o) => `${o.type} ${o.roots.map((f) => f.name).join(",")}`).join(" | ")).join(" ; ") : undefined;
    const reason = mode === "A" ? decisions.A : mode === "B" ? decisions.B : null;
    log.push({ host, method, path: url.pathname + url.search, gql, A: decisions.A, B: decisions.B, naive, verdict: reason ? "REFUSED" : "passed" });
    if (reason) {
      return new Response(JSON.stringify({ message: `nexus-guard[${mode}] refused: ${reason}` }), {
        status: 403, headers: { "content-type": "application/json", "x-nexus-guard": "refused" },
      });
    }
    const canHaveBody = method !== "GET" && method !== "HEAD";
    return new Request(request.url, { method: request.method, headers: request.headers, body: canHaveBody && raw.length ? raw : undefined });
  };
}
