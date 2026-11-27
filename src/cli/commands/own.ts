import { buffer } from "node:stream/consumers";
import { ownRoutes, type Own, type OwnSecret } from "../../contract/own.ts";
import { UsageError } from "../transport.ts";
import { request, table, type Command } from "../kit.ts";

const listed = (items: readonly string[], by: string) => items.length === 0 ? "none" : items.join(by);
const secretText = (secret: OwnSecret) => `${secret.name} → ${secret.hosts.join(", ")}`;
const ownText = (own: Own) => `Hosts and secrets of ${own.person}, for their own pylons from each one's start:\nhosts: ${listed(own.hosts, ", ")}\nsecrets: ${listed(own.secrets.map(secretText), "; ")}`;

export const ownCommands: Readonly<Record<string, Command>> = {
  own: {
    help: ["  nexus own", "    the hosts and secrets you added for your own pylons, by name and host, never a value"],
    args: [0, 0],
    async run(api) {
      const own = await request(api, ownRoutes.list, {});
      return { json: own, text: ownText(own) };
    },
  },
  "host add": {
    help: ["  nexus host add <host>", "    let your own pylons reach <host>, one hostname, from their next start"],
    args: [1, 1],
    async run(api, [host]) {
      const own = await request(api, ownRoutes.addHost, { host: host! });
      return { json: own, text: `Your pylons reach ${host} from their next start. A running pylon keeps the hosts it started with.\n${ownText(own)}` };
    },
  },
  "host remove": {
    help: ["  nexus host remove <host>", "    stop your new pylons reaching <host>; a running pylon keeps the hosts it started with"],
    args: [1, 1],
    async run(api, [host]) {
      const own = await request(api, ownRoutes.removeHost, { host: host! });
      return { json: own, text: `Removed ${host}, if you had added it. A running pylon keeps the hosts it started with.\n${ownText(own)}` };
    },
  },
  "secret set": {
    help: ["  nexus secret set <NAME> <host>... < VALUE", "    give your own pylons the secret NAME, read from stdin, which they send only to each <host>, from their next start"],
    args: [2, 17],
    async run(api, [name, ...hosts], _, __, { io }) {
      if (io.stdin.isTTY === true) throw new UsageError(`nexus secret set reads the value from stdin, so a terminal never shows it. Pipe it in, such as: pbpaste | nexus secret set ${name} ${hosts.join(" ")}`);
      const value = (await buffer(io.stdin)).toString("utf8").trim();
      if (value === "") throw new UsageError("nexus secret set read no value from stdin");
      const own = await request(api, ownRoutes.setSecret, { name: name!, body: { value, hosts } });
      return { json: own, text: `Stored your secret ${name}. Your pylons get it from their next start, and a running one gets a changed value when its node's probe next restarts.\n${ownText(own)}` };
    },
  },
  "secret remove": {
    help: ["  nexus secret remove <NAME>", "    remove your secret NAME; a running pylon keeps its value until its node's probe restarts"],
    args: [1, 1],
    async run(api, [name]) {
      const own = await request(api, ownRoutes.removeSecret, { name: name! });
      return { json: own, text: `Removed your secret ${name}, if you had one. A running pylon keeps its value until its node's probe restarts.\n${ownText(own)}` };
    },
  },
  people: {
    help: ["  nexus people", "    each person's role and the hosts and secrets they added, by name and host, never a value; for an admin"],
    args: [0, 0],
    async run(api) {
      const { people } = await request(api, ownRoutes.people, {});
      return { json: { people }, text: table(["Person", "Role", "Hosts", "Secrets"], people.map((p) => [p.person, p.role, listed(p.hosts, ", "), listed(p.secrets.map(secretText), "; ")])) };
    },
  },
};
