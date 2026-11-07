import { test } from "node:test";
import assert from "node:assert/strict";
import { imageIdOf, type ImageRecipe } from "./images.ts";

const recipe: ImageRecipe = {
  files: [{ path: "Dockerfile", mode: 0o644, content: "FROM debian" }, { path: "gondolin.json", mode: 0o644, content: "{}" }],
  pins: {
    debianDigest: "sha256:d", node: "24.22.1", nodeSha256: "n", claudeCode: "2.0.0", pi: "1.4.0", herdr: "0.5.0",
    piEnv: "0.1.0", piEnvSha256: "e", gondolin: "0.13.0", alpineKernel: "6.18.58-0-virt", dotfilesCommon: "abc", gh: "2.103.2",
    ghSha256: "g", neovim: "0.12.6", neovimSha256: "v",
  },
};

test("imageIdOf names the recipe's content and modes, whatever the order of its files and pins", () => {
  const id = imageIdOf(recipe);
  assert.match(id, /^img-[0-9a-f]{12}$/);
  const reordered: ImageRecipe = { files: [...recipe.files].reverse(), pins: Object.fromEntries(Object.entries(recipe.pins).reverse()) as ImageRecipe["pins"] };
  assert.equal(imageIdOf(reordered), id);
  assert.notEqual(imageIdOf({ ...recipe, files: [{ path: "Dockerfile", mode: 0o644, content: "FROM alpine" }, recipe.files[1]!] }), id);
  assert.notEqual(imageIdOf({ ...recipe, files: [{ ...recipe.files[0]!, mode: 0o755 }, recipe.files[1]!] }), id);
  assert.notEqual(imageIdOf({ ...recipe, pins: { ...recipe.pins, pi: "1.4.1" } }), id);
});

test("imageIdOf refuses a recipe with two files at one path", () => {
  assert.throws(() => imageIdOf({ ...recipe, files: [...recipe.files, { path: "Dockerfile", mode: 0o644, content: "" }] }), /two files at Dockerfile/);
});
