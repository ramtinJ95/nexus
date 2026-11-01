/** The CLI's help text, whole for --help and by command for each command's --help. */
import { sessionHarnessSchema } from "../session-harness.ts";
import { version } from "../version.ts";
import { configFile } from "./config.ts";

export const usage = `nexus ${version}, the Nexus control plane from this Mac

  nexus connect <host>                         find the control plane on a tailnet name or URL, save it, and say what this device may do
  nexus events [--follow] [--since ID] [--thread T] [--project P] [--kind K]...
  nexus threads [--project P] [--all] [--queued]
    threads, then queued ones; deleted ones and cancelled queued ones only with --all, and --queued lists only queued ones
  nexus show <thread>                          a thread with its pylon, sessions, previews and outputs
  nexus ports <thread>                         the TCP ports the pylon listens on, and each one's preview
  nexus preview <thread> <port> [--wait]       publish a port as a preview, and print its URL
  nexus unpreview <thread> <port>              stop publishing a port that preview published
  nexus files <thread> [path]                  a directory of the pylon's checkout
  nexus changes <thread> [--uncommitted | --turn]       the files changed since boot, HEAD, or the latest turn
  nexus diff <thread> [path...] [--uncommitted | --turn]
  nexus conversation <thread>                  the agent's transcript, or the Claude worker's
  nexus session open <thread> [--harness ${sessionHarnessSchema.options.join("|")}] [--title T]
  nexus session close <thread> <pane|id>       a session in no pane by its ID, which \`nexus show\` gives
  nexus attach <thread>                        this terminal on the pylon's Herdr sessions, through the control plane
  nexus start --project P [--title T] [--message M | --claude PROMPT [--model ID]] [--node N|auto] [--branch B] [--commit C]
              [--cpus n] [--memory GiB] [--disk GiB] [--after THREAD[,THREAD...]] [--request-id ID] [--plan]
    --after queues it to start once each of those threads' pull requests has merged
    --plan makes it a planning thread, whose proposed items become questions you accept or reject
    --request-id makes a repeat of the start answer the thread the first made
  nexus start-queued <thread>                  start a queued thread now, without waiting for the threads it is queued after
  nexus items [--project P] [--all]            pipeline items and the phase each is in; cancelled ones only with --all
  nexus item add --project P [--title T] (--message M | --claude PROMPT [--model ID]) [--after ITEM[,ITEM...]]
                 [--node N|auto] [--branch B] [--commit C] [--cpus n] [--memory GiB] [--disk GiB]
    an item becomes a queued thread once the items it is after are, and starts once their pull requests merge
  nexus item show <item>                       an item with its phase, its thread and its brief
  nexus item approve <item>                    let an item become a thread, in a project whose pipeline waits for approval
  nexus item cancel <item>                     an item that is not a thread yet, which then never becomes one
  nexus send <thread> <text...> [--steer] [--request-id ID]
    a message to the agent, or typed into the Claude worker's session, which waits for a paused pylon to wake
  nexus watch <thread> [--interval MS]         the conversation, or the Claude worker's transcript, as it grows
  nexus seen <thread> [--unread | --last-reply-at MS]
    mark the latest reply seen, or unread, or only up to the reply at MS, as captured with what the client showed
  nexus abort|retry|retry-pylon|wake <thread>
  nexus archive|unarchive|delete <thread>
  nexus projects
  nexus project edit <id> [--node N|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]
    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...
    [--clear-hosts] [--clear-logins] [--clear-secrets] [--git-name NAME --git-email EMAIL | --clear-git-identity]
    [--auto-review off|review|land]   review each builder's PR on its own, and land it too; land needs a deployer
    [--pipeline off|approve|start]    turn pipeline items into threads, once the person approves each or on their own
  nexus project add <id> (<repo-url> | --scratch) [--node N|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]
                    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...
  nexus review <thread> [--pr N] [--rounds N] [--land]
    a reviewer on another model for the thread's open PR, round after round until it approves; --land merges and deploys under the merge policy
  nexus review --cancel <thread>               end the thread's running review and archive its reviewer, unless it began merging or deploying
  nexus land <thread>                          land an approved review under the merge policy, or try a held landing again
  nexus deploy <commit|main> [--wait]
  nexus release
  nexus image build [--wait]                   build the recipe of the control plane's release, and record the image
  nexus image rollout <image> [--wait]         copy an image to every online node, then make it current
  nexus image rollback [--wait]                roll out again the image that was current before this one
  nexus image list                             recorded images, the nodes that hold each, and the last image operation
  nexus image current                          the current image and the one before it
  nexus nodes
  nexus node <name>                            a node's load, memory, disk, temperatures and pylon processes, read now; deployers only
  nexus doctor                                 check each node and the control plane now: release, disk, pylons, backup, login, certificate
  nexus usage [--since today|7d|30d|all|DATE] [--project P] [--by model|project|kind|role|day]
    the tokens the agents spent, in all and by model, project, agent, role and day, or only --by's; --since is 7d by default
  nexus usage backfill [--dry-run | --stop]
    read archived threads' transcripts from their start, waking one pylon at a time, or list what it would read, or stop; deployers only
  nexus --version

Every command takes --json, --url URL and --socks HOST:PORT|none. The URL and proxy come from those flags,
then NEXUS_URL and NEXUS_SOCKS, then ${configFile()}, which \`nexus connect\` writes. Without a proxy the CLI
connects directly.
`;

/** The entries of `usage` that name the command: `abort|retry <thread>` names abort and retry, `project edit <id>` names project edit. */
export function usageOf(name: string): string {
  const entries = usage.match(/^  nexus .*(?:\n {4}.*)*/gm) ?? [];
  return `${entries.filter((entry) => {
    const [, first, second] = entry.trim().split(/\s+/);
    return first!.split("|").includes(name) || `${first} ${second}` === name;
  }).join("\n")}\n`;
}
