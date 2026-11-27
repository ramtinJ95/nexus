import { HttpError } from "../http-error.ts";
import type { LoginStore } from "../logins.ts";
import type { People } from "../people.ts";
import { Refusal } from "../refusal.ts";
import type { Person } from "../../ids.ts";
import type { LoginKind } from "../../contract/logins.ts";
import { ownRoutes as routes, type Own } from "../../contract/own.ts";
import { chatgptTokenGrant, githubTokenGrant, maxSecretBytes, ownerGrants, ownerOnlyNames, secretHostPattern, secretNamePattern, tokenAlphabet } from "../../protocol/secret-grants.ts";
import { ok, on, type ApiKit, type RouteEntry } from "./kit.ts";
import type { Caller, Policy } from "./access.ts";

/**
 * A person adds hosts and secrets for their own pylons only, so no route names a person, and no node, pylon or the
 * control plane passes the person role. An admin lists each person's hosts and secret names, never a value. No refusal
 * repeats a value, or a name or host it turns down, since that may be a value pasted in the wrong place.
 */
const own = (action: string) => ({ role: "person", action }) satisfies Policy;
const listPeople = "list each person's hosts and secrets";
const maxGrantHosts = 16;

const soloInstall = () => new Refusal("conflict", "a solo install keeps no hosts or secrets of one person's. Its one person adds them to the project, with nexus project edit <id> --allow-host HOST and --secret NAME:HOST[,HOST...], and each secret's value goes in its node's secret file", "solo-install");

/** A person's host names one host, with no wildcard, so the list an admin reads is what it reaches. */
function hostOf(host: string): string {
  if (host.length > 253 || !secretHostPattern.test(host)) throw new HttpError(400, "a host is one lower-case hostname of two labels or more, at most 253 characters and with no wildcard, such as mcp.example.com");
  return host;
}

/** Why no person may add a secret of `name`, which a pylon gets elsewhere, or undefined. */
function reservedWhy(name: string): string | undefined {
  if (name === chatgptTokenGrant.name) return "the control plane holds it and hands it to the pylons of a project with the chatgpt login";
  if (!ownerOnlyNames.includes(name)) return undefined;
  const login = (Object.keys(ownerGrants) as LoginKind[]).find((kind) => ownerGrants[kind].name === name);
  return login === undefined ? "a pylon on a shared install takes it from no grant, since its owner's own nexus login is its only Claude or GitHub credential" : `your pylons get it from your own nexus login ${login}`;
}

function nameOf(name: string): string {
  if (!secretNamePattern.test(name)) throw new HttpError(400, "a secret's name is an environment variable's: upper-case letters, digits and _, not starting with a digit, such as MCP_TOKEN");
  const why = reservedWhy(name);
  if (why !== undefined) throw new HttpError(400, `${name} is a secret no person adds: ${why}`);
  return name;
}

/** The value and hosts of a body that is `{"value": string, "hosts": string[]}` and nothing else. A schema's refusal would quote a key, which may be the value. */
function secretOf(body: unknown): { value: string; hosts: readonly string[] } {
  const keys = typeof body === "object" && body !== null && !Array.isArray(body) ? Object.keys(body).sort() : [];
  const { value, hosts } = keys.length === 0 ? {} : body as { value?: unknown; hosts?: unknown };
  if (keys.join() !== "hosts,value" || typeof value !== "string" || !Array.isArray(hosts) || !hosts.every((host) => typeof host === "string")) {
    throw new HttpError(400, 'the body must be {"value": string, "hosts": [string, ...]} and nothing else');
  }
  return { value: value.trim(), hosts };
}

/** What the probe would refuse of `value` at its handoff, so it is refused here instead, or undefined. */
const valueFault = (value: string) => value.length > maxSecretBytes ? `a secret value is at most ${maxSecretBytes} bytes`
  : tokenAlphabet.test(value) ? undefined : "a secret value is a token: letters, digits and -._~+/ with optional = padding";

/**
 * Deduped and sorted. No person's secret goes to a GitHub host: a second GitHub credential there could hold what mp-08
 * keeps from an engineer's token, such as the workflows permission, and mp-15's guard takes the owner's GH_TOKEN for the
 * one GitHub credential in a pylon.
 */
function grantHostsOf(hosts: readonly string[]): string[] {
  const unique = [...new Set(hosts)].sort();
  if (unique.length === 0 || unique.length > maxGrantHosts) throw new HttpError(400, `a secret goes to 1 to ${maxGrantHosts} hosts`);
  unique.forEach(hostOf);
  const github = unique.filter((host) => githubTokenGrant.hosts.includes(host));
  if (github.length > 0) throw new HttpError(400, `a person's secret never goes to ${github.join(" or ")}: your pylons' one GitHub credential is your own nexus login github`);
  return unique;
}

export function ownRoutes(kit: Pick<ApiKit, "personAs">, people: People, store: LoginStore): readonly RouteEntry[] {
  const view = async (person: Person): Promise<Own> => ({ person, ...await store.own(person) });
  function personFor(r: Caller, action: string): Person {
    if (!people.shared) throw soloInstall();
    const person = kit.personAs(r);
    if (person === null) throw new Refusal("forbidden", `only a person in control.json's people may ${action}`);
    return person;
  }

  return [
    on(routes.list, own("read their own hosts and secrets"), async (_, r) => ok(await view(personFor(r, "read their own hosts and secrets")))),
    on(routes.addHost, own("add a host for their own pylons"), async ({ host }, r) => {
      const person = personFor(r, "add a host for their own pylons");
      await store.addHost(person, hostOf(host));
      return ok(await view(person));
    }),
    on(routes.removeHost, own("remove a host of their own"), async ({ host }, r) => {
      const person = personFor(r, "remove a host of their own");
      await store.removeHost(person, host);
      return ok(await view(person));
    }),
    on(routes.setSecret, own("set a secret for their own pylons"), async ({ name }, r) => {
      const person = personFor(r, "set a secret for their own pylons");
      const checked = nameOf(name);
      const { value, hosts } = secretOf(await r.body());
      const fault = valueFault(value);
      if (fault !== undefined) throw new HttpError(400, `the secret was not stored: ${fault}`);
      await store.setSecret(person, { name: checked, hosts: grantHostsOf(hosts), value });
      return ok(await view(person));
    }),
    on(routes.removeSecret, own("remove a secret of their own"), async ({ name }, r) => {
      const person = personFor(r, "remove a secret of their own");
      await store.removeSecret(person, name);
      return ok(await view(person));
    }),
    on(routes.people, { role: "admin", action: listPeople, solo: { role: "person", action: listPeople } }, async () => {
      if (!people.shared) throw soloInstall();
      const listed = [...people.roles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return ok({ people: await Promise.all(listed.map(async ([person, role]) => ({ person, role, ...await store.own(person) }))) });
    }),
  ];
}
