/** It imports only route.ts at run time, so a browser can bundle it. */
import type { Preview } from "../control/thread-store.ts";
import type { SessionHarness } from "../protocol/agent-kinds.ts";
import { pylonWaitMs, queryOf, route, type FileBytes, type QueryCodec } from "./route.ts";

/**
 * What the Changes view and the diff are read against: `start` is what the pylon booted at, which its first boot
 * records as refs/nexus/base, `head` the last commit, and `turn` where the latest turn began, the hidden snapshot
 * commit taken before the latest reply.
 */
export const changesBases = ["start", "head", "turn"] as const;
export type ChangesBase = (typeof changesBases)[number];

export const changeStatuses = ["added", "modified", "deleted", "renamed", "copied", "typechange"] as const;
export type ChangeStatus = (typeof changeStatuses)[number];
export const statusLetters: Readonly<Record<ChangeStatus, string>> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechange: "T" };

/** A directory's entries, sorted by name, with a size for a file only. `path` is relative to the checkout, and empty for the checkout itself. */
export interface Listing { path: string; entries: { name: string; kind: "file" | "dir" | "symlink" | "other"; size: number | null }[]; truncated: boolean }
export interface ChangesBaseAt {
  kind: ChangesBase;
  /** Null where the base is the empty tree: HEAD before the first commit, and the start of a pylon that booted an empty repository. */
  commit: string | null;
}
export interface ChangedFile {
  path: string;
  /** The path before a rename. */
  oldPath: string | null;
  status: ChangeStatus;
  /** Lines, null for a binary file. */
  additions: number | null;
  deletions: number | null;
}
export interface Changes { base: ChangesBaseAt; files: ChangedFile[]; truncated: boolean }
export interface Diff { base: ChangesBaseAt; diff: string; truncated: boolean }

/** Where an image of a thread's conversation is, as the dashboard's image links name it. */
export type ImageSource =
  /** A block of the Claude worker's current transcript, as a prompt or result entry's `images` names it. */
  | { source: "transcript"; offset: number; bytes: number; sha256: string; index: number }
  /** An image part of a harness conversation: the entry's ID, its message, the part, and the SHA-256 of the part's base64 data. */
  | { source: "harness"; entry: number; message: number; part: number; sha256: string }
  /** A file in the checkout, or the file at a base of the Changes view. */
  | { source: "file"; path: string; base?: ChangesBase | undefined };
/** The parameters keep the order the source's fields have, so a link to the same image is the same URL. */
const imageQuery: QueryCodec<ImageSource, Record<string, string>> = {
  encode: (source) => queryOf(Object.entries(source).map(([key, value]) => [key, value === undefined ? undefined : String(value)])),
  decode: (params) => Object.fromEntries(params),
};

/** A path in the checkout, relative to it. Empty is the checkout itself. */
export interface PathQuery { path: string }
const pathQuery: QueryCodec<PathQuery> = {
  encode: ({ path }) => queryOf([["path", path]]),
  decode: (params) => ({ path: params.get("path") ?? "" }),
};

export interface ChangesQuery { base?: ChangesBase }
const changesQuery: QueryCodec<ChangesQuery, { base: string | undefined }> = {
  encode: ({ base }) => queryOf([["base", base]]),
  decode: (params) => ({ base: params.get("base") ?? undefined }),
};

/** Each path is a pathspec, so a renamed file needs its old path too. */
export interface DiffQuery { base?: ChangesBase; paths?: readonly string[] }
const diffQuery: QueryCodec<DiffQuery, { base: string | undefined; paths: string[] }> = {
  encode: ({ base, paths = [] }) => queryOf([["base", base], ...paths.map((path) => ["path", path] as const)]),
  decode: (params) => ({ base: params.get("base") ?? undefined, paths: params.getAll("path") }),
};

/** The Herdr workspace's label is the harness's name by default, and the harness is Claude Code's. */
export interface SessionRequest { harness?: SessionHarness | undefined; title?: string | undefined }
/** A session the route opened, which `nexus session open` prints. Its observed state shows in ThreadDetail.sessions. */
export interface OpenedSession { herdrPane: string; harness: SessionHarness; title: string }

export const pylonRoutes = {
  preview: route<Preview, { port: number }>()("POST", "/v1/threads/{thread}/previews"),
  unpreview: route<null>()("DELETE", "/v1/threads/{thread}/previews/{port}"),
  openSession: route<OpenedSession, SessionRequest>()("POST", "/v1/threads/{thread}/sessions", undefined, pylonWaitMs),
  closeSession: route<null>()("DELETE", "/v1/threads/{thread}/sessions/{session}"),
  files: route<Listing>()("GET", "/v1/threads/{thread}/files", pathQuery, pylonWaitMs),
  file: route<FileBytes>()("GET", "/v1/threads/{thread}/files/content", pathQuery),
  image: route<FileBytes>()("GET", "/v1/threads/{thread}/image", imageQuery),
  /** A diff of a large tree can take the pylon a while. */
  changes: route<Changes>()("GET", "/v1/threads/{thread}/changes", changesQuery, pylonWaitMs),
  diff: route<Diff>()("GET", "/v1/threads/{thread}/diff", diffQuery, pylonWaitMs),
} as const;
