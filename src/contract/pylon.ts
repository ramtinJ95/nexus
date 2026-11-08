/**
 * The routes of what a person does in a thread's pylon: previews, sessions, and reads of its checkout and
 * conversation images. The server registers its handlers against them, and the CLI and dashboard call them. It
 * imports nothing at run time, so a browser can bundle it. pylon-parse.ts holds the request schemas.
 */
import type { z } from "zod";
import type { Changes, Diff, Listing } from "../checkout-files.ts";
import type { Preview } from "../control/thread-store.ts";
import type { OpenedSession } from "../control/wire.ts";
import type { previewSchema, sessionSchema } from "./pylon-parse.ts";
import { queryOf, route, type FileBytes, type QueryCodec } from "./route.ts";

/**
 * What the Changes view and the diff are read against: `start` is what the pylon booted at, which its first boot
 * records as refs/nexus/base, `head` the last commit, and `turn` where the latest turn began.
 */
export const changesBases = ["start", "head", "turn"] as const;
export type ChangesBase = (typeof changesBases)[number];

export const changeStatuses = ["added", "modified", "deleted", "renamed", "copied", "typechange"] as const;
export type ChangeStatus = (typeof changeStatuses)[number];
/** The letter the dashboard's changes list shows for each status. */
export const statusLetters: Readonly<Record<ChangeStatus, string>> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechange: "T" };

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

export const pylonRoutes = {
  preview: route<Preview, z.input<typeof previewSchema>>()("POST", "/v1/threads/{thread}/previews"),
  unpreview: route<null>()("DELETE", "/v1/threads/{thread}/previews/{port}"),
  openSession: route<OpenedSession, z.input<typeof sessionSchema>>()("POST", "/v1/threads/{thread}/sessions"),
  closeSession: route<null>()("DELETE", "/v1/threads/{thread}/sessions/{session}"),
  focusSession: route<null>()("POST", "/v1/threads/{thread}/sessions/{session}/focus"),
  files: route<Listing>()("GET", "/v1/threads/{thread}/files", pathQuery),
  file: route<FileBytes>()("GET", "/v1/threads/{thread}/files/content", pathQuery),
  image: route<FileBytes>()("GET", "/v1/threads/{thread}/image", imageQuery),
  changes: route<Changes>()("GET", "/v1/threads/{thread}/changes", changesQuery),
  diff: route<Diff>()("GET", "/v1/threads/{thread}/diff", diffQuery),
} as const;
