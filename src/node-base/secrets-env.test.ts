import { test } from "node:test";
import assert from "node:assert/strict";
import { appendSecret, parseSecretsEnv } from "./secrets-env.ts";

const path = "/etc/nexus/secrets.env";

test("an appended secret is the line the writer always wrote, and reads back as its value", () => {
  for (const [text, line] of [["", "GH_TOKEN=ghp_x\n"], ["A=1\n", "GH_TOKEN=ghp_x\n"], ["A=1", "\nGH_TOKEN=ghp_x\n"], ["# by hand\r\nA=1\r\n", "GH_TOKEN=ghp_x\n"]] as const) {
    assert.equal(appendSecret(path, text, "GH_TOKEN", "ghp_x", []), line, JSON.stringify(text));
    assert.equal(parseSecretsEnv(text + line, []).value("GH_TOKEN"), "ghp_x");
  }
  assert.equal(appendSecret(path, "", "STRIPE_KEY", "sk_test_a=b#c", []), "STRIPE_KEY=sk_test_a=b#c\n", "a value is written verbatim");
});

test("a secret the probe would refuse is refused by the writer, naming the file and never the value", () => {
  const cases: [string, string, string, RegExp][] = [
    ["", "A", "\"hunter2\"", /line 1 quotes the value of A/],
    ["", "A", "", /line 1 gives A no value/],
    ["A=x\n", "A", "hunter2", /line 2 sets A a second time/],
    ["", "NEXUS_CHATGPT_TOKEN", "hunter2", /line 1 sets NEXUS_CHATGPT_TOKEN, which the control plane hands to this probe/],
    ["", "export A", "hunter2", /line 1 is not NAME=value/],
    ["", "A", "hunter2\nB=hunter3", /A cannot be one NAME=value line/],
    ["", "A=B", "hunter2", /A=B cannot be one NAME=value line/],
    ["A = x\n", "B", "hunter2", /line 1 is not NAME=value/],
  ];
  for (const [text, name, value, message] of cases) {
    assert.throws(() => appendSecret(path, text, name, value, ["NEXUS_CHATGPT_TOKEN"]), (err: Error) => err.message.startsWith(`${path}: `) && message.test(err.message) && !err.message.includes("hunter"), `${name} in ${JSON.stringify(text)}`);
  }
});
