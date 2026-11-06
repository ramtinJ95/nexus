exit 0
--- stdout
diff --git a/README.md b/README.md
index 30d2138..2c18b7c 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,3 @@
 # probe-client
 
-Talks to a node's probe over the tailnet.
+Talks to a node's probe over the tailnet, and retries a reset with jittered backoff until its deadline.
--- stderr
