/**
 * Each person's own credentials, one file for each person in a directory only the control plane's user reads. Nothing
 * here hands a value back: a person sets a kind, removes it, and asks which kinds are set.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Person } from "../ids.ts";
import { loginKinds, type LoginKind } from "../contract/logins.ts";
import { tokenChecks } from "../deploy/credentials.ts";

type Stored = Partial<Record<LoginKind, string>>;

export interface LoginStore {
  set(person: Person, kind: LoginKind, token: string): Promise<void>;
  /** Removing a kind that is not set leaves the store as it was. */
  remove(person: Person, kind: LoginKind): Promise<void>;
  kinds(person: Person): Promise<Record<LoginKind, boolean>>;
}

/** What is wrong with `token` as a `kind`, in words that never repeat it, or undefined. */
export const tokenFault = (kind: LoginKind, token: string): string | undefined =>
  token.length > 4096 ? "a token is at most 4096 characters" : tokenChecks[kind](token);

/** The two writes a change makes, which a test fails partway. */
type Writes = { writeFile: typeof writeFile; rename: typeof rename };

export function loginStore(dir: string, io: Writes = { writeFile, rename }): LoginStore {
  // A login holds an @ and may hold a slash, so the name is encoded, and no login names a file outside `dir`.
  const fileOf = (person: Person) => join(dir, `${encodeURIComponent(person)}.json`);
  /** Each person's writes, one after another, so two at once do not lose one of them. */
  const writes = new Map<Person, Promise<void>>();

  async function read(person: Person): Promise<Stored> {
    try {
      return JSON.parse(await readFile(fileOf(person), "utf8")) as Stored;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`the logins of ${person} cannot be read: ${(err as NodeJS.ErrnoException).code ?? "not JSON"}`);
    }
  }

  function change(person: Person, edit: (stored: Stored) => Stored): Promise<void> {
    const next = (writes.get(person) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const stored = edit(await read(person));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (Object.keys(stored).length === 0) return void await rm(fileOf(person), { force: true });
      const partial = `${fileOf(person)}.${randomUUID()}.partial`;
      try {
        await io.writeFile(partial, `${JSON.stringify(stored)}\n`, { flag: "wx", mode: 0o600 });
        await io.rename(partial, fileOf(person));
      } finally {
        await rm(partial, { force: true });
      }
    });
    writes.set(person, next);
    return next;
  }

  return {
    set: (person, kind, token) => change(person, (stored) => ({ ...stored, [kind]: token })),
    remove: (person, kind) => change(person, ({ [kind]: _, ...rest }) => rest),
    async kinds(person) {
      const stored = await read(person);
      return Object.fromEntries(loginKinds.map((kind) => [kind, typeof stored[kind] === "string"])) as Record<LoginKind, boolean>;
    },
  };
}
