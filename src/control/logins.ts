/**
 * Each person's own credentials, one file for each person in a directory only the control plane's user reads. A person
 * sets a kind, removes it, and asks which kinds are set. Only `owned` hands a value back, to the control plane alone,
 * which delivers it to that person's own pylons. A GitHub login keeps the git identity GitHub gave for its token. The
 * same file keeps the hosts and the secrets a person adds for their own pylons, so a secret's name and its value are
 * written and lost together.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Person } from "../ids.ts";
import { gitIdentitySchema, type GitIdentity } from "../protocol/spawn.ts";
import { loginKinds, type LoginKind } from "../contract/logins.ts";
import type { Own, OwnSecret } from "../contract/own.ts";
import { tokenChecks } from "../deploy/credentials.ts";
import { Refusal } from "./refusal.ts";

type Stored = Partial<Record<LoginKind, string>> & { gitIdentity?: GitIdentity; hosts?: string[]; secrets?: Record<string, { hosts: string[]; value: string }> };

/** A login as it is set. A GitHub token comes with the name and address of the account GitHub says it belongs to. */
export type Login = { kind: "claude"; token: string } | { kind: "github"; token: string; identity: GitIdentity };

/** A secret a person added for their own pylons, with its value. */
export interface OwnedSecret extends OwnSecret { value: string }
/**
 * A person's logins as their pylons get them, and the hosts and secrets they added. A GitHub login stored before it kept
 * an identity counts as missing.
 */
export interface Owned { claude?: string; github?: { token: string; identity: GitIdentity }; hosts: readonly string[]; secrets: readonly OwnedSecret[] }

/** How many hosts and secrets one person may add for their own pylons. */
export const ownCaps = { hosts: 64, secrets: 32 } as const;

export interface LoginStore {
  set(person: Person, login: Login): Promise<void>;
  /** Removing a kind that is not set leaves the store as it was. */
  remove(person: Person, kind: LoginKind): Promise<void>;
  kinds(person: Person): Promise<Record<LoginKind, boolean>>;
  /** For the control plane's own use at a thread's start and handoff. No route, log line or refusal carries what it reads. */
  owned(person: Person): Promise<Owned>;
  /** The hosts and the secrets' names and hosts the person added, never a value. */
  own(person: Person): Promise<Omit<Own, "person">>;
  /** Adding a host that is there, or removing one that is not, leaves the store as it was. Past `ownCaps` it is refused. */
  addHost(person: Person, host: string): Promise<void>;
  removeHost(person: Person, host: string): Promise<void>;
  /** Takes the place of the person's secret of that name, if they have one. Past `ownCaps` a new name is refused. */
  setSecret(person: Person, secret: OwnedSecret): Promise<void>;
  removeSecret(person: Person, name: string): Promise<void>;
}

/** What is wrong with `token` as a `kind`, in words that never repeat it, or undefined. */
export const tokenFault = (kind: LoginKind, token: string): string | undefined =>
  token.length > 4096 ? "a token is at most 4096 characters" : tokenChecks[kind](token);

/** Why GitHub gave no identity for a token, in words that never repeat it. `refused`: GitHub answered and turned the token down. */
export class NoGithubIdentity extends Error {
  readonly refused: boolean;
  constructor(message: string, refused: boolean) {
    super(message);
    this.refused = refused;
  }
}

/**
 * The git identity of the account a GitHub token belongs to, read from GET /user: its name, or its login when it has
 * none, and its public address, or else the no-reply address GitHub gives every account, so no address is made up.
 */
export async function githubIdentity(token: string, request: typeof fetch = fetch): Promise<GitIdentity> {
  let response: Response;
  try {
    response = await request("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
  } catch (err) {
    throw new NoGithubIdentity(`GitHub could not be reached to read whose token it is (${(err as Error).name})`, false);
  }
  if (response.status === 401 || response.status === 403) throw new NoGithubIdentity(`GitHub refused the token with ${response.status}`, true);
  if (!response.ok) throw new NoGithubIdentity(`GitHub answered GET /user with ${response.status}`, false);
  const user = await response.json().catch(() => null) as { id?: unknown; login?: unknown; name?: unknown; email?: unknown } | null;
  if (typeof user?.id !== "number" || typeof user.login !== "string" || user.login === "") throw new NoGithubIdentity("GitHub's GET /user named no account", false);
  const identity = gitIdentitySchema.safeParse({
    name: typeof user.name === "string" && user.name.trim() !== "" ? user.name : user.login,
    email: typeof user.email === "string" && user.email !== "" ? user.email : `${user.id}+${user.login}@users.noreply.github.com`,
  });
  if (!identity.success) throw new NoGithubIdentity(`GitHub's account ${user.login} has a name or address git cannot take`, false);
  return identity.data;
}

/** `stored` without its empty lists, so a person who has set nothing has no file. */
function tidy({ hosts, secrets, ...rest }: Stored): Stored {
  return { ...rest, ...hosts !== undefined && hosts.length > 0 ? { hosts } : {}, ...secrets !== undefined && Object.keys(secrets).length > 0 ? { secrets } : {} };
}

const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const full = (what: string, cap: number, remove: string) => new Refusal("conflict", `a person adds at most ${cap} ${what}, and you have ${cap}. Remove one first with ${remove}`);

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
      const stored = tidy(edit(await read(person)));
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
    set: (person, login) => change(person, (stored) => login.kind === "github"
      ? { ...stored, github: login.token, gitIdentity: login.identity } : { ...stored, claude: login.token }),
    remove: (person, kind) => change(person, (stored) => {
      const { [kind]: _, ...rest } = stored;
      if (kind === "github") delete rest.gitIdentity;
      return rest;
    }),
    async kinds(person) {
      const stored = await read(person);
      return Object.fromEntries(loginKinds.map((kind) => [kind, typeof stored[kind] === "string"])) as Record<LoginKind, boolean>;
    },
    async owned(person) {
      const { claude, github, gitIdentity, hosts = [], secrets = {} } = await read(person);
      return {
        ...typeof claude === "string" ? { claude } : {}, ...typeof github === "string" && gitIdentity !== undefined ? { github: { token: github, identity: gitIdentity } } : {},
        hosts, secrets: Object.entries(secrets).map(([name, { hosts, value }]) => ({ name, hosts, value })).sort(byName),
      };
    },
    async own(person) {
      const { hosts = [], secrets = {} } = await read(person);
      return { hosts, secrets: Object.entries(secrets).map(([name, { hosts }]) => ({ name, hosts })).sort(byName) };
    },
    addHost: (person, host) => change(person, (stored) => {
      const hosts = stored.hosts ?? [];
      if (hosts.includes(host)) return stored;
      if (hosts.length >= ownCaps.hosts) throw full("hosts", ownCaps.hosts, "nexus host remove");
      return { ...stored, hosts: [...hosts, host].sort() };
    }),
    removeHost: (person, host) => change(person, (stored) => ({ ...stored, hosts: (stored.hosts ?? []).filter((h) => h !== host) })),
    setSecret: (person, { name, hosts, value }) => change(person, (stored) => {
      const secrets = stored.secrets ?? {};
      if (!Object.hasOwn(secrets, name) && Object.keys(secrets).length >= ownCaps.secrets) throw full("secrets", ownCaps.secrets, "nexus secret remove");
      return { ...stored, secrets: { ...secrets, [name]: { hosts: [...hosts], value } } };
    }),
    removeSecret: (person, name) => change(person, (stored) => {
      const { [name]: _, ...secrets } = stored.secrets ?? {};
      return { ...stored, secrets };
    }),
  };
}
