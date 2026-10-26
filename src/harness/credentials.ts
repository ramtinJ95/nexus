/**
 * The harness's model login: a file-backed pi-ai CredentialStore and the installation's device ID, in one
 * JSON file such as /var/lib/nexus/harness-credentials.json. It is the harness's own login, never an
 * interactive pi's auth.json, because two processes refreshing one rotating refresh token lock each other out.
 *
 * Only the control-plane process opens the file, so the lock is in memory. pi-ai refreshes tokens inside
 * `modify`, which therefore runs one at a time per provider. Writes go to a fresh mode-0600 file that is
 * synced, renamed over the old one, and the directory synced, so a crash leaves either the old file or the new one.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AuthInteraction, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { ModelRef } from "@earendil-works/pi-durable";

const fileSchema = z.strictObject({
  /** Sent to OpenAI as the agent host ID at login, so it must never change. */
  deviceId: z.uuid(),
  credentials: z.record(z.string(), z.looseObject({ type: z.enum(["api_key", "oauth"]) })),
});
type CredentialFile = { deviceId: string; credentials: Readonly<Record<string, Credential>> };

export interface HarnessCredentials {
  store: CredentialStore;
  /** For pi-ai's `LoginOptions.getDeviceId`. */
  deviceId: string;
}

/**
 * Sign in with ChatGPT reaches only the models ChatGPT offers through Codex, and OpenAI refuses any other at the
 * first request. pi-ai's openai provider lists the API's whole catalog for either login, so its legacy Codex
 * provider's catalog, which is the ChatGPT subscription's, names them. Asking OpenAI instead takes a request.
 */
const chatGptModelIds: ReadonlySet<string> = new Set(Object.values(OPENAI_CODEX_MODELS).map((model) => model.id));

/** The models the harness may use: OpenAI, through Sign in with ChatGPT or an API key, from these credentials. */
export function harnessModels(credentials: HarnessCredentials): MutableModels {
  const models = createModels({ credentials: credentials.store });
  models.setProvider({
    ...openaiProvider(),
    filterModels: (all, credential) => credential?.type === "oauth" ? all.filter((model) => chatGptModelIds.has(model.id)) : all,
  });
  return models;
}

/**
 * Throws unless the harness's login reaches `model`, naming the models it does reach. Otherwise the control
 * plane starts, and every thread fails at its first turn. It reads only the stored login, so it costs no request.
 */
export async function requireModel(models: Models, model: ModelRef): Promise<void> {
  if (models.getProvider(model.provider) === undefined) {
    throw new Error(`harness.model names provider ${model.provider}, but the harness has only ${models.getProviders().map((p) => p.id).join(", ")}`);
  }
  const available = (await models.getAvailable(model.provider)).map((m) => m.id);
  if (available.includes(model.modelId)) return;
  if (available.length === 0) throw new Error(`the harness is not signed in to ${model.provider}, so it has no model. Sign it in with src/control/login.ts`);
  throw new Error(`harness.model ${model.modelId} is not offered to the harness's ${model.provider} login. It offers ${available.toSorted().join(", ")}`);
}

/**
 * The access token of the harness's Sign in with ChatGPT, which every probe is handed for the chatgpt login, or
 * undefined for an API key, which never leaves the control plane. It is refreshed with ten minutes left, so every probe
 * has the new token several handoffs before the old one expires.
 */
export async function chatgptToken(models: Models, credentials: HarnessCredentials): Promise<string | undefined> {
  if ((await credentials.store.read("openai"))?.type !== "oauth") return undefined;
  return (await models.getAuth("openai", { minOAuthValidityMs: 10 * 60_000 }))?.auth.apiKey;
}

/**
 * Sign in with ChatGPT, stored in the credentials. The browser's callback goes to port 1455 of the machine that
 * runs this, so from another machine paste the redirect URL into the `manual_code` prompt instead.
 */
export async function loginChatGpt(models: MutableModels, credentials: HarnessCredentials, interaction: AuthInteraction): Promise<void> {
  await models.login("openai", "oauth", interaction, { getDeviceId: () => credentials.deviceId, agentName: "Nexus" });
}

/** Creates the file with a new device ID when it is absent. A file that does not parse fails the open. */
export async function openCredentials(path: string): Promise<HarnessCredentials> {
  let state: CredentialFile;
  try {
    state = fileSchema.parse(JSON.parse(await readFile(path, "utf8"))) as CredentialFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path}: ${(err as Error).message}`);
    state = { deviceId: randomUUID(), credentials: {} };
    await write(path, state);
  }

  let writes: Promise<unknown> = Promise.resolve();
  /** Applies `change` to the state current when its turn comes, so writes for different providers cannot drop each other. */
  function commit(change: (credentials: CredentialFile["credentials"]) => CredentialFile["credentials"]): Promise<void> {
    const next = writes.then(async () => {
      const updated = { ...state, credentials: change(state.credentials) };
      await write(path, updated);
      state = updated;
    });
    writes = next.catch(() => undefined);
    return next;
  }

  const chains = new Map<string, Promise<unknown>>();
  function serialized<T>(providerId: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const queued = (chains.get(providerId) ?? Promise.resolve()).then(() => {
      signal?.throwIfAborted();
      return task();
    });
    const tail = queued.catch(() => undefined);
    chains.set(providerId, tail);
    tail.then(() => { if (chains.get(providerId) === tail) chains.delete(providerId); });
    return queued;
  }

  const store: CredentialStore = {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return state.credentials[providerId];
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return Object.entries(state.credentials).map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    modify(providerId, fn, options) {
      return serialized(providerId, options?.signal, async () => {
        const current = state.credentials[providerId];
        const next = await fn(current);
        if (next === undefined) return current;
        await commit((credentials) => ({ ...credentials, [providerId]: next }));
        return next;
      });
    },
    delete(providerId, options) {
      return serialized(providerId, options?.signal, () => commit(({ [providerId]: _removed, ...rest }) => rest));
    },
  };
  return { store, deviceId: state.deviceId };
}

async function write(path: string, state: CredentialFile): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(state, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  // Without this, a power loss can undo the rename and bring back a refresh token the provider already rotated.
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
