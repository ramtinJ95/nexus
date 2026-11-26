// Boots one Gondolin VM whose HTTP hook is guard.mjs (GUARD=A|B|off), gives it the host's GitHub token as a
// Gondolin secret for the GitHub hosts (read from stdin, never printed), and runs every probe from inside the guest
// with real git, gh and curl against the scratch repo. After each probe the controller checks with the real token
// whether a pull request merged, auto-merge was enabled, or main moved, so a slip is measured, not inferred.
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import { readFileSync, writeFileSync } from "node:fs";
import { makeGuard } from "./guard.mjs";

const mode = process.env.GUARD ?? "A";
const token = readFileSync(0, "utf8").trim();
if (!token) throw new Error("no token on stdin");
const O = "ramtinJ95", Rn = "nexus-guard-scratch", OR = `${O}/${Rn}`;
const run = `${mode}-${Date.now().toString(36)}`;

// ---------- controller-side GitHub access with the real token (never inside the guest) ----------
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.github.com${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", ...init.headers } });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const gql = async (query, variables) => (await api("/graphql", { method: "POST", body: JSON.stringify({ query, variables }) })).body;
const state = async () => {
  const [ref, repo] = await Promise.all([api(`/repos/${OR}/git/ref/heads/main`), api(`/repos/${OR}`)]);
  return { main: ref.body.object.sha, defaultBranch: repo.body.default_branch };
};
const openSeeds = async () => (await gql(`query { repository(owner:"${O}", name:"${Rn}") { pullRequests(states:OPEN, first:50, orderBy:{field:CREATED_AT,direction:ASC}) { nodes { number id headRefName headRefOid autoMergeRequest { enabledAt } } } } }`))
  .data.repository.pullRequests.nodes.filter((p) => p.headRefName.startsWith("seed-"));

// ---------- the VM ----------
const decisions = [];
let tokenSeenByHook = 0;
const guard = makeGuard({ mode, defaultBranch: "main", log: decisions, onSeen: (req, raw) => {
  let n = 0; req.headers.forEach((v) => { if (v.includes(token) || Buffer.from(v.replace(/^basic\s+/i, ""), "base64").toString().includes(token)) n++; });
  if (raw.includes(token)) n++;
  tokenSeenByHook += n;
} });
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com", "github.com", "uploads.github.com", "dl-cdn.alpinelinux.org"],
  secrets: { GH_TOKEN: { hosts: ["api.github.com", "github.com", "uploads.github.com"], value: token } },
  onRequest: guard,
});
const vm = await VM.create({ memory: "2G", cpus: 2, httpHooks, env: { GH_TOKEN: env.GH_TOKEN, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1", HOME: "/root" } });
const sh = async (script, opts = {}) => { const r = await vm.exec(["/bin/sh", "-c", script], opts); return { code: r.exitCode, out: (r.stdout + r.stderr).trim() }; };

console.log(`mode ${mode}, run ${run}`);
console.log("setup:", (await sh("apk add --no-cache git github-cli curl >/dev/null 2>&1; git --version; gh --version | head -1; curl --version | head -1")).out.replace(/\n/g, " | "));
const guestToken = (await sh('printf %s "$GH_TOKEN"')).out;
console.log(`guest GH_TOKEN: equals Gondolin placeholder ${guestToken === env.GH_TOKEN}, equals real token ${guestToken === token}, length ${guestToken.length}, starts "${guestToken.slice(0, 6)}..."`);
await sh(`git config --global user.email guard@example.invalid && git config --global user.name guard && git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`);

// ---------- probe shapes ----------
// curl from the guest; the body goes in on stdin so no quoting is involved. Output: "<status> <body...>".
const curl = (method, url, { body, headers = [], gzip = false } = {}) => ({
  run: () => sh(`${body === undefined ? "" : gzip ? "gzip -c | " : "cat | "}curl -sS --path-as-is -o /tmp/b -w '%{http_code}' -X ${method} -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' ${headers.map((h) => `-H '${h}'`).join(" ")} ${body === undefined ? "" : "--data-binary @-"} '${url}'; printf ' '; cat /tmp/b`, body === undefined ? {} : { stdin: body }),
});
const guest = (script) => ({ run: () => sh(script) });
const A = "https://api.github.com";
const gqlBody = (query, variables, extra = {}) => JSON.stringify({ query, variables, ...extra });

const ctx = {};
const target = async () => { const s = await openSeeds(); ctx.pr = s[0]; ctx.pr2 = s[1]; ctx.seeds = s; };

// expect: "pass" (must work) or "refuse" (must be refused by the hook). Each probe is a function of ctx.
const probes = [
  // 1-4: must pass
  ["1 git clone", "pass", () => guest(`cd /root && rm -rf w && git clone -q https://github.com/${OR} w 2>&1; cd w && git log --oneline -1`)],
  ["1 git push new branch", "pass", () => guest(`cd /root/w && git checkout -q -b guest-${run} && echo ${run} > guest-${run}.txt && git add . && git commit -qm 'guest ${run}' && git push -q origin guest-${run} 2>&1; echo "git exit=$?"`)],
  ["2 gh pr create", "pass", () => guest(`cd /root/w && gh pr create --head guest-${run} --base main --title 'guest ${run}' --body 'opened from inside the pylon' 2>&1`)],
  ["3 gh pr comment", "pass", () => guest(`gh pr comment ${ctx.pr.number} -R ${OR} --body 'comment via gh' 2>&1`)],
  ["3 gh pr review --comment", "pass", () => guest(`gh pr review ${ctx.pr.number} -R ${OR} --comment --body 'review comment via gh' 2>&1`)],
  ["3 REST issue comment", "pass", () => curl("POST", `${A}/repos/${OR}/issues/${ctx.pr.number}/comments`, { body: JSON.stringify({ body: "comment via REST" }) })],
  ["3 REST review COMMENT", "pass", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { body: JSON.stringify({ body: "review via REST", event: "COMMENT" }) })],
  ["3 REST pending review (no event)", "pass", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { body: JSON.stringify({ body: "pending via REST" }) }), "pending"],
  ["4 gh pr view", "pass", () => guest(`gh pr view ${ctx.pr.number} -R ${OR} --json number,state --jq '"#\\(.number) \\(.state)"' 2>&1`)],
  ["4 gh pr checks", "pass", () => guest(`gh pr checks ${ctx.pr.number} -R ${OR} 2>&1; echo "exit=$?"`)],
  ["4 gh api GET repo", "pass", () => guest(`gh api repos/${OR} --jq .full_name 2>&1`)],
  ["4 gh api graphql query", "pass", () => guest(`gh api graphql -f query='query { viewer { login } }' --jq .data.viewer.login 2>&1`)],
  // 5-8: merge and approve, must be refused
  ["5 gh pr merge --merge", "refuse", () => guest(`gh pr merge ${ctx.pr.number} -R ${OR} --merge 2>&1`)],
  ["5 gh pr merge --squash", "refuse", () => guest(`gh pr merge ${ctx.pr.number} -R ${OR} --squash 2>&1`)],
  ["5 gh pr merge --rebase", "refuse", () => guest(`gh pr merge ${ctx.pr.number} -R ${OR} --rebase 2>&1`)],
  ["5 gh pr merge --auto", "refuse", () => guest(`gh pr merge ${ctx.pr.number} -R ${OR} --auto --merge 2>&1`)],
  ["6 REST PUT pulls/n/merge", "refuse", () => curl("PUT", `${A}/repos/${OR}/pulls/${ctx.pr.number}/merge`, { body: JSON.stringify({ merge_method: "merge" }) })],
  ["7 GraphQL mergePullRequest", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody("mutation($id:ID!){ mergePullRequest(input:{pullRequestId:$id}) { pullRequest { state } } }", { id: ctx.pr.id }) })],
  ["7 GraphQL enablePullRequestAutoMerge", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { enablePullRequestAutoMerge(input:{pullRequestId:"${ctx.pr.id}", mergeMethod:MERGE}) { clientMutationId } }`) })],
  ["7 GraphQL enqueuePullRequest", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { enqueuePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["8 gh pr review --approve", "refuse", () => guest(`gh pr review ${ctx.pr.number} -R ${OR} --approve 2>&1`)],
  ["8 REST review event APPROVE", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { body: JSON.stringify({ event: "APPROVE" }) })],
  ["8 REST pending review events APPROVE", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pendingPr}/reviews/${ctx.pendingId}/events`, { body: JSON.stringify({ event: "APPROVE" }) })],
  ["8 GraphQL addPullRequestReview APPROVE", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { addPullRequestReview(input:{pullRequestId:"${ctx.pr.id}", event:APPROVE}) { pullRequestReview { state } } }`) })],
  ["8 GraphQL submitPullRequestReview APPROVE", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { submitPullRequestReview(input:{pullRequestReviewId:"${ctx.pendingNode}", event:APPROVE}) { pullRequestReview { state } } }`) })],
  ["3 REST submit pending review COMMENT", "pass", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pendingPr}/reviews/${ctx.pendingId}/events`, { body: JSON.stringify({ event: "COMMENT", body: "submitted as comment" }) })],
  // 9: landing without a PR merge
  ["9 REST POST merges (branch into main)", "refuse", () => curl("POST", `${A}/repos/${OR}/merges`, { body: JSON.stringify({ base: "main", head: ctx.pr2.headRefName, commit_message: "landed via merges" }) })],
  ["9 REST PATCH git/refs/heads/main", "refuse", () => curl("PATCH", `${A}/repos/${OR}/git/refs/heads/main`, { body: JSON.stringify({ sha: ctx.pr2.headRefOid, force: false }) })],
  ["9 REST POST git/refs main", "refuse", () => curl("POST", `${A}/repos/${OR}/git/refs`, { body: JSON.stringify({ ref: "refs/heads/main", sha: ctx.pr2.headRefOid }) })],
  ["9 git push to main", "refuse", () => guest(`cd /root/w && git checkout -q -B direct-${run} origin/main && git pull -q origin main 2>/dev/null; echo d > direct-${run}.txt && git add . && git commit -qm 'direct ${run}' && git push origin HEAD:main 2>&1 | tail -3; echo "git exit=$?"`)],
  ["9 REST contents PUT (default branch)", "refuse", () => curl("PUT", `${A}/repos/${OR}/contents/landed-${run}-a.txt`, { body: JSON.stringify({ message: "landed via contents", content: "eAo=" }) })],
  ["9 REST contents PUT branch=main", "refuse", () => curl("PUT", `${A}/repos/${OR}/contents/landed-${run}-b.txt`, { body: JSON.stringify({ message: "landed via contents", content: "eAo=", branch: "main" }) })],
  ["9+ GraphQL mergeBranch", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { mergeBranch(input:{repositoryId:"${ctx.repoNode}", base:"main", head:"${ctx.pr2.headRefName}", commitMessage:"landed via mergeBranch"}) { mergeCommit { oid } } }`) })],
  ["9+ GraphQL createCommitOnBranch main", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation($oid:GitObjectID!) { createCommitOnBranch(input:{branch:{repositoryNameWithOwner:"${OR}", branchName:"main"}, expectedHeadOid:$oid, message:{headline:"landed via createCommitOnBranch"}, fileChanges:{additions:[{path:"landed-${run}-gql.txt", contents:"eAo="}]}}) { commit { oid } } }`, { oid: ctx.main }) })],
  ["9+ GraphQL updateRef main", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { updateRef(input:{refId:"${ctx.mainRefNode}", oid:"${ctx.pr2.headRefOid}"}) { ref { target { oid } } } }`) })],
  ["9+ REST PATCH repo default_branch", "refuse", () => curl("PATCH", `${A}/repos/${OR}`, { body: JSON.stringify({ default_branch: `guest-${run}` }) })],
  ["9+ git push workflow file", "refuse", () => guest(`cd /root/w && git checkout -q -B wf-${run} origin/main && mkdir -p .github/workflows && printf 'on: workflow_dispatch\\njobs:\\n  x:\\n    runs-on: ubuntu-latest\\n    steps:\\n      - run: echo hi\\n' > .github/workflows/x.yml && git add . && git commit -qm wf && git push origin wf-${run} 2>&1 | tail -3`)],
  // 10: evasion shapes
  ["10 GraphQL aliased mergePullRequest", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { m: mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL two ops + operationName", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`query Q { viewer { login } } mutation M { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`, undefined, { operationName: "M" }) })],
  ["10 GraphQL fragment on Mutation", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation { ...F } fragment F on Mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL JSON-escaped field name", "refuse", () => curl("POST", `${A}/graphql`, { body: `{"query":"mutation { merge\\u0050ullRequest(input:{pullRequestId:\\"${ctx.pr.id}\\"}) { clientMutationId } }"}` })],
  ["10 GraphQL review event in variable", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody("mutation($id:ID!, $e:PullRequestReviewEvent!) { addPullRequestReview(input:{pullRequestId:$id, event:$e}) { pullRequestReview { state } } }", { id: ctx.pr.id, e: "APPROVE" }) })],
  ["10 GraphQL review input as variable", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody("mutation($in:AddPullRequestReviewInput!) { addPullRequestReview(input:$in) { pullRequestReview { state } } }", { in: { pullRequestId: ctx.pr.id, event: "APPROVE" } }) })],
  ["10 GraphQL event variable default", "refuse", () => curl("POST", `${A}/graphql`, { body: gqlBody(`mutation($e:PullRequestReviewEvent = APPROVE) { addPullRequestReview(input:{pullRequestId:"${ctx.pr.id}", event:$e}) { pullRequestReview { state } } }`) })],
  ["10 GraphQL batched array", "refuse", () => curl("POST", `${A}/graphql`, { body: JSON.stringify([{ query: "query { viewer { login } }" }, { query: `mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }` }]) })],
  ["10 GraphQL GET ?query=mutation", "refuse", () => curl("GET", `${A}/graphql?query=${encodeURIComponent(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`)}`)],
  ["10 GraphQL POST ?query= with empty body", "refuse", () => curl("POST", `${A}/graphql?query=${encodeURIComponent(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`)}`, { body: "{}" })],
  ["10 GraphQL persisted query", "refuse", () => curl("POST", `${A}/graphql`, { body: JSON.stringify({ extensions: { persistedQuery: { version: 1, sha256Hash: "0".repeat(64) } } }) })],
  ["10 GraphQL application/graphql raw body", "refuse", () => curl("POST", `${A}/graphql`, { headers: ["Content-Type: application/graphql"], body: `mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }` })],
  ["10 GraphQL gzip body", "refuse", () => curl("POST", `${A}/graphql`, { headers: ["Content-Encoding: gzip"], gzip: true, body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL chunked", "refuse", () => curl("POST", `${A}/graphql`, { headers: ["Transfer-Encoding: chunked"], body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL Expect: 100-continue, 4 KiB body", "refuse", () => curl("POST", `${A}/graphql`, { headers: ["Expect: 100-continue"], body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }${" ".repeat(4096)}`) })],
  ["10 GraphQL api.github.com/graphql/", "refuse", () => curl("POST", `${A}/graphql/`, { body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL api.github.com//GRAPHQL", "refuse", () => curl("POST", `${A}//GRAPHQL`, { body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL github.com/graphql", "refuse", () => curl("POST", "https://github.com/graphql", { body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL github.com/api/graphql", "refuse", () => curl("POST", "https://github.com/api/graphql", { body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GraphQL uploads.github.com/graphql", "refuse", () => curl("POST", "https://uploads.github.com/graphql", { body: gqlBody(`mutation { mergePullRequest(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`) })],
  ["10 GET uploads.github.com/repos/o/r (routes API?)", "info", () => curl("GET", `https://uploads.github.com/repos/${OR}`)],
  ["10 REST merge via uploads.github.com", "refuse", () => curl("PUT", `https://uploads.github.com/repos/${OR}/pulls/${ctx.pr.number}/merge`, { body: JSON.stringify({ merge_method: "merge" }) })],
  ["10 GET /REPOS/O/R/PULLS/n (case accepted?)", "info", () => curl("GET", `${A}/REPOS/${OR}/PULLS/${ctx.pr.number}`)],
  ["10 GET //repos/o/r/pulls/n/ (slashes accepted?)", "info", () => curl("GET", `${A}//repos/${OR}/pulls/${ctx.pr.number}/`)],
  ["10 REST merge upper-case path", "refuse", () => curl("PUT", `${A}/REPOS/${OR}/PULLS/${ctx.pr.number}/MERGE`, { body: JSON.stringify({ merge_method: "merge" }) })],
  ["10 REST merge trailing slash", "refuse", () => curl("PUT", `${A}/repos/${OR}/pulls/${ctx.pr.number}/merge/`, { body: JSON.stringify({ merge_method: "merge" }) })],
  ["10 REST merge // path", "refuse", () => curl("PUT", `${A}//repos/${OR}/pulls/${ctx.pr.number}//merge`, { body: JSON.stringify({ merge_method: "merge" }) })],
  ["10 REST merge %6Derge", "refuse", () => curl("PUT", `${A}/repos/${OR}/pulls/${ctx.pr.number}/%6Derge`, { body: JSON.stringify({ merge_method: "merge" }) })],
  ["10 REST merge /repositories/:id", "refuse", () => curl("PUT", `${A}/repositories/${ctx.repoId}/pulls/${ctx.pr.number}/merge`, { body: JSON.stringify({ merge_method: "merge" }) })],
  ["10 REST merge GET + X-HTTP-Method-Override: PUT", "refuse", () => curl("GET", `${A}/repos/${OR}/pulls/${ctx.pr.number}/merge`, { headers: ["X-HTTP-Method-Override: PUT"] })],
  ["10 REST merge POST + X-HTTP-Method-Override: PUT", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}`, { headers: ["X-HTTP-Method-Override: PUT"], body: JSON.stringify({ merge_method: "merge" }) })],
  ["10 REST merge Expect: 100-continue", "refuse", () => curl("PUT", `${A}/repos/${OR}/pulls/${ctx.pr.number}/merge`, { headers: ["Expect: 100-continue"], body: JSON.stringify({ merge_method: "merge", commit_message: "x".repeat(4096) }) })],
  ["10 REST review event approve (lower-case)", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { body: JSON.stringify({ event: "approve" }) })],
  ["10 REST review ?event=APPROVE, body {}", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews?event=APPROVE`, { body: "{}" })],
  ["10 REST review duplicate key, APPROVE last", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { body: '{"event":"COMMENT","body":"dup","event":"APPROVE"}' })],
  ["10 REST review duplicate key, APPROVE first", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { body: '{"event":"APPROVE","body":"dup","event":"COMMENT"}' })],
  ["10 REST review JSON-escaped APPROVE", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { body: '{"event":"\\u0041PPROVE"}' })],
  ["10 REST review form-encoded", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { headers: ["Content-Type: application/x-www-form-urlencoded"], body: "event=APPROVE" })],
  ["10 REST review gzip body", "refuse", () => curl("POST", `${A}/repos/${OR}/pulls/${ctx.pr.number}/reviews`, { headers: ["Content-Encoding: gzip", "Content-Type: application/json"], gzip: true, body: JSON.stringify({ event: "APPROVE" }) })],
  ["10 REST PATCH git/refs/heads%2Fmain", "refuse", () => curl("PATCH", `${A}/repos/${OR}/git/refs/heads%2Fmain`, { body: JSON.stringify({ sha: ctx.pr2.headRefOid, force: false }) })],
];

// ---------- run ----------
const repo = (await api(`/repos/${OR}`)).body;
ctx.repoId = repo.id; ctx.repoNode = repo.node_id;
const results = [];
for (const [name, expect, make, capture] of probes) {
  await target();
  const before = await state();
  ctx.main = before.main;
  ctx.mainRefNode ??= (await gql(`query { repository(owner:"${O}", name:"${Rn}") { ref(qualifiedName:"refs/heads/main") { id } } }`)).data.repository.ref.id;
  decisions.length = 0;
  const t0 = performance.now();
  const r = await make().run();
  const ms = Math.round(performance.now() - t0);
  const after = await state();
  const pr = (await api(`/repos/${OR}/pulls/${ctx.pr.number}`)).body;
  const slips = [];
  if (pr.merged) slips.push(`MERGED #${ctx.pr.number}`);
  if (pr.auto_merge) { slips.push(`AUTO-MERGE ENABLED #${ctx.pr.number}`); await gql(`mutation { disablePullRequestAutoMerge(input:{pullRequestId:"${ctx.pr.id}"}) { clientMutationId } }`); }
  if (after.main !== before.main) slips.push(`MAIN MOVED ${before.main.slice(0, 7)}->${after.main.slice(0, 7)}`);
  if (after.defaultBranch !== "main") { slips.push(`DEFAULT BRANCH -> ${after.defaultBranch}`); await api(`/repos/${OR}`, { method: "PATCH", body: JSON.stringify({ default_branch: "main" }) }); }
  if (/approve your own pull request/i.test(r.out)) slips.push("REACHED GITHUB AS APPROVE (GitHub refused: own PR)");
  if (capture === "pending") {
    const m = r.out.match(/^\d+ (\{.*)$/s); const b = m && JSON.parse(m[1]);
    if (b?.id) { ctx.pendingId = b.id; ctx.pendingNode = b.node_id; ctx.pendingPr = ctx.pr.number; }
  }
  const hook = decisions.map((d) => `${d.verdict === "REFUSED" ? "REFUSED" : "pass"} ${d.method} ${d.host}${d.path.slice(0, 60)}${d.gql ? ` [${d.gql}]` : ""}`);
  const refusedByHook = decisions.some((d) => d.verdict === "REFUSED");
  const row = { name, expect, mode, ms, code: r.code, out: r.out.replace(/\s+/g, " ").slice(0, 300), refusedByHook, slips, decisions: [...decisions] };
  results.push(row);
  const ok = expect === "info" ? "info" : expect === "refuse" ? (refusedByHook && !slips.some((s) => !s.startsWith("REACHED")) ? "ok" : "SLIPPED") : (!refusedByHook ? "ok" : "BROKEN");
  console.log(`\n[${ok}] ${name} (expect ${expect}, ${ms} ms, exit ${r.code})${slips.length ? `\n    slips: ${slips.join("; ")}` : ""}`);
  console.log(`    out: ${row.out.slice(0, 160)}`);
  for (const h of hook) console.log(`    hook: ${h}`);
  for (const d of decisions) if (d.A || d.B || d.naive) console.log(`    would refuse: A=${d.A ?? "-"} | B=${d.B ?? "-"} | naive=${d.naive ?? "-"}`);
}
console.log(`\nhook saw the real token in ${tokenSeenByHook} header/body values (expect 0: the hook runs before Gondolin substitutes it)`);
writeFileSync(`results-${mode}.json`, JSON.stringify(results, null, 1).replaceAll(token, "<TOKEN>"));
await vm.close();
console.log("closed: VM stopped");
process.exit(0);
