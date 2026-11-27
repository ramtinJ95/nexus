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

/** A tailnet login always holds an `@`, which the operator's name does not, so no login in `people` can be the operator. */
export const peopleSchema = z.record(z.string(), z.enum(["admin", "engineer"])).superRefine((people, ctx) => {
  for (const login of Object.keys(people)) {
    if (!/^[^@\s]+@[^@\s]+$/.test(login)) ctx.addIssue({ code: "custom", path: [login], message: `${login} must be a tailnet login, such as alice@example.com` });
  }
  if (!Object.values(people).includes("admin")) ctx.addIssue({ code: "custom", message: "must name at least one admin, who deploys" });
});

/** The one person of a solo install, and the owner the arc's first migration gives every thread that came before it. */
export const operator = "operator" as Person;

export type People = { shared: false } | { shared: true; roles: ReadonlyMap<Person, PersonRole> };

export const solo: People = { shared: false };

export const peopleOf = (people: z.infer<typeof peopleSchema> | undefined): People =>
  people === undefined ? solo : { shared: true, roles: new Map(Object.entries(people) as [Person, PersonRole][]) };

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
