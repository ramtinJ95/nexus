import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { themes } from "../dashboard.ts";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

/** Each theme's declarations in style.css, by the name its `:root[data-theme=…]` rule gives it. */
const declared = new Map<string, Map<string, string>>();
for (const [, selector, body] of css.matchAll(/^(:root[^{]*\[data-theme="[^"]+"\][^{]*)\{([^}]*)\}/gm)) {
  const props = new Map([...body!.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
  for (const [, name] of selector!.matchAll(/\[data-theme="([^"]+)"\]/g)) declared.set(name!, props);
}
const light = declared.get("light")!;

type Rgba = [number, number, number, number];
function parse(color: string): Rgba {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (hex !== null) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(hex[2] === undefined ? 1 : parseInt(hex[2], 16) / 255) as Rgba;
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
  assert.ok(rgba !== null, `${color} is a colour this test reads`);
  return rgba.slice(1).map(Number) as Rgba;
}
/** A colour as it shows over an opaque one. */
const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
/** WCAG's contrast ratio of a colour over a background, which may itself lie over `under`. */
function contrast(fg: string, bg: string, under = bg): number {
  const back = over(parse(bg), parse(under));
  const [a, b] = [luminance(over(parse(fg), back)), luminance(back)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("the picker offers System and every theme style.css defines", () => {
  assert.deepEqual(themes.map(([name]) => name), ["system", ...declared.keys()]);
});

test("every theme defines every variable the light theme defines, and nothing else", () => {
  for (const [name, props] of declared) assert.deepEqual([...props.keys()].sort(), [...light.keys()].sort(), name);
});

test("a terminal's palette has its 16 colours", () => {
  for (const [name, props] of declared) assert.equal(props.get("--term-ansi")!.split(/\s+/).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).length, 16, name);
});

/**
 * The pairs below each bar that macarchy's own colours make, kept as macarchy has them, by theme. A pair that meets
 * its bar is not listed, so the list stays what the PR reports.
 */
const belowBar: Record<string, string[]> = {
  "tokyo-night": ["--text-3 on --side", "--text-3 on --bg"],
  "kanagawa-wave": ["--del-text on --del-bg", "--add-text on --add-bg", "--text-3 on --side"],
};

/** Each pair of a theme's colours, the contrast it has and the contrast WCAG AA asks of it. */
function pairs(props: Map<string, string>): [pair: string, ratio: number, bar: number][] {
  const v = (prop: string) => props.get(prop)!;
  const surfaces = ["--bg", "--side", "--inspect", "--card", "--raised", "--code-bg"];
  return [
    // Body text, and the second level the dashboard derives from it, as text on each surface it lies on.
    ...["--text", "--text-2"].flatMap((fg) => surfaces.map((bg): [string, string, string, number] => [fg, bg, bg, 4.5])),
    ["--on-accent", "--accent", "--accent", 4.5], ["--term-text", "--term-bg", "--term-bg", 4.5],
    ["--add-text", "--add-bg", "--bg", 4.5], ["--del-text", "--del-bg", "--bg", 4.5],
    // Dim text and status colours, at the bar WCAG sets for large text and a control's parts.
    ["--text-3", "--side", "--side", 3], ...["--text-3", "--accent", "--ok", "--warn", "--bad"].map((fg): [string, string, string, number] => [fg, "--bg", "--bg", 3]),
  ].map(([fg, bg, under, bar]) => [`${fg} on ${bg}`, contrast(v(fg as string), v(bg as string), v(under as string)), bar as number]);
}

test("every theme's text meets WCAG AA on every surface, but for the pairs macarchy's palettes set below it", () => {
  for (const [name, props] of declared) {
    const below = pairs(props).filter(([, ratio, bar]) => ratio < bar);
    assert.deepEqual(below.map(([pair]) => pair).sort(), (belowBar[name] ?? []).sort(), `${name}: ${below.map(([pair, ratio]) => `${pair} ${ratio.toFixed(2)}:1`).join(", ")}`);
  }
});

test("the terminal view keeps the dock's state bar and questions, and hides only the composer", () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , body]) => /display:\s*none/.test(body!));
  const hidden = rules.flatMap(([, selector]) => selector!.split(",").map((s) => s.trim())).filter((s) => s.includes('[data-view="term"]'));
  assert.deepEqual(hidden.filter((s) => s.endsWith(".dock")), []);
  assert.ok(hidden.some((s) => s.endsWith("#composer")), hidden.join(", "));
});

/** Each style rule's selector list and declarations, with the at-rules it sits in, which are "" at the top level. */
function styleRules(): { at: string; selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: { at: string; selector: string; body: string }[] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") {
      open.push(text.slice(start, i).trim().replace(/\s+/g, " "));
      start = i + 1;
    } else if (text[i] === "}") {
      const head = open.pop()!;
      if (!head.startsWith("@")) found.push({ at: open.join(" "), selector: head.split(",").map((s) => s.trim()).join(", "), body: text.slice(start, i) });
      start = i + 1;
    } else if (text[i] === ";" && open.length === 0) start = i + 1;
  }
  return found;
}

test("no selector list has two rules at one level, where the later would silently override the earlier", () => {
  const seen = new Set<string>();
  const twice = styleRules().map(({ at, selector }) => `${at} ${selector}`.trim()).filter((key) => seen.has(key) || !seen.add(key));
  assert.deepEqual(twice, []);
});

test("only [hidden] uses !important, as it must beat every display rule", () => {
  assert.deepEqual(styleRules().filter(({ body }) => body.includes("!important")).map(({ selector }) => selector), ["[hidden]"]);
});
