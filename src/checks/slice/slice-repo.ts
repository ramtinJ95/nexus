/**
 * The git repository both slice suites' Docker images hold, so a Docker pylon clones, fetches and checks out as a pylon
 * VM does from GitHub, with no network. Its commits are empty, by one author, at time 0, so their IDs are fixed.
 */
import { createHash } from "node:crypto";

const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const author = { name: "slice", email: "slice@example.com" };

function commitId(message: string, parent?: string): string {
  const signature = `${author.name} <${author.email}> 0 +0000`;
  const body = `tree ${emptyTree}\n${parent === undefined ? "" : `parent ${parent}\n`}author ${signature}\ncommitter ${signature}\n\n${message}\n`;
  return createHash("sha1").update(`commit ${Buffer.byteLength(body)}\0${body}`).digest("hex");
}

export const sliceRepo = "/srv/slice.git";
const first = commitId("first");
/** main's two commits, oldest first. */
export const sliceCommits = [first, commitId("second", first)] as const;

/** The Dockerfile step that makes the repository, after the one that adds `user`, who owns it. */
export const sliceRepoStep = [
  `RUN export GIT_AUTHOR_NAME=${author.name} GIT_AUTHOR_EMAIL=${author.email} GIT_AUTHOR_DATE='@0 +0000' GIT_COMMITTER_NAME=${author.name} GIT_COMMITTER_EMAIL=${author.email} GIT_COMMITTER_DATE='@0 +0000'`,
  `git init --quiet --bare --initial-branch=main ${sliceRepo}`,
  `tree=$(git -C ${sliceRepo} hash-object -t tree -w /dev/null)`,
  `first=$(echo first | git -C ${sliceRepo} commit-tree "$tree")`,
  `git -C ${sliceRepo} update-ref refs/heads/main "$(echo second | git -C ${sliceRepo} commit-tree "$tree" -p "$first")"`,
  `chown -R user:user ${sliceRepo}`,
].join(" && ");
