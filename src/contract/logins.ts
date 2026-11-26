/** It imports only route.ts at run time, so a browser can bundle it. */
import { route } from "./route.ts";

/** What a person signs in to once, and the control plane keeps for their own pylons. */
export const loginKinds = ["claude", "github"] as const;
export type LoginKind = (typeof loginKinds)[number];

/** Which kinds the person has set. A route never answers a stored value. */
export interface Logins { person: string; set: Record<LoginKind, boolean> }

export const loginRoutes = {
  list: route<Logins>()("GET", "/v1/logins"),
  set: route<Logins, { token: string }>()("PUT", "/v1/logins/{kind}"),
  remove: route<Logins>()("DELETE", "/v1/logins/{kind}"),
} as const;
