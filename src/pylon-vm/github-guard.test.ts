import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { allowList, githubGuardHook, guardName, pushedRefs, refusal, type GuardRequest } from "./github-guard.ts";
import type { BootSpec } from "./contracts.ts";
import { networkOptions } from "./network.ts";

/**
 * The 84 probes of interrogate/guard-github/probes.mjs, each as the requests it sends, with the decision the guard must
 * make for each. The requests gh sends are written from gh's own GraphQL operations; the pushes are bytes git 2.39.5
 * sent (github-guard.pushes.json). `refuse` names a part of the reason the guard must give.
 */
const pushes = JSON.parse(readFileSync(join(import.meta.dirname, "github-guard.pushes.json"), "utf8")) as Record<string, string>;
const repo = "acme/scratch";
const pr = "PR_kwDOAAAAAc5aaaaa";

type Recorded = GuardRequest & { expect: "pass" | { refuse: RegExp } };
const pass = "pass" as const;
const refuse = (reason: RegExp) => ({ refuse: reason });

function req(method: string, url: string, expect: Recorded["expect"], body: string | Buffer = "", headers: Record<string, string> = {}): Recorded {
	return { method, url: new URL(url), headers: new Headers({ authorization: "Bearer GONDOLIN_PLACEHOLDER", ...headers }), body: Buffer.from(body), expect };
}
const api = (method: string, path: string, expect: Recorded["expect"], body?: unknown, headers?: Record<string, string>) =>
	req(method, `https://api.github.com${path}`, expect, body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), headers);
const gql = (query: string, expect: Recorded["expect"], variables?: unknown, extra: Record<string, unknown> = {}) => api("POST", "/graphql", expect, { query, variables, ...extra });
const viewer = gql("query UserCurrent { viewer { login } }", pass);
const prQuery = gql(`query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr_number) { id number state headRefName } } }`, pass, { owner: "acme", repo: "scratch", pr_number: 1 });
const merge = (mergeMethod: string) =>
	gql("mutation PullRequestMerge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }", refuse(/mergePullRequest is not on the allow-list/), { input: { pullRequestId: pr, mergeMethod } });
const mergeLiteral = `mutation { mergePullRequest(input:{pullRequestId:"${pr}"}) { clientMutationId } }`;
const lsRefs = (service: string) => req("GET", `https://github.com/${repo}/info/refs?service=${service}`, pass);
const push = (fixture: string, expect: Recorded["expect"]) =>
	req("POST", `https://github.com/${repo}/git-receive-pack`, expect, Buffer.from(pushes[fixture]!, "base64"), { "content-type": "application/x-git-receive-pack-request" });
const restMerge = (path: string, method = "PUT", headers?: Record<string, string>) => api(method, path, refuse(/not on the allow-list|override/), { merge_method: "merge" }, headers);
const reviews = `/repos/${repo}/pulls/1/reviews`;
const gh = (method: string, path: string, expect: Recorded["expect"], body = "", headers?: Record<string, string>) => req(method, `https://github.com${path}`, expect, body, headers);
const lfsBatch = JSON.stringify({ operation: "download", transfers: ["basic"], objects: [{ oid: "a".repeat(64), size: 1 }] });

const probes: [string, Recorded[]][] = [
	["1 git clone", [lsRefs("git-upload-pack"), req("POST", `https://github.com/${repo}/git-upload-pack`, pass, "0032want 0000000000000000000000000000000000000000\n00000009done\n")]],
	["1 git push new branch", [lsRefs("git-receive-pack"), push("new branch", pass)]],
	["2 gh pr create", [viewer, gql("mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }", pass, { input: { repositoryId: "R_1", baseRefName: "main", headRefName: "guest", title: "t", body: "b", draft: false } })]],
	["3 gh pr comment", [prQuery, gql("mutation CommentCreate($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { url } } } }", pass, { input: { subjectId: pr, body: "comment via gh" } })]],
	["3 gh pr review --comment", [prQuery, gql("mutation PullRequestReviewAdd($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }", pass, { input: { pullRequestId: pr, event: "COMMENT", body: "review comment via gh" } })]],
	["3 REST issue comment", [api("POST", `/repos/${repo}/issues/1/comments`, pass, { body: "comment via REST" })]],
	["3 REST review COMMENT", [api("POST", reviews, pass, { body: "review via REST", event: "COMMENT" })]],
	["3 REST pending review (no event)", [api("POST", reviews, pass, { body: "pending via REST" })]],
	["4 gh pr view", [prQuery]],
	["4 gh pr checks", [prQuery, gql("query PullRequestStatusChecks($id: ID!) { node(id: $id) { ... on PullRequest { statusCheckRollup: commits(last: 1) { nodes { commit { oid } } } } } }", pass, { id: pr })]],
	["4 gh api GET repo", [api("GET", `/repos/${repo}`, pass)]],
	["4 gh api graphql query", [viewer]],
	["5 gh pr merge --merge", [prQuery, merge("MERGE")]],
	["5 gh pr merge --squash", [prQuery, merge("SQUASH")]],
	["5 gh pr merge --rebase", [prQuery, merge("REBASE")]],
	["5 gh pr merge --auto", [prQuery, gql("mutation PullRequestAutoMerge($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { clientMutationId } }", refuse(/enablePullRequestAutoMerge/), { input: { pullRequestId: pr, mergeMethod: "MERGE" } })]],
	["6 REST PUT pulls/n/merge", [restMerge(`/repos/${repo}/pulls/1/merge`)]],
	["7 GraphQL mergePullRequest", [merge("MERGE")]],
	["7 GraphQL enablePullRequestAutoMerge", [gql(`mutation { enablePullRequestAutoMerge(input:{pullRequestId:"${pr}", mergeMethod:MERGE}) { clientMutationId } }`, refuse(/enablePullRequestAutoMerge/))]],
	["7 GraphQL enqueuePullRequest", [gql(`mutation { enqueuePullRequest(input:{pullRequestId:"${pr}"}) { clientMutationId } }`, refuse(/enqueuePullRequest/))]],
	["8 gh pr review --approve", [prQuery, gql("mutation PullRequestReviewAdd($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }", refuse(/event APPROVE/), { input: { pullRequestId: pr, event: "APPROVE", body: "" } })]],
	["8 REST review event APPROVE", [api("POST", reviews, refuse(/review event APPROVE/), { event: "APPROVE" })]],
	["8 REST pending review events APPROVE", [api("POST", `${reviews}/7/events`, refuse(/review event APPROVE/), { event: "APPROVE" })]],
	["8 GraphQL addPullRequestReview APPROVE", [gql(`mutation { addPullRequestReview(input:{pullRequestId:"${pr}", event:APPROVE}) { pullRequestReview { state } } }`, refuse(/event APPROVE/))]],
	["8 GraphQL submitPullRequestReview APPROVE", [gql(`mutation { submitPullRequestReview(input:{pullRequestReviewId:"PRR_1", event:APPROVE}) { pullRequestReview { state } } }`, refuse(/event APPROVE/))]],
	["3 REST submit pending review COMMENT", [api("POST", `${reviews}/7/events`, pass, { event: "COMMENT", body: "submitted as comment" })]],
	["9 REST POST merges (branch into main)", [api("POST", `/repos/${repo}/merges`, refuse(/not on the allow-list/), { base: "main", head: "seed-1" })]],
	["9 REST PATCH git/refs/heads/main", [api("PATCH", `/repos/${repo}/git/refs/heads/main`, refuse(/not on the allow-list/), { sha: "a".repeat(40), force: false })]],
	["9 REST POST git/refs main", [api("POST", `/repos/${repo}/git/refs`, refuse(/not on the allow-list/), { ref: "refs/heads/main", sha: "a".repeat(40) })]],
	["9 git push to main", [lsRefs("git-receive-pack"), push("update the default branch", refuse(/push to the default branch main/))]],
	["9 REST contents PUT (default branch)", [api("PUT", `/repos/${repo}/contents/landed-a.txt`, refuse(/not on the allow-list/), { message: "m", content: "eAo=" })]],
	["9 REST contents PUT branch=main", [api("PUT", `/repos/${repo}/contents/landed-b.txt`, refuse(/not on the allow-list/), { message: "m", content: "eAo=", branch: "main" })]],
	["9+ GraphQL mergeBranch", [gql(`mutation { mergeBranch(input:{repositoryId:"R_1", base:"main", head:"seed-1"}) { mergeCommit { oid } } }`, refuse(/mergeBranch/))]],
	["9+ GraphQL createCommitOnBranch main", [gql(`mutation($oid:GitObjectID!) { createCommitOnBranch(input:{branch:{repositoryNameWithOwner:"${repo}", branchName:"main"}, expectedHeadOid:$oid, message:{headline:"h"}, fileChanges:{additions:[{path:"x", contents:"eAo="}]}}) { commit { oid } } }`, refuse(/createCommitOnBranch/), { oid: "a".repeat(40) })]],
	["9+ GraphQL updateRef main", [gql(`mutation { updateRef(input:{refId:"REF_1", oid:"${"a".repeat(40)}"}) { ref { target { oid } } } }`, refuse(/updateRef/))]],
	["9+ REST PATCH repo default_branch", [api("PATCH", `/repos/${repo}`, refuse(/not on the allow-list/), { default_branch: "guest" })]],
	// The guard reads which refs a push updates, never the files in its pack. The plan's second limit keeps workflow files out: engineers' tokens lack the workflows permission.
	["9+ git push workflow file", [lsRefs("git-receive-pack"), push("new branch", pass)]],
	["10 GraphQL aliased mergePullRequest", [gql(`mutation { m: mergePullRequest(input:{pullRequestId:"${pr}"}) { clientMutationId } }`, refuse(/mergePullRequest/))]],
	["10 GraphQL two ops + operationName", [gql(`query Q { viewer { login } } mutation M { mergePullRequest(input:{pullRequestId:"${pr}"}) { clientMutationId } }`, refuse(/mergePullRequest/), undefined, { operationName: "Q" })]],
	["10 GraphQL fragment on Mutation", [gql(`mutation { ...F } fragment F on Mutation { mergePullRequest(input:{pullRequestId:"${pr}"}) { clientMutationId } }`, refuse(/mergePullRequest/))]],
	["10 GraphQL JSON-escaped field name", [api("POST", "/graphql", refuse(/mergePullRequest/), `{"query":"mutation { merge\\u0050ullRequest(input:{pullRequestId:\\"${pr}\\"}) { clientMutationId } }"}`)]],
	["10 GraphQL review event in variable", [gql("mutation($id:ID!, $e:PullRequestReviewEvent!) { addPullRequestReview(input:{pullRequestId:$id, event:$e}) { pullRequestReview { state } } }", refuse(/event APPROVE/), { id: pr, e: "APPROVE" })]],
	["10 GraphQL review input as variable", [gql("mutation($in:AddPullRequestReviewInput!) { addPullRequestReview(input:$in) { pullRequestReview { state } } }", refuse(/event APPROVE/), { in: { pullRequestId: pr, event: "APPROVE" } })]],
	["10 GraphQL event variable default", [gql(`mutation($e:PullRequestReviewEvent = APPROVE) { addPullRequestReview(input:{pullRequestId:"${pr}", event:$e}) { pullRequestReview { state } } }`, refuse(/event APPROVE/))]],
	["10 GraphQL batched array", [api("POST", "/graphql", refuse(/not a JSON object/), [{ query: "query { viewer { login } }" }, { query: mergeLiteral }])]],
	["10 GraphQL GET ?query=mutation", [api("GET", `/graphql?query=${encodeURIComponent(mergeLiteral)}`, refuse(/GraphQL over GET/))]],
	["10 GraphQL POST ?query= with empty body", [api("POST", `/graphql?query=${encodeURIComponent(mergeLiteral)}`, refuse(/query parameters/), "{}")]],
	["10 GraphQL persisted query", [api("POST", "/graphql", refuse(/without a query string/), { extensions: { persistedQuery: { version: 1, sha256Hash: "0".repeat(64) } } })]],
	["10 GraphQL application/graphql raw body", [api("POST", "/graphql", refuse(/not JSON/), mergeLiteral, { "content-type": "application/graphql" })]],
	["10 GraphQL gzip body", [req("POST", "https://api.github.com/graphql", refuse(/mergePullRequest/), gzipSync(JSON.stringify({ query: mergeLiteral })), { "content-encoding": "gzip" })]],
	["10 GraphQL chunked", [api("POST", "/graphql", refuse(/mergePullRequest/), { query: mergeLiteral }, { "transfer-encoding": "chunked" })]],
	["10 GraphQL Expect: 100-continue, 4 KiB body", [api("POST", "/graphql", refuse(/mergePullRequest/), { query: `${mergeLiteral}${" ".repeat(4096)}` }, { expect: "100-continue" })]],
	["10 GraphQL api.github.com/graphql/", [api("POST", "/graphql/", refuse(/mergePullRequest/), { query: mergeLiteral })]],
	["10 GraphQL api.github.com//GRAPHQL", [api("POST", "//GRAPHQL", refuse(/mergePullRequest/), { query: mergeLiteral })]],
	["10 GraphQL github.com/graphql", [req("POST", "https://github.com/graphql", refuse(/not git over HTTPS/), JSON.stringify({ query: mergeLiteral }))]],
	["10 GraphQL github.com/api/graphql", [req("POST", "https://github.com/api/graphql", refuse(/not git over HTTPS/), JSON.stringify({ query: mergeLiteral }))]],
	["10 GraphQL uploads.github.com/graphql", [req("POST", "https://uploads.github.com/graphql", refuse(/only reads/), JSON.stringify({ query: mergeLiteral }))]],
	// An info probe: uploads.github.com does not route the API, and GitHub answered 404.
	["10 GET uploads.github.com/repos/o/r (routes API?)", [req("GET", `https://uploads.github.com/repos/${repo}`, pass)]],
	["10 REST merge via uploads.github.com", [req("PUT", `https://uploads.github.com/repos/${repo}/pulls/1/merge`, refuse(/only reads/), JSON.stringify({ merge_method: "merge" }))]],
	["10 GET /REPOS/O/R/PULLS/n (case accepted?)", [api("GET", `/REPOS/${repo}/PULLS/1`, pass)]],
	["10 GET //repos/o/r/pulls/n/ (slashes accepted?)", [api("GET", `//repos/${repo}/pulls/1/`, pass)]],
	["10 REST merge upper-case path", [restMerge(`/REPOS/${repo}/PULLS/1/MERGE`)]],
	["10 REST merge trailing slash", [restMerge(`/repos/${repo}/pulls/1/merge/`)]],
	["10 REST merge // path", [restMerge(`//repos/${repo}/pulls/1//merge`)]],
	["10 REST merge %6Derge", [restMerge(`/repos/${repo}/pulls/1/%6Derge`)]],
	["10 REST merge /repositories/:id", [restMerge("/repositories/1473112793/pulls/1/merge")]],
	["10 REST merge GET + X-HTTP-Method-Override: PUT", [api("GET", `/repos/${repo}/pulls/1/merge`, refuse(/method override/), undefined, { "x-http-method-override": "PUT" })]],
	["10 REST merge POST + X-HTTP-Method-Override: PUT", [api("POST", `/repos/${repo}/pulls/1`, refuse(/method override/), { merge_method: "merge" }, { "x-http-method-override": "PUT" })]],
	["10 REST merge Expect: 100-continue", [api("PUT", `/repos/${repo}/pulls/1/merge`, refuse(/not on the allow-list/), { merge_method: "merge", commit_message: "x".repeat(4096) }, { expect: "100-continue" })]],
	["10 REST review event approve (lower-case)", [api("POST", reviews, refuse(/review event approve/), { event: "approve" })]],
	["10 REST review ?event=APPROVE, body {}", [api("POST", `${reviews}?event=APPROVE`, refuse(/query parameters/), "{}")]],
	["10 REST review duplicate key, APPROVE last", [api("POST", reviews, refuse(/key event twice/), '{"event":"COMMENT","body":"dup","event":"APPROVE"}')]],
	// Both prototype guards passed this: JSON.parse keeps the last key. Which one GitHub reads is unknown, so the guard refuses both orders.
	["10 REST review duplicate key, APPROVE first", [api("POST", reviews, refuse(/key event twice/), '{"event":"APPROVE","body":"dup","event":"COMMENT"}')]],
	["10 REST review JSON-escaped APPROVE", [api("POST", reviews, refuse(/review event APPROVE/), '{"event":"\\u0041PPROVE"}')]],
	["10 REST review form-encoded", [api("POST", reviews, refuse(/not JSON/), "event=APPROVE", { "content-type": "application/x-www-form-urlencoded" })]],
	["10 REST review gzip body", [req("POST", `https://api.github.com${reviews}`, refuse(/review event APPROVE/), gzipSync(JSON.stringify({ event: "APPROVE" })), { "content-encoding": "gzip", "content-type": "application/json" })]],
	["10 REST PATCH git/refs/heads%2Fmain", [api("PATCH", `/repos/${repo}/git/refs/heads%2Fmain`, refuse(/not on the allow-list/), { sha: "a".repeat(40), force: false })]],
	["11 curl -L release asset by tag", [gh("GET", "/cli/cli/releases/download/v2.60.0/gh_2.60.0_checksums.txt", pass)]],
	// GitHub answers the latest asset with a redirect to the asset by its tag on github.com, and Gondolin sends that hop through the hook too.
	["11 curl -L release asset by latest", [gh("GET", "/mikefarah/yq/releases/latest/download/checksums", pass), gh("GET", "/mikefarah/yq/releases/download/v4.54.3/checksums", pass)]],
	["11 curl -I release asset", [gh("HEAD", "/cli/cli/releases/download/v2.60.0/gh_2.60.0_checksums.txt", pass)]],
	["11 curl -L source archive", [gh("GET", "/cli/cli/archive/refs/tags/v2.60.0.tar.gz", pass)]],
	["11 curl -L raw file", [gh("GET", "/cli/cli/raw/v2.60.0/README.md", pass)]],
	["11 Git LFS batch", [gh("POST", `/${repo}.git/info/lfs/objects/batch`, refuse(/^Git LFS/), lfsBatch, { "content-type": "application/vnd.git-lfs+json" })]],
	["11 POST to a release asset path", [gh("POST", `/${repo}/releases/download/v1/asset.txt`, refuse(/not git over HTTPS or a download/), "x")]],
];

/** Operations the prototype did not probe, each with the decision the allow-list table makes for it. */
const unprobed: [string, Recorded[]][] = [
	["gh pr close", [gql("mutation PullRequestClose($input: ClosePullRequestInput!) { closePullRequest(input: $input) { pullRequest { id } } }", pass, { input: { pullRequestId: pr } })]],
	["REST close a pull request", [api("PATCH", `/repos/${repo}/pulls/1`, pass, { state: "closed" })]],
	["gh pr close --delete-branch deletes the branch", [api("DELETE", `/repos/${repo}/git/refs/heads/guest`, refuse(/not on the allow-list/))]],
	["gh issue create", [gql("mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { url } } }", pass, { input: { repositoryId: "R_1", title: "t", body: "b" } })]],
	["REST create an issue", [api("POST", `/repos/${repo}/issues`, pass, { title: "t" })]],
	["gh pr edit --add-label", [gql("mutation LabelAdd($input: AddLabelsToLabelableInput!) { addLabelsToLabelable(input: $input) { clientMutationId } }", pass, { input: { labelableId: pr, labelIds: ["LA_1"] } })]],
	["REST add a label", [api("POST", `/repos/${repo}/issues/1/labels`, pass, { labels: ["bug"] })]],
	["create a label", [api("POST", `/repos/${repo}/labels`, refuse(/not on the allow-list/), { name: "new" }), gql(`mutation { createLabel(input:{repositoryId:"R_1", name:"n", color:"fff"}) { clientMutationId } }`, refuse(/createLabel/))]],
	["gh release create", [api("POST", `/repos/${repo}/releases`, refuse(/not on the allow-list/), { tag_name: "v1" }), req("POST", `https://uploads.github.com/repos/${repo}/releases/1/assets?name=a`, refuse(/only reads/), "x")]],
	["update a branch from its base", [api("PUT", `/repos/${repo}/pulls/1/update-branch`, refuse(/not on the allow-list/), {}), gql(`mutation { updatePullRequestBranch(input:{pullRequestId:"${pr}"}) { clientMutationId } }`, refuse(/updatePullRequestBranch/))]],
];

/** Shapes the prototype's parse had to survive, beyond its probes. */
const shapes: [string, Recorded[]][] = [
	["a pushed branch and the default branch in one push", [push("a branch and the default branch", refuse(/push to the default branch main/))]],
	["a deleted branch", [push("delete a branch", refuse(/a push that deletes refs\/heads\/feature/))]],
	["a tag and a branch", [push("a tag and a branch", pass)]],
	["a push whose command list ends early", [req("POST", `https://github.com/${repo}/git-receive-pack`, refuse(/cannot be read/), Buffer.from(pushes["new branch"]!, "base64").subarray(0, 60))]],
	["a gzip push", [req("POST", `https://github.com/${repo}/git-receive-pack`, pass, gzipSync(Buffer.from(pushes["new branch"]!, "base64")), { "content-encoding": "gzip" })]],
	["a push in an encoding the guard cannot read", [req("POST", `https://github.com/${repo}/git-receive-pack`, refuse(/cannot be read/), Buffer.from(pushes["new branch"]!, "base64"), { "content-encoding": "zstd" })]],
	["a ref list without a service", [req("GET", `https://github.com/${repo}/info/refs`, refuse(/no git service/))]],
	["a duplicate key in GraphQL variables", [api("POST", "/graphql", refuse(/key e twice/), `{"query":"mutation($e:PullRequestReviewEvent!){addPullRequestReview(input:{pullRequestId:\\"${pr}\\", event:$e}){clientMutationId}}","variables":{"e":"COMMENT","e":"APPROVE"}}`)]],
	["an input object that names the event twice", [gql(`mutation { addPullRequestReview(input:{pullRequestId:"${pr}", event:COMMENT, event:APPROVE}) { clientMutationId } }`, refuse(/names event twice/))]],
	["an argument given twice", [gql(`mutation { addPullRequestReview(input:{pullRequestId:"${pr}", event:COMMENT}, input:{pullRequestId:"${pr}", event:APPROVE}) { clientMutationId } }`, refuse(/names input twice/))]],
	["a fragment defined twice", [gql(`mutation { ...F } fragment F on Mutation { addComment(input:{subjectId:"${pr}", body:"b"}) { clientMutationId } } fragment F on Mutation { mergePullRequest(input:{pullRequestId:"${pr}"}) { clientMutationId } }`, refuse(/fragment F twice/))]],
	["a variable named for an Object.prototype key, whose default approves", [gql(`mutation($constructor:AddPullRequestReviewInput={pullRequestId:"${pr}", event:APPROVE}) { addPullRequestReview(input:$constructor) { clientMutationId } }`, refuse(/event APPROVE/))]],
	["a variable named toString that the request does not give", [gql(`mutation($toString:PullRequestReviewEvent) { addPullRequestReview(input:{pullRequestId:"${pr}", event:$toString}) { clientMutationId } }`, pass)]],
	["variables that are a string", [gql(`mutation($e:PullRequestReviewEvent!) { addPullRequestReview(input:{pullRequestId:"${pr}", event:$e}) { clientMutationId } }`, refuse(/variables that are not an object/), '{"e":"APPROVE"}')]],
	["a GraphQL subscription", [gql("subscription { x }", refuse(/subscription/))]],
	["a document that does not parse", [gql("mutation {", refuse(/does not parse/))]],
	["a dot segment in a path", [api("POST", `/repos/${repo}/issues/1%2F..%2Fcomments`, refuse(/does not decode/), { body: "b" })]],
	["a host with a trailing dot", [req("PUT", `https://api.github.com./repos/${repo}/pulls/1/merge`, refuse(/only reads|not on the allow-list/), "{}"), req("GET", `https://api.github.com./repos/${repo}`, pass)]],
	["a body that is not UTF-8", [req("POST", `https://api.github.com/repos/${repo}/issues/1/comments`, refuse(/not UTF-8/), Buffer.concat([Buffer.from('{"body":"'), Buffer.from([0xff]), Buffer.from('"}')]))]],
	["a body in another charset", [api("POST", reviews, refuse(/charset utf-16/), { event: "COMMENT" }, { "content-type": "application/json; charset=UTF-16" }), api("POST", reviews, pass, { event: "COMMENT" }, { "content-type": "application/json; charset=utf-8" }),
		api("POST", reviews, refuse(/charset utf-7/), '{"+AGU-vent":"APPROVE"}', { "content-type": 'application/json; note=";charset=utf-8"; charset=utf-7' }),
		api("POST", reviews, refuse(/charset utf-16/), { event: "COMMENT" }, { "content-type": "application/json; charset=utf-8; charset=utf-16" })]],
	["a write to another GitHub host", [req("POST", "https://codeload.github.com/acme/scratch", refuse(/only reads/), "x")]],
];

const downloads = ["/releases/download/v1/tool.tar.gz", "/releases/latest/download/tool.tar.gz", "/archive/refs/heads/main.tar.gz", "/raw/main/install.sh"];
const notDownloads = ["", "/releases", "/releases/tag/v1", "/releases/download/v1", "/releases/download/release/v1/tool.tar.gz", "/releases/latest", "/archive", "/raw", "/blob/main/install.sh", "/settings", "/pulls"];

/** Reads on github.com, the four the operator's review found refused and their neighbours. */
const reads: [string, Recorded[]][] = [
	["the operator's four reads", [
		gh("GET", "/cli/cli/releases/download/v2.60.0/gh_2.60.0_linux_amd64.tar.gz", pass),
		gh("GET", "/o/r/archive/refs/heads/main.tar.gz", pass),
		gh("GET", "/o/r/raw/main/install.sh", pass),
		gh("POST", "/o/r.git/info/lfs/objects/batch", refuse(/^Git LFS/), lfsBatch, { "content-type": "application/vnd.git-lfs+json" }),
	]],
	["each download as GET and as HEAD", downloads.flatMap((path) => [gh("GET", `/${repo}${path}`, pass), gh("HEAD", `/${repo}${path}`, pass)])],
	["a write to each download path", downloads.flatMap((path) => ["POST", "PUT", "PATCH", "DELETE"].map((method) => gh(method, `/${repo}${path}`, refuse(/not git over HTTPS or a download/), "x")))],
	["a download with a query string", [gh("GET", `/${repo}/raw/main/install.sh?token=x`, pass), gh("GET", `/${repo}/archive/main.zip?_method=DELETE`, pass)]],
	["a download with a method override header", [gh("GET", `/${repo}/raw/main/install.sh`, refuse(/method override/), "", { "x-http-method-override": "DELETE" })]],
	["a download through a dot segment", [gh("GET", `/${repo}/raw/main%2F..%2F..%2Fsettings`, refuse(/does not decode/)), gh("GET", `/${repo}/raw/main/%2E%2E/%2E%2E/settings`, refuse(/not git over HTTPS or a download/))]],
	["every other read on github.com", [...notDownloads.map((path) => gh("GET", `/${repo}${path}`, refuse(/not git over HTTPS or a download/))), gh("GET", "/login", refuse(/not git over HTTPS/)), gh("GET", "/raw/main/install.sh", refuse(/not git over HTTPS/))]],
	["Git LFS by any route", [gh("GET", `/${repo}.git/info/lfs/locks`, refuse(/^Git LFS/)), gh("POST", `/${repo}/info/lfs/objects/batch`, refuse(/^Git LFS/), lfsBatch), gh("POST", `/${repo}.git/info/lfs/locks`, refuse(/^Git LFS/), "{}"), gh("GET", `/${repo}.git/INFO/LFS/objects/${"a".repeat(64)}`, refuse(/^Git LFS/))]],
];

for (const [group, rows] of [["probe", probes], ["not probed", unprobed], ["shape", shapes], ["read", reads]] as const) {
	for (const [name, requests] of rows) {
		test(`${group}: ${name}`, () => {
			for (const request of requests) {
				const got = refusal(request, { defaultBranch: "main" });
				const where = `${request.method} ${request.url.href.slice(0, 120)}`;
				if (request.expect === "pass") assert.equal(got, null, `${where} passes`);
				else assert.match(got ?? "passed", request.expect.refuse, `${where} is refused`);
			}
		});
	}
}

test("the recorded table holds every probe of the prototype, in its order", () => {
	const names = [...readFileSync(join(import.meta.dirname, "../../interrogate/guard-github/probes.mjs"), "utf8").matchAll(/^ {2}\["([^"]+)", "(?:pass|refuse|info)"/gm)].map((m) => m[1]);
	assert.equal(names.length, 84);
	assert.deepEqual(probes.map(([name]) => name), names);
});

test("a download's redirect hop is decided by the host it lands on", async () => {
	const hook = githubGuardHook({ defaultBranch: "main" }, () => {});
	for (const host of ["release-assets.githubusercontent.com", "raw.githubusercontent.com"]) assert.equal(await hook(new Request(`https://${host}/x`)), undefined, `${host} is not the guard's`);
	const codeload = await hook(new Request("https://codeload.github.com/cli/cli/tar.gz/refs/tags/v2.60.0"));
	assert.ok(codeload instanceof Request, "codeload.github.com takes reads");
});

test("the default branch is the project's: a push to main passes where the project's branch is trunk", () => {
	const toMain = push("update the default branch", pass);
	assert.equal(refusal(toMain, { defaultBranch: "trunk" }), null);
	assert.match(refusal(toMain, { defaultBranch: "MAIN" }) ?? "passed", /default branch MAIN/);
});

test("a default branch whose name is not ASCII is read from the push as git writes it, in UTF-8", () => {
	const line = (ref: string) => {
		const text = `${"0".repeat(40)} ${"1".repeat(40)} ${ref}\0 report-status\n`;
		return `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")}${text}`;
	};
	const body = Buffer.from(`${line("refs/heads/dévelop")}0000`, "utf8");
	assert.deepEqual(pushedRefs(body), [{ ref: "refs/heads/dévelop", deletes: false }]);
	assert.match(refusal({ ...push("new branch", pass), body }, { defaultBranch: "dévelop" }) ?? "passed", /default branch dévelop/);
	assert.match(refusal({ ...push("new branch", pass), body }, { defaultBranch: "de\u0301velop" }) ?? "passed", /default branch/, "in either Unicode form");
	const notUtf8 = Buffer.concat([Buffer.from(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/`), Buffer.from([0xff]), Buffer.from("\0 report-status\n")]);
	assert.equal(pushedRefs(Buffer.concat([Buffer.from((notUtf8.length + 4).toString(16).padStart(4, "0")), notUtf8, Buffer.from("0000")])), null, "a ref name that is not UTF-8 is not read");
});

test("a pylon whose boot holds no default branch refuses every push and says to start a new thread", () => {
	assert.match(refusal(push("new branch", pass), { defaultBranch: null }) ?? "passed", /Start a new thread/);
	assert.equal(refusal(lsRefs("git-upload-pack"), { defaultBranch: null }), null);
});

test("the decision is by host and request, never by the credential the request carries", () => {
	const approve = api("POST", reviews, pass, { event: "APPROVE" });
	const comment = api("POST", reviews, pass, { event: "COMMENT" });
	for (const authorization of ["Bearer GH_TOKEN_PLACEHOLDER", "token ALICE_OWN_GITHUB_PLACEHOLDER", "Basic eC1hY2Nlc3MtdG9rZW46eA==", ""]) {
		const headers = authorization === "" ? new Headers() : new Headers({ authorization });
		assert.match(refusal({ ...approve, headers }, { defaultBranch: "main" }) ?? "passed", /APPROVE/);
		assert.equal(refusal({ ...comment, headers }, { defaultBranch: "main" }), null);
	}
});

test("every row of the allow-list says which operation of an engineer's agent needs it", () => {
	for (const row of allowList) assert.ok(row.why.length > 10, JSON.stringify(row));
	assert.equal(new Set(allowList.map((row) => JSON.stringify({ ...row, why: undefined }))).size, allowList.length);
});

test("pushedRefs reads each command of a push and nothing after the flush", () => {
	assert.deepEqual(pushedRefs(Buffer.from(pushes["a tag and a branch"]!, "base64")), [{ ref: "refs/tags/v1", deletes: false }, { ref: "refs/heads/feature", deletes: false }]);
	assert.deepEqual(pushedRefs(Buffer.from(pushes["delete a branch"]!, "base64")), [{ ref: "refs/heads/feature", deletes: true }]);
	assert.deepEqual(pushedRefs(Buffer.from("0000")), []);
	assert.equal(pushedRefs(Buffer.from("zzzz")), null);
});

const spec = (githubGuard: BootSpec["githubGuard"]): BootSpec => ({
	resources: { cpus: 2, memoryGiB: 4 },
	allowedHosts: ["api.github.com", "github.com", "example.com"],
	secrets: {
		GH_TOKEN: { hosts: ["api.github.com", "github.com"], value: "ghp_real_owner_token" },
		ALICE_GITHUB: { hosts: ["api.github.com"], value: "ghp_alice_other_token" },
	},
	ssh: null,
	files: [],
	hooks: [],
	publicUrls: {},
	hostBridge: "/var/lib/nexus/pylons/host-bridge.sock",
	...githubGuard === undefined ? {} : { githubGuard },
});

test("an owner boot's hook refuses with a 403 that names the guard and the reason, and logs it", async () => {
	const lines: string[] = [];
	const hook = githubGuardHook({ defaultBranch: "main" }, (line) => lines.push(line));
	const reply = await hook(new Request(`https://api.github.com/repos/${repo}/pulls/1/merge`, { method: "PUT", body: "{}" }));
	assert.ok(reply instanceof Response);
	assert.equal(reply.status, 403);
	const body = (await reply.json()) as { message: string; guard: string; reason: string };
	assert.equal(body.guard, guardName);
	assert.match(body.message, new RegExp(`^${guardName} refused this request: PUT /repos/acme/scratch/pulls/1/merge is not on the allow-list`));
	assert.deepEqual(lines, [`${guardName} refused PUT api.github.com/repos/${repo}/pulls/1/merge: ${body.reason}`]);
});

test("an owner boot's hook sends a passed request on with its body, without Expect, and with every secret swapped in", async () => {
	const { httpHooks, placeholders } = networkOptions(spec({ defaultBranch: "main" }), "pylon-t1");
	const comment = JSON.stringify({ body: "x".repeat(2 << 20) });
	const sent = await httpHooks!.onRequest!(new Request(`https://api.github.com/repos/${repo}/issues/1/comments`, {
		method: "POST", headers: { authorization: `Bearer ${placeholders["GH_TOKEN"]}`, expect: "100-continue" }, body: comment,
	}));
	assert.ok(sent instanceof Request);
	assert.equal(sent.headers.get("expect"), null);
	assert.equal(sent.headers.get("authorization"), "Bearer ghp_real_owner_token");
	assert.equal(await sent.text(), comment);
});

test("an owner boot refuses a merge whichever GitHub secret the request carries", async () => {
	const { httpHooks, placeholders } = networkOptions(spec({ defaultBranch: "main" }), "pylon-t1");
	for (const name of ["GH_TOKEN", "ALICE_GITHUB"]) {
		const reply = await httpHooks!.onRequest!(new Request(`https://api.github.com/repos/${repo}/pulls/1/merge`, { method: "PUT", headers: { authorization: `Bearer ${placeholders[name]}` }, body: "{}" }));
		assert.ok(reply instanceof Response, name);
		assert.equal(reply.status, 403, name);
	}
});

test("the hook takes a GitHub host written with a trailing dot", async () => {
	const reply = await githubGuardHook({ defaultBranch: "main" }, () => {})(new Request(`https://api.github.com./repos/${repo}/pulls/1/merge`, { method: "PUT", body: "{}" }));
	assert.ok(reply instanceof Response);
	assert.equal(reply.status, 403);
});

test("a boot without the guard sends GitHub requests as before, and the guard leaves other hosts alone", async () => {
	const solo = networkOptions(spec(undefined), "pylon-t1");
	const merge = await solo.httpHooks!.onRequest!(new Request(`https://api.github.com/repos/${repo}/pulls/1/merge`, { method: "PUT", headers: { expect: "100-continue" }, body: "{}" }));
	assert.ok(merge instanceof Request);
	assert.equal(merge.headers.get("expect"), "100-continue");
	assert.equal(await githubGuardHook({ defaultBranch: "main" })(new Request("https://example.com/pulls/1/merge", { method: "PUT", body: "{}" })), undefined);
});
