import { HttpError } from "../http-error.ts";
import { tokenFault, type LoginStore } from "../logins.ts";
import { loginKinds, loginRoutes as routes, type LoginKind } from "../../contract/logins.ts";
import { ok, on, type ApiKit, type RouteEntry } from "./kit.ts";
import { Refusal } from "../refusal.ts";
import type { Person } from "../../ids.ts";
import type { Caller, Policy } from "./access.ts";

/**
 * A person reads, sets and removes only their own logins, so no route names a person. No node, pylon or the control
 * plane passes the person role.
 */
const own = (action: string) => ({ role: "person", action }) satisfies Policy;

/** The token of a body that is `{"token": string}` and nothing else. A schema's refusal would quote a key, which may be the token. */
function tokenOf(body: unknown): string {
  const keys = typeof body === "object" && body !== null && !Array.isArray(body) ? Object.keys(body) : [];
  const token = (body as { token?: unknown } | null)?.token;
  if (keys.length !== 1 || typeof token !== "string") throw new HttpError(400, 'the body must be {"token": string} and nothing else');
  return token.trim();
}

function kindOf(kind: string): LoginKind {
  if ((loginKinds as readonly string[]).includes(kind)) return kind as LoginKind;
  throw new HttpError(404, `no login ${kind}: the logins are ${loginKinds.join(", ")}`);
}

export function loginRoutes(kit: Pick<ApiKit, "personAs">, store: LoginStore): readonly RouteEntry[] {
  const view = async (person: Person) => ok({ person, set: await store.kinds(person) });
  function personFor(r: Caller, action: string): Person {
    const person = kit.personAs(r);
    if (person === null) throw new Refusal("forbidden", `only a person in control.json's people may ${action}`);
    return person;
  }

  return [
    on(routes.list, own("read their logins"), (_, r) => view(personFor(r, "read their logins"))),
    on(routes.set, own("set a login"), async (params, r) => {
      const kind = kindOf(params.kind);
      const person = personFor(r, "set a login");
      const token = tokenOf(await r.body());
      const fault = tokenFault(kind, token);
      if (fault !== undefined) throw new HttpError(400, `the ${kind} token was not stored: ${fault}`);
      await store.set(person, kind, token);
      return view(person);
    }),
    on(routes.remove, own("remove a login"), async (params, r) => {
      const kind = kindOf(params.kind);
      const person = personFor(r, "remove a login");
      await store.remove(person, kind);
      return view(person);
    }),
  ];
}
