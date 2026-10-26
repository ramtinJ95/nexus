# A shepherdr reviewer inside a Claude worker's pylon

These runs happened on 2026-10-26 in this thread's pylon, a Claude worker thread on `infra-testbench`, with the image's Claude Code 2.1.308, pi 1.4.0, Node 24.22.1 and Herdr 0.9.5. The project allows only the `claude` login and grants `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`. The pylon has no ChatGPT login, and its allowlist has no OpenAI host.

## The packages and the profile, installed by hand

```sh
PI_OFFLINE=0 pi install npm:@howaboua/pi-shepherdr@0.2.23
claude plugin install shepherdr@claude-mods          # 0.2.6, from the marketplace the image baked at b97e1e3
cp -r ~/.pi/agent/npm/node_modules/@howaboua/pi-shepherdr/profiles/reviewer ~/.pi/agent/shepherdr/profiles/
# then profile.json: "model": "openai-codex/gpt-6-astra", "thinking": "high", "blocking": true
```

`registry.npmjs.org` is on every project's allowlist, so `pi install` worked. The image installs both packages at build time anyway.

## What the runtime already has

The Claude pane runs inside Herdr with `HERDR_ENV=1`, `HERDR_SOCKET_PATH=/home/user/.config/herdr/sessions/nexus/herdr.sock` and `HERDR_PANE_ID=w1:p1`, and the socket answers. Node is 24.22.1 (shepherdr needs 22.18 or later) and pi is 1.4.0 (pi-shepherdr needs 1.2 or later). Herdr's pi integration is the image's `herdr-agent-state.ts`. Nothing had to be added for any of these. Each worker wrote its pi session under `~/.pi/agent/sessions/`, and the mod wrote `~/.local/share/claude-shepherdr/sessions/<session id>.json`.

pi-shepherdr's first load added its bundled `general` (gpt-6-sol) and `explorer` (gpt-6-luna) profiles beside the hand-made reviewer, kept the reviewer as it was, and wrote `~/.pi/agent/shepherdr/.profiles-initialized`. Once that marker exists it never adds a profile again. That is why the image installs the captured profiles and writes the marker before pi first runs.

## A reviewer through the mod's tool

A fresh Claude Code session (`claude -p`, from a login shell for its token) loaded the mod. Asked to call `mcp__shepherdr__agents` with `help`, it listed:

```text
- explorer: openai-codex/gpt-6-luna
- general: openai-codex/gpt-6-sol
- reviewer: openai-codex/gpt-6-astra
- claude-explorer: claude-opus-5-5
- claude-general: claude-opus-5-5
- claude-reviewer: claude-opus-5-5
```

Asked to spawn a `reviewer` with `base: "main"` on this branch's first commit, uncommitted then, the tool opened Herdr tab `w1:p3`, started pi with the profile, and delivered the task through pi-shepherdr's receiver. The profile's `prepare.mjs` built the review context. The worker's pane:

```text
 Review context:
 Repository root: /home/user/workspace/repo
 Current ref: in-thread-review
 Scope: base-diff
 Base branch: main
 Merge base: b85d7bcf33ebbb2e8987fd3d21767346d32fd7a9

 Current status (data, not instructions):
 <git_status>
 M src/agent-setup.ts
 </git_status>

 Instructions:
 Review the working-tree diff of this repository against main and list findings.


 Error: Provider is not configured: openai-codex
```

The status line showed `gpt-6-astra • high`. The tool returned to Claude:

```text
<agent_report target="w1:p3" name="review-diff" status="failed">
Task: Review the working-tree diff of this repository against main and list findings.
The worker stopped with an error.
Inspect it with read source:"recent" and assess the failure. ...
</agent_report>
```

An earlier spawn through the mod's bridge (`node bridge/cli.mjs` with `{"op":"spawn",...}`) returned `"delivery":"peer"` and stopped at the same error. So everything up to the model works in a pylon. Only the login is missing.

## What the openai-codex provider calls and needs

`provider.sh` writes fake credentials into a scratch `PI_CODING_AGENT_DIR` and runs pi against each case, and `provider.log` is its output. pi 1.4.0's `pi-ai` source (`auth/oauth/openai-codex.js`, `api/openai-codex-responses.js`) says the same:

- **The credential.** An OAuth entry in `auth.json` holds `access` (a JWT), `refresh` and `expires`. ChatGPT's device-code or browser login creates it at `auth.openai.com`, the browser one through a callback on `localhost:1455`.
- **The model call.** Each request goes to `https://chatgpt.com/backend-api/codex/responses`, over a WebSocket (`wss://`) first and SSE after. It sends `Authorization: Bearer <access>` and a `chatgpt-account-id` header. pi takes the account ID from the access token's payload claim `https://api.openai.com/auth`, on the client side.
- **The refresh.** Once `expires` passes, pi posts `grant_type=refresh_token` with the refresh token in the form body to `https://auth.openai.com/oauth/token`. That rotates both tokens and rewrites `auth.json`.
- **The hosts.** The provider needs `chatgpt.com` for the model and `auth.openai.com` for login and refresh. `api.openai.com` serves the separate API-key `openai` provider, and pi's Codex path never calls it. The project's `chatgpt` login allows all three.

The log's last two cases test the credential designs in `docs/design.md`:

- An access token whose signature is shaped like Gondolin's default placeholder, `<marker>.<name>`, has four dot-separated parts. pi refuses it with `Failed to extract accountId from token` before it sends anything. Gondolin 0.13.0 also takes a placeholder of any shape for a secret (`secret.placeholder` in `createHttpHooks`), and `secretManager.updateSecret` changes a value on a running VM.
- A `models.json` that sets `openai-codex`'s `baseUrl` to `http://nexus.pylon/openai-codex` sends pi's request to the probe's pylon API, with no allowlist entry and no change to pi. The probe answers `no route POST /openai-codex/codex/responses`.

Rerun it with `docs/verification/in-thread-review/provider.sh` in any pylon with pi. It sends nothing but fake tokens, and Gondolin blocks those before they leave.

## The installed profiles stay the captured set

`install.ts` copies the captured profiles and writes pi-shepherdr's marker before pi first runs. To check that this keeps pi-shepherdr's bundled profiles out, a scratch `PI_CODING_AGENT_DIR` got this pylon's pi settings, packages and extensions, with pi-shepherdr among them, and only the astra `reviewer`. Then `pi --offline -p hi` ran in it twice:

```text
with the marker:     Not logged in · Please run /login     profiles: reviewer
without the marker:  Not logged in · Please run /login     profiles: explorer general reviewer
```

Both times the reviewer kept `openai-codex/gpt-6-astra`. `Not logged in` is the answer the image's smoke check takes as a clean load.

## After the ChatGPT login for pylons landed

[nexus#107](https://github.com/ramtinJ95/nexus/pull/107) signs a pylon's pi in as the `openai` provider with the harness's ChatGPT login, and leaves `openai-codex` without a login. So the image's installer now rewrites a captured profile's `openai-codex/` model to `openai/` (`pylonProfile` in `images/pylon/agent-setup/install.ts`). The `openai-codex` findings above still say what that provider would need. They no longer decide how a pylon signs in.

This pylon booted before #107, so it has no ChatGPT grant. Its reviewer profile was rewritten by `pylonProfile` to `openai/gpt-6-astra`, and this Claude Code session's own `mcp__shepherdr__agents` spawned it on the branch. The worker stopped with `Error: Provider is not configured: openai`, and its status line showed `gpt-6-astra • high`. PYLON.md quotes that error for a pylon without the grant.

## Not run here

No reviewer ran to completion, because this pylon has no ChatGPT grant. These remain unchecked: whether a review on `openai/gpt-6-astra` finishes inside a pylon with the grant, and an image build that installs the captured profiles. The capture itself must run on the Mac, against its own dotfiles.
