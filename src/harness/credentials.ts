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
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

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
