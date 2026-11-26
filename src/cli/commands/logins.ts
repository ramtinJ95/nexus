import { buffer } from "node:stream/consumers";
import { loginKinds, loginRoutes, type LoginKind, type Logins } from "../../contract/logins.ts";
import { UsageError } from "../transport.ts";
import { request, table, type Command } from "../kit.ts";

const looks: Readonly<Record<LoginKind, { name: string; from: string }>> = {
  claude: { name: "Claude", from: "claude setup-token prints one" },
  github: { name: "GitHub", from: "a fine-grained token with contents and pull requests, read and write" },
};

function kindOf(arg: string): LoginKind {
  if ((loginKinds as readonly string[]).includes(arg)) return arg as LoginKind;
  throw new UsageError(`no login ${arg}: the logins are ${loginKinds.join(", ")}`);
}

const loginsText = (l: Logins) => `Logins of ${l.person}:\n${table(["Login", "State"], loginKinds.map((kind) => [kind, l.set[kind] ? "set" : "not set"]))}`;

export const loginsCommands: Readonly<Record<string, Command>> = {
  login: {
    help: [
      `  nexus login ${loginKinds.join("|")} < TOKEN`,
      `    store your own token, read from stdin, for your pylons; ${loginKinds.map((kind) => `${kind}: ${looks[kind].from}`).join("; ")}`,
    ],
    args: [1, 1],
    async run(api, [arg], _, __, { io }) {
      const kind = kindOf(arg!);
      if (io.stdin.isTTY === true) throw new UsageError(`nexus login ${kind} reads the token from stdin, so a terminal never shows it. Pipe it in, such as: pbpaste | nexus login ${kind}`);
      const token = (await buffer(io.stdin)).toString("utf8").trim();
      if (token === "") throw new UsageError(`nexus login ${kind} read no token from stdin`);
      const logins = await request(api, loginRoutes.set, { kind, body: { token } });
      return { json: logins, text: `Stored your ${looks[kind].name} token.\n${loginsText(logins)}` };
    },
  },
  logout: {
    help: [`  nexus logout ${loginKinds.join("|")}`, "    remove your own token of that kind"],
    args: [1, 1],
    async run(api, [arg]) {
      const kind = kindOf(arg!);
      const logins = await request(api, loginRoutes.remove, { kind });
      return { json: logins, text: `Removed your ${looks[kind].name} token, if one was set.\n${loginsText(logins)}` };
    },
  },
  logins: {
    help: ["  nexus logins", "    which of your own tokens the control plane holds, never their values"],
    args: [0, 0],
    async run(api) {
      const logins = await request(api, loginRoutes.list, {});
      return { json: logins, text: loginsText(logins) };
    },
  },
};
