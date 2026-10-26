# pi's ChatGPT login through a placeholder

`run.sh` ran in this thread's pylon on 2026-10-26 and wrote `run.log`. pi 1.4.0 used a copy of this pylon's pi setup under a scratch HOME. Its requests to OpenAI were real and went out through this pylon's own Gondolin.

This pylon has no Gondolin VM of its own, because its guest has no KVM, so `host.mjs` stands in for a pylon's controller. It is an HTTPS proxy that terminates TLS with a scratch CA and applies Gondolin 0.13.0's own `createHttpHooks` to each request, with the secret `NEXUS_CHATGPT_TOKEN` granted for `api.openai.com`, as a controller applies them. pi reached it through `HTTPS_PROXY`, which pi's HTTP client honours. The secret's value is a fake token made for the run, and `updateSecret` changes it, as a probe's handoff does. The real harness token was not used, because only the live control plane holds it.

The boot hook is the branch's own `piChatgptLoginCommand()`, run with the placeholder in `NEXUS_CHATGPT_TOKEN`, as a login shell in a pylon has it.

What the log shows:

1. The hook added the `openai` entry, with the placeholder as its access token, an empty refresh token and an expiry in 2100, and kept the unrelated entry already in `auth.json`.
2. pi accepted it and sent `Authorization: Bearer <placeholder>` to `api.openai.com/v1/responses`. It did not try a refresh. The host swapped in the value, and OpenAI answered 401 for it, quoting the value's first 8 and last 4 characters. After `updateSecret`, the same unchanged `auth.json` reached OpenAI with the new value.
3. The placeholder sent to `auth.openai.com`, a host the grant leaves out, was refused before it left.
4. `openai-codex/gpt-6-astra` has no login in the pylon.
5. While OpenAI's answer was held for 5 seconds, `scan.py` ran as root and searched pi's environment, command line and every readable memory region, and the files under its HOME. It found the placeholder in pi's memory, and the value nowhere. In the host process it found both, which shows that the search finds the value where the value is.

Rerun it with `docs/verification/chatgpt-credential/run.sh` from the repository, in a pylon whose project allows `api.openai.com`. It needs `sudo` for the memory search, and sends OpenAI only fake tokens.

## Not run here

- A request that succeeds. That needs the harness's real token, which only the control plane holds. The 401 for a fake value shows that the value reached OpenAI where the placeholder was, and the harness already runs `openai/gpt-6-astra` on the real token.
- A real pylon VM, a real probe, and the control plane's handoff. The unit tests cover the controller's `update-secret` against Gondolin's hooks, the probe's `PUT /v1/secrets/NEXUS_CHATGPT_TOKEN`, and the control plane's poll.
- A WebSocket. pi's `openai` provider streams over HTTPS with server-sent events and opens none. Gondolin 0.13.0 runs the same request hooks, the swap among them, on a WebSocket upgrade (`dist/src/qemu/http.js`), which pi's `openai-codex` provider would need. That was read in the source, not run.
