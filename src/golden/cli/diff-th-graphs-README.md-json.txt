exit 0
--- stdout
{
  "base": {
    "kind": "start",
    "commit": "a06ce6f3ecfdc8b56df06bb65ff0c5b0b8f2943c"
  },
  "diff": "diff --git a/README.md b/README.md\nindex 30d2138..2c18b7c 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # probe-client\n \n-Talks to a node's probe over the tailnet.\n+Talks to a node's probe over the tailnet, and retries a reset with jittered backoff until its deadline.\n",
  "truncated": false
}
--- stderr
