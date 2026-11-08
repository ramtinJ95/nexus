import assert from "node:assert/strict";
import test from "node:test";
import { shellReprint as shell } from "../scripts/shell-reprint.ts";

const same = (a: string, b: string) => shell(a) === shell(b);

test("a shell script's comments may change, and its commands may not", () => {
  assert.ok(same("#!/bin/sh\n# old\necho a\n  # indented\n", "#!/bin/sh\necho a\n"));
  assert.ok(same("# a first line that is no shebang\necho a\n", "echo a\n"));
  assert.ok(!same("echo a # trailing\n", "echo a\n"), "only whole-line comments may change");
  assert.ok(!same("echo a\n", "echo b\n"));
  assert.ok(!same("#!/bin/sh\necho a\n", "#!/bin/bash\necho a\n"), "the shebang counts");
});

test("a heredoc's or a string's # lines are data, not comments", () => {
  assert.ok(!same("cat <<'EOF'\n# before\nEOF\n", "cat <<'EOF'\n# after\nEOF\n"));
  assert.ok(!same('x="a\n# before"\n', 'x="a\n# after"\n'));
});

test("a line after a backslash continuation, a space after a backslash and a non-breaking space are code", () => {
  assert.ok(!same("printf a\\\n# b\ntrue\n", "printf a\\\ntrue\n"));
  assert.ok(!same("printf a\\\n\ntrue\n", "printf a\\\ntrue\n"));
  assert.ok(!same("echo a\\ \n", "echo a\\\n"));
  assert.ok(!same("true\n #\n", "true\n"));
});

test("an edit bash's reprint normalizes away still counts", () => {
  assert.ok(!same("#!/bin/sh\nf() { echo ok; }; f\n", "#!/bin/sh\nfunction f { echo ok; }; f\n"));
});

test("bash only reads the script, and the check refuses one that would close its wrapper or names alias", () => {
  assert.throws(() => shell("}\ntouch /nonexistent/ran\n{\n"));
  assert.doesNotThrow(() => shell("exit 3\n"));
  assert.throws(() => shell('shopt -s expand_aliases\nalias a="cat <<EOF"\na\n# data\nEOF\n'), /alias/);
});
