/**
 * The GitHub guard of a shared install's pylon: an allow-list at the network edge, so an agent holding its owner's token
 * can push a branch, open and update a pull request, comment and read, and cannot merge, approve, or land a change by
 * another route. It decides by host and request alone, never by which credential a request carries, so a token the
 * owner grants GitHub's hosts under any name meets the same rules. Gondolin runs it before it swaps a placeholder for
 * its value, so the guard never sees a secret.
 *
 * What it cannot read it refuses: an undecodable path or body, a body with a duplicate key, a GraphQL document that
 * does not parse, a receive-pack command list it cannot walk. The prototype in interrogate/guard-github/ showed why a
 * list of forbidden operations is not enough: GitHub has more ways to land a change than such a list holds.
 */
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { Kind, parse, type ArgumentNode, type DocumentNode, type SelectionSetNode, type ValueNode } from "graphql";
import type { HttpHooks } from "@earendil-works/gondolin";

/** Named in every refusal's body and log line, so a 403 from the guard is never mistaken for GitHub's own. */
export const guardName = "nexus-github-guard";

/**
 * Everything that passes. A REST row is a method and a route under /repos/<owner>/<repo>, except `GET *` and `HEAD *`,
 * which take any path on api.github.com. A GraphQL row is `query`, or a mutation by its root field. A git row is a smart
 * HTTP route under /<owner>/<repo>[.git] on github.com. `check` adds a rule about the body:
 * - `review`: the review's event, if any, is COMMENT or REQUEST_CHANGES. No event leaves a review pending.
 * - `submit`: the event is COMMENT or REQUEST_CHANGES.
 * - `service`: the query names git-upload-pack or git-receive-pack.
 * - `push`: no ref the push updates is the project's default branch.
 */
export const allowList: readonly Allowed[] = [
	{ rest: "GET *", why: "every read: gh pr view, gh pr checks, gh api, and the agent's own curl" },
	{ rest: "HEAD *", why: "the same reads without a body" },
	{ rest: "POST /pulls", why: "open a pull request over REST" },
	{ rest: "PATCH /pulls/:n", why: "edit a pull request's title, body or base, or close and reopen it" },
	{ rest: "POST /issues", why: "file an issue for follow-up work. Not probed by the prototype" },
	{ rest: "POST /issues/:n/comments", why: "comment on a pull request or an issue" },
	{ rest: "PATCH /issues/comments/:n", why: "edit the agent's comment" },
	{ rest: "DELETE /issues/comments/:n", why: "delete the agent's comment" },
	{ rest: "POST /issues/:n/labels", why: "put existing labels on a pull request or an issue. Not probed by the prototype" },
	{ rest: "DELETE /issues/:n/labels/:name", why: "take a label off. Not probed by the prototype" },
	{ rest: "POST /pulls/:n/comments", why: "a review comment on a line" },
	{ rest: "POST /pulls/:n/comments/:n/replies", why: "reply in a review thread" },
	{ rest: "POST /pulls/:n/reviews", check: "review", why: "a review that comments or requests changes, or a pending one" },
	{ rest: "POST /pulls/:n/reviews/:n/events", check: "submit", why: "submit a pending review as a comment or a change request" },
	{ rest: "PUT /pulls/:n/reviews/:n", why: "edit a review's body" },
	{ rest: "DELETE /pulls/:n/reviews/:n", why: "delete a pending review" },
	{ rest: "POST /pulls/:n/requested_reviewers", why: "ask a teammate to review" },
	{ rest: "DELETE /pulls/:n/requested_reviewers", why: "withdraw a review request" },
	{ graphql: "query", why: "every GraphQL read gh makes" },
	{ graphql: "createPullRequest", why: "gh pr create" },
	{ graphql: "updatePullRequest", why: "gh pr edit, for a title, body or base" },
	{ graphql: "closePullRequest", why: "gh pr close, for a pull request the agent replaces. Not probed by the prototype" },
	{ graphql: "reopenPullRequest", why: "gh pr reopen. Not probed by the prototype" },
	{ graphql: "markPullRequestReadyForReview", why: "gh pr ready" },
	{ graphql: "convertPullRequestToDraft", why: "gh pr ready --undo" },
	{ graphql: "createIssue", why: "gh issue create, for follow-up work. Not probed by the prototype" },
	{ graphql: "addLabelsToLabelable", why: "gh pr edit --add-label, with existing labels. Not probed by the prototype" },
	{ graphql: "removeLabelsFromLabelable", why: "gh pr edit --remove-label. Not probed by the prototype" },
	{ graphql: "addComment", why: "gh pr comment" },
	{ graphql: "updateIssueComment", why: "gh pr comment --edit-last" },
	{ graphql: "deleteIssueComment", why: "delete the agent's comment" },
	{ graphql: "addPullRequestReview", check: "review", why: "gh pr review --comment and --request-changes" },
	{ graphql: "submitPullRequestReview", check: "submit", why: "submit a pending review as a comment or a change request" },
	{ graphql: "deletePullRequestReview", why: "delete a pending review" },
	{ graphql: "addPullRequestReviewComment", why: "a review comment on a line" },
	{ graphql: "addPullRequestReviewThread", why: "start a review thread" },
	{ graphql: "addPullRequestReviewThreadReply", why: "reply in a review thread" },
	{ graphql: "requestReviews", why: "gh pr create --reviewer and gh pr edit --add-reviewer" },
	{ graphql: "addReaction", why: "react to a comment" },
	{ graphql: "removeReaction", why: "take a reaction back" },
	{ git: "GET /info/refs", check: "service", why: "the ref list before every clone, fetch and push" },
	{ git: "POST /git-upload-pack", why: "clone and fetch" },
	{ git: "POST /git-receive-pack", check: "push", why: "push a branch other than the default branch" },
];

type Check = "review" | "submit" | "service" | "push";
type Allowed = ({ rest: string } | { graphql: string } | { git: string }) & { check?: Check; why: string };

/** What the guard is given at boot. A null branch, from a pylon stored before boots carried it, refuses every push. */
export interface GithubGuard { defaultBranch: string | null }

export interface GuardRequest { method: string; url: URL; headers: Headers; body: Buffer }

/** Why the guard refuses the request, or null when it passes. Only for a host `guarded` names. */
export function refusal(request: GuardRequest, guard: GithubGuard): string | null {
	const method = request.method.toUpperCase();
	if (overrideHeaders.some((name) => request.headers.has(name))) return "a method override header";
	const path = normalPath(request.url.pathname);
	if (path === null) return "the path does not decode";
	const host = request.url.hostname.toLowerCase().replace(/\.$/, "");
	if (host === "github.com") return gitRefusal(method, path, request, guard);
	if (host !== "api.github.com") return method === "GET" || method === "HEAD" ? null : `only reads reach ${host}`;
	if (path === "/graphql" && method !== "POST") return `GraphQL over ${method}`;
	if (method === "GET" || method === "HEAD") return null;
	if ([...request.url.searchParams.keys()].length > 0) return "a write with query parameters";
	const bytes = decodedBody(request);
	if (bytes === null) return "the body's encoding cannot be read";
	const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(request.headers.get("content-type") ?? "")?.[1]?.toLowerCase();
	if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") return `a body in the charset ${charset}`;
	let text: string;
	try {
		text = utf8.decode(bytes);
	} catch {
		return "the body is not UTF-8";
	}
	const body = bytes.length === 0 ? undefined : jsonObject(text);
	if (typeof body === "string") return body;
	if (path === "/graphql") return graphqlRefusal(body);
	const row = rest.find((r) => r.method === method && r.route.test(path));
	if (row === undefined) return `${method} ${path} is not on the allow-list`;
	return eventRefusal(row.check, body?.["event"], `the review event ${String(body?.["event"])}`);
}

/** The hosts the guard decides for. Every other host falls through to the allowlist as before. */
export const guarded = (host: string) => /(?:^|\.)github\.com\.?$/.test(host);

/**
 * The request hook. A refused request gets a 403 that names the guard and the reason, and one line in the pylon's
 * controller log. A passed one is rebuilt from the body the guard read, without `Expect`, since Gondolin 0.13.0
 * answers 502 to `Expect: 100-continue` and curl adds it to a body over 1 MiB.
 */
export function githubGuardHook(guard: GithubGuard, log: (line: string) => void = console.error): NonNullable<HttpHooks["onRequest"]> {
	return async (request) => {
		const url = new URL(request.url);
		if (!guarded(url.hostname.toLowerCase())) return undefined;
		const body = Buffer.from(await request.arrayBuffer());
		const reason = refusal({ method: request.method, url, headers: request.headers, body }, guard);
		if (reason !== null) {
			log(`${guardName} refused ${request.method} ${url.hostname}${url.pathname}: ${reason}`);
			return new Response(JSON.stringify({ message: `${guardName} refused this request: ${reason}`, guard: guardName, reason }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		}
		const headers = new Headers(request.headers);
		headers.delete("expect");
		return new Request(request.url, { method: request.method, headers, ...body.length > 0 && !["GET", "HEAD"].includes(request.method.toUpperCase()) ? { body } : {} });
	};
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const overrideHeaders = ["x-http-method-override", "x-http-method", "x-method-override"];
const reviewEvents = new Set(["COMMENT", "REQUEST_CHANGES"]);

const restPart: Record<string, string> = { ":n": "\\d+", ":name": "[^/]+" };
const routeRegExp = (prefix: string, route: string) =>
	new RegExp(`^${prefix}${route.split("/").map((part) => restPart[part] ?? part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}$`);
const rest = allowList.flatMap((row) => {
	if (!("rest" in row)) return [];
	const [method, route] = row.rest.split(" ") as [string, string];
	return route === "*" ? [] : [{ method, route: routeRegExp("/repos/[^/]+/[^/]+", route), check: row.check }];
});
const git = allowList.flatMap((row) => {
	if (!("git" in row)) return [];
	const [method, route] = row.git.split(" ") as [string, string];
	return [{ method, route: routeRegExp("/[^/]+/[^/]+?(?:\\.git)?", route), check: row.check }];
});
const mutations = new Map(allowList.flatMap((row) => ("graphql" in row && row.graphql !== "query" ? [[row.graphql, row.check] as const] : [])));

/**
 * Percent-decoded, slashes collapsed, no trailing slash, lower case, and `/repositories/<id>` as `/repos/~/~`, the
 * spellings GitHub treats as one route. A `.` or `..` segment could mean another route to GitHub, so it does not decode.
 */
function normalPath(pathname: string): string | null {
	let path: string;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	path = path.replace(/\/+/g, "/").replace(/(.)\/$/, "$1").toLowerCase();
	if (path.split("/").some((part) => part === "." || part === "..")) return null;
	return path.replace(/^\/repositories\/\d+(?=\/|$)/, "/repos/~/~");
}

function decodedBody(request: GuardRequest): Buffer | null {
	const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
	const decode = ({ identity: (b: Buffer) => b, "": (b: Buffer) => b, gzip: gunzipSync, "x-gzip": gunzipSync, deflate: inflateSync, br: brotliDecompressSync } as Record<string, (b: Buffer) => Buffer>)[encoding];
	if (decode === undefined) return null;
	try {
		return request.body.length === 0 ? request.body : decode(request.body);
	} catch {
		return null;
	}
}

/** The body as a JSON object, or why it is not one the guard can read. */
function jsonObject(text: string): Record<string, unknown> | string {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return "the body is not JSON";
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) return "the body is not a JSON object";
	const duplicate = duplicateKey(text);
	return duplicate === null ? (body as Record<string, unknown>) : `the body has the key ${duplicate} twice, and which one GitHub reads is unknown`;
}

/** The first key an object of valid JSON `text` holds twice, compared after unescaping, or null. */
function duplicateKey(text: string): string | null {
	const objects: (Set<string> | null)[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "{") objects.push(new Set());
		else if (c === "[") objects.push(null);
		else if (c === "}" || c === "]") objects.pop();
		else if (c === '"') {
			let end = i + 1;
			while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			const keys = objects.at(-1);
			if (keys != null && /^\s*:/.test(text.slice(end + 1))) {
				const key = JSON.parse(text.slice(i, end + 1)) as string;
				if (keys.has(key)) return key;
				keys.add(key);
			}
			i = end;
		}
	}
	return null;
}

function eventRefusal(check: Check | undefined, event: unknown, what: string): string | null {
	if (check === "review" && event === undefined) return null;
	if (check === "review" || check === "submit") return typeof event === "string" && reviewEvents.has(event) ? null : `${what} is not COMMENT or REQUEST_CHANGES`;
	return null;
}

/**
 * Every operation in the document, not only the one `operationName` picks, with fragments expanded and each argument
 * resolved against the variables and their defaults. A query passes. A mutation passes when every root field is a row.
 */
function graphqlRefusal(body: Record<string, unknown> | undefined): string | null {
	if (typeof body?.["query"] !== "string") return "a GraphQL body without a query string";
	const variables = body["variables"] ?? {};
	if (variables === null || typeof variables !== "object" || Array.isArray(variables)) return "GraphQL variables that are not an object";
	let doc: DocumentNode;
	try {
		doc = parse(body["query"]);
	} catch (error) {
		return `the GraphQL document does not parse: ${(error as Error).message}`;
	}
	const names = doc.definitions.flatMap((d) => (d.kind === Kind.FRAGMENT_DEFINITION ? [`fragment ${d.name.value}`] : d.kind === Kind.OPERATION_DEFINITION && d.name !== undefined ? [`operation ${d.name.value}`] : []));
	const twice = names.find((name, i) => names.indexOf(name) !== i);
	if (twice !== undefined) return `the GraphQL document defines the ${twice} twice`;
	const fragments = new Map(doc.definitions.flatMap((d) => (d.kind === Kind.FRAGMENT_DEFINITION ? [[d.name.value, d.selectionSet] as const] : [])));
	try {
		return mutationRefusal(doc, fragments, variables as Record<string, unknown>);
	} catch (error) {
		return `the GraphQL document ${(error as Error).message}`;
	}
}

function mutationRefusal(doc: DocumentNode, fragments: ReadonlyMap<string, SelectionSetNode>, variables: Record<string, unknown>): string | null {
	for (const op of doc.definitions) {
		if (op.kind !== Kind.OPERATION_DEFINITION || op.operation === "query") continue;
		if (op.operation !== "mutation") return `a GraphQL ${op.operation}`;
		// No prototype, so a variable named constructor or toString is only ever what the request gave or its default.
		const vars: Record<string, unknown> = Object.assign(Object.create(null), variables);
		for (const v of op.variableDefinitions ?? []) {
			if (!Object.hasOwn(vars, v.variable.name.value) && v.defaultValue !== undefined) vars[v.variable.name.value] = valueOf(v.defaultValue, Object.create(null));
		}
		for (const field of rootFields(op.selectionSet, fragments, new Set())) {
			if (field.name === "__typename") continue;
			if (!mutations.has(field.name)) return `the mutation ${field.name} is not on the allow-list`;
			const args = argumentsOf(field.arguments, vars);
			const input = args["input"] as Record<string, unknown> | undefined;
			const reason = eventRefusal(mutations.get(field.name), input?.["event"] ?? args["event"], `${field.name}'s event ${String(input?.["event"] ?? args["event"])}`);
			if (reason !== null) return reason;
		}
	}
	return null;
}

function rootFields(set: SelectionSetNode, fragments: ReadonlyMap<string, SelectionSetNode>, seen: ReadonlySet<string>): { name: string; arguments: readonly ArgumentNode[] }[] {
	return set.selections.flatMap((s) => {
		if (s.kind === Kind.FIELD) return [{ name: s.name.value, arguments: s.arguments ?? [] }];
		if (s.kind === Kind.INLINE_FRAGMENT) return rootFields(s.selectionSet, fragments, seen);
		const spread = fragments.get(s.name.value);
		return spread === undefined || seen.has(s.name.value) ? [] : rootFields(spread, fragments, new Set([...seen, s.name.value]));
	});
}

/** Throws on a name given twice, whose value GitHub may read from either. */
function argumentsOf(args: readonly { name: { value: string }; value: ValueNode }[], vars: Record<string, unknown>): Record<string, unknown> {
	const twice = args.find((a, i) => args.findIndex((b) => b.name.value === a.name.value) !== i);
	if (twice !== undefined) throw new Error(`names ${twice.name.value} twice`);
	return Object.fromEntries(args.map((a) => [a.name.value, valueOf(a.value, vars)]));
}

function valueOf(node: ValueNode, vars: Record<string, unknown>): unknown {
	switch (node.kind) {
		case Kind.VARIABLE:
			return Object.hasOwn(vars, node.name.value) ? vars[node.name.value] : undefined;
		case Kind.OBJECT:
			return argumentsOf(node.fields, vars);
		case Kind.LIST:
			return node.values.map((v) => valueOf(v, vars));
		case Kind.NULL:
			return null;
		case Kind.INT:
		case Kind.FLOAT:
			return Number(node.value);
		default:
			return node.value;
	}
}

function gitRefusal(method: string, path: string, request: GuardRequest, guard: GithubGuard): string | null {
	const row = git.find((r) => r.method === method && r.route.test(path));
	if (row === undefined) return `${method} ${path} on github.com is not git over HTTPS`;
	if (row.check === "service") return /^git-(upload|receive)-pack$/.test(request.url.searchParams.get("service") ?? "") ? null : "a ref list for no git service";
	if (row.check !== "push") return null;
	if (guard.defaultBranch === null) return "this pylon booted before Nexus told the guard its project's default branch, so it cannot tell a push to it from another. Start a new thread";
	const bytes = decodedBody(request);
	const refs = bytes === null ? null : pushedRefs(bytes);
	if (refs === null) return "the push's command list cannot be read";
	const same = (ref: string) => ref.normalize("NFC").toLowerCase();
	const branch = same(`refs/heads/${guard.defaultBranch}`);
	return refs.some((ref) => same(ref) === branch) ? `a push to the default branch ${guard.defaultBranch}` : null;
}

/**
 * The refs a git-receive-pack request updates: its pkt-line commands, `<old> <new> <ref>`, the first one followed by
 * NUL and the capabilities, up to the flush packet before the pack. Shallow lines may come first. A ref name is UTF-8,
 * as git writes it. Null for anything else, a signed push's certificate and a name that is not UTF-8 included.
 */
export function pushedRefs(body: Buffer): string[] | null {
	const refs: string[] = [];
	for (let i = 0; i + 4 <= body.length; ) {
		const head = body.subarray(i, i + 4).toString("latin1");
		if (!/^[0-9a-f]{4}$/i.test(head)) return null;
		const length = parseInt(head, 16);
		if (length === 0) return refs;
		if (length < 5 || i + length > body.length) return null;
		let line: string;
		try {
			line = utf8.decode(body.subarray(i + 4, i + length)).split("\0")[0]!.replace(/\n$/, "");
		} catch {
			return null;
		}
		i += length;
		if (/^shallow [0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line)) continue;
		const command = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
		if (command === null) return null;
		refs.push(command[3]!);
	}
	return null;
}
