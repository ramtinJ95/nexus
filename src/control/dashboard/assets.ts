/** The dashboard's static assets: the stylesheet, icon and fonts from src, and the client as build.ts bundled it. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const types: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml", woff2: "font/woff2" };
const bundle = new URL("../../../dist/dashboard/", import.meta.url);
if (!existsSync(new URL("client.js", bundle))) throw new Error("The dashboard client is not built. Run `npm run build`.");
/**
 * The stylesheet, icon and fonts as they are in src, and the client as src/control/dashboard/build.ts bundled it. A
 * font is bytes, and the rest text.
 */
export const fonts = ["b612-400.woff2", "b612-700.woff2", "b612-mono-400.woff2"];
export const assets = new Map([
  ...["style.css", "favicon.svg", ...fonts].map((file) => [file, new URL(`./${file}`, import.meta.url)] as const),
  ...readdirSync(bundle).map((file) => [file, new URL(file, bundle)] as const),
].map(([file, url]) => {
  const body: string | Buffer = file.endsWith(".woff2") ? readFileSync(url) : readFileSync(url, "utf8");
  // A chunk is named by its hash, so only the files a page links carry a version.
  const version = ["style.css", "favicon.svg", "client.js"].includes(file) ? createHash("sha256").update(body).digest("hex").slice(0, 12) : null;
  return [file, { type: types[file.split(".").at(-1)!]!, body, version }];
}));
export const assetUrl = (file: string) => `/assets/${file}?v=${assets.get(file)!.version}`;
