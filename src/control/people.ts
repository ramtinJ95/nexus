/**
 * Who uses this install, decided once at startup from control.json's `people`. Without it the install is solo: the
 * operator is its one person and owns every thread, and `callers` and `deployers` admit devices as before. With it the
 * install is shared: a caller is a person by their tailnet login, as admin or engineer. Modules branch on `shared`
 * here, never on the config.
 */
import { z } from "zod";
import type { Person } from "../ids.ts";
import type { TailnetIdentity } from "../node-base/tailscaled.ts";
import { Refusal } from "./refusal.ts";

export type PersonRole = "admin" | "engineer";

const role = z.enum(["admin", "engineer"]);
/** How many pylons a person may run at once when `people` gives them no `pylonCap`. Each holds its memory until it pauses. */
export const defaultPylonCap = 2;

/**
 * Each person's role, or their role and how many pylons they may run at once. A tailnet login always holds an `@`, which
 * the operator's name does not, so no login in `people` can be the operator.
 */
export const peopleSchema = z.record(z.string(), z.union([role, z.strictObject({ role, pylonCap: z.int().positive() })], { error: 'must be "admin" or "engineer", or { "role": "admin" or "engineer", "pylonCap": the number of pylons they may run at once, 1 or more }' })).superRefine((people, ctx) => {
  for (const login of Object.keys(people)) {
    if (!/^[^@\s]+@[^@\s]+$/.test(login)) ctx.addIssue({ code: "custom", path: [login], message: `${login} must be a tailnet login, such as alice@example.com` });
  }
  if (!Object.values(people).some((p) => p === "admin" || (typeof p === "object" && p.role === "admin"))) ctx.addIssue({ code: "custom", message: "must name at least one admin, who deploys" });
});

export { operator } from "../ids.ts";

export type People = { shared: false } | { shared: true; roles: ReadonlyMap<Person, PersonRole>; pylonCaps: ReadonlyMap<Person, number> };

export const solo: People = { shared: false };

export function peopleOf(people: z.infer<typeof peopleSchema> | undefined): People {
  if (people === undefined) return solo;
  const entries = Object.entries(people).map(([login, p]) => [login as Person, typeof p === "string" ? { role: p, pylonCap: defaultPylonCap } : p] as const);
  return { shared: true, roles: new Map(entries.map(([person, p]) => [person, p.role])), pylonCaps: new Map(entries.map(([person, p]) => [person, p.pylonCap])) };
}

export interface PylonCap { person: Person; pylons: number }
/** How many pylons a thread's owner may run at once. Null for no cap: the operator, who owns every thread of a solo install. */
export function pylonCapOf(people: People, owner: Person): PylonCap | null {
  const pylons = people.shared ? people.pylonCaps.get(owner) : undefined;
  return pylons === undefined ? null : { person: owner, pylons };
}

/** The person and role a device's identity names on a shared install, or null for a tagged device or a login not in `people`. */
export function personOf(people: Extract<People, { shared: true }>, identity: TailnetIdentity): { person: Person; role: PersonRole } | null {
  if (identity.user === null) return null;
  const role = people.roles.get(identity.user as Person);
  return role === undefined ? null : { person: identity.user as Person, role };
}

/** Who starts or queues a thread: the device or role name its `startedBy` records, and the person who owns it. */
export interface Starter { caller: string; owner: Person }

/** What refuses every landing on a shared install, whoever asks for it, since Nexus never merges there. */
export const landingOff = () => new Refusal("forbidden", "Nexus never merges on a shared install, so it lands no pull request. An engineer merges it on GitHub", "landing-off");
/** What a person runs in place of the harness on a shared install, which a start's refusal names. */
export const pylonAgentAdvice = "The one agent a thread can run there is Claude Code, in its pylon on its owner's own login: name it with claude, as nexus start --claude does";
/**
 * What refuses a person's work that the control plane's own agent, the harness, would run on the install's one model
 * login, which a shared install keeps for failure judgments: a thread with no pylon agent, a planning thread, a
 * `message` brief, and a harness retry. `what` names the work, and `instead` what the person does.
 */
export const pylonAgentsOnly = (what: string, instead = pylonAgentAdvice) =>
  new Refusal("forbidden", `${what}. On a shared install the control plane's own agent runs no person's work, since it would spend the install's one model login. ${instead}`, "pylon-agents-only");
