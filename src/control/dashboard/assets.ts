import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Metafile } from "esbuild";
import { keptEncodings, type Encode } from "../api/encoding.ts";

/** Where src/control/dashboard/build.ts bundles the client, with the build's metafile as `metafile.json`. */
export const bundle = new URL("../../../dist/dashboard/", import.meta.url);

const types: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml" };
/** `encode` compresses the body once per coding, on the first request that takes it. */
export interface Asset { type: string; body: Buffer; version: string | null; encode: Encode }
/** The client build.ts bundles. Pages link it, the stylesheet and the icon, so only these carry a version. */
export const entry = "client.js";
const sources = ["style.css", "favicon.svg"];
const linked = new Set([...sources, entry]);

function load(): Map<string, Asset> {
  let metafile: Metafile;
  try { metafile = JSON.parse(readFileSync(new URL("metafile.json", bundle), "utf8")) as Metafile; } catch (error) {
    throw new Error("The dashboard client is not built. Run `npm run build`.", { cause: error });
  }
  const files = [
    ...sources.map((file) => [file, new URL(`./${file}`, import.meta.url)] as const),
    ...Object.keys(metafile.outputs).map((path) => [basename(path), new URL(basename(path), bundle)] as const),
  ];
  return new Map(files.map(([file, url]) => {
    const body = readFileSync(url);
    // A chunk is named by its hash.
    const version = linked.has(file) ? createHash("sha256").update(body).digest("hex").slice(0, 12) : null;
    return [file, { type: types[file.split(".").at(-1)!]!, body, version, encode: keptEncodings(body) }];
  }));
}
let assets: Map<string, Asset> | undefined;
export const asset = (file: string) => (assets ??= load()).get(file);
export function assetUrl(file: string): string {
  const version = asset(file)?.version;
  if (version == null) throw new Error(`A page links only the files assets.ts versions, not ${file}.`);
  return `/assets/${file}?v=${version}`;
}
