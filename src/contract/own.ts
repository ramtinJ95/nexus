/** It imports only route.ts at run time, so a browser can bundle it. */
import { route } from "./route.ts";

export interface OwnSecret { name: string; hosts: readonly string[] }
/** What a person added for their own pylons, as every route answers it: names and hosts, never a value. */
export interface Own { person: string; hosts: readonly string[]; secrets: readonly OwnSecret[] }
export interface PersonAdded extends Own { role: "admin" | "engineer" }
export interface PeopleAdded { people: readonly PersonAdded[] }

export const ownRoutes = {
  list: route<Own>()("GET", "/v1/own"),
  addHost: route<Own>()("PUT", "/v1/own/hosts/{host}"),
  removeHost: route<Own>()("DELETE", "/v1/own/hosts/{host}"),
  setSecret: route<Own, { value: string; hosts: string[] }>()("PUT", "/v1/own/secrets/{name}"),
  removeSecret: route<Own>()("DELETE", "/v1/own/secrets/{name}"),
  people: route<PeopleAdded>()("GET", "/v1/people"),
} as const;
