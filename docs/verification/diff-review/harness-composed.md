I reviewed the diff in the Nexus dashboard. Please address these notes, and answer the questions.

1. **[REQUESTED CHANGE]** `app.py` lines 7-10

   ```diff
   +    """Reads a JSON config, failing on a missing name."""
   -    return json.loads(path.read_text())
   +    config = json.loads(path.read_text())
   +    if "name" not in config:
   +        raise SystemExit("config has no name")
   ```

   Raise a ValueError, not SystemExit, so callers can catch it.

2. **[COMMENT]** `src/server.ts` lines 10-12

   ```diff
   +function notFound(res: ServerResponse) {
   +  res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
   +}
   ```

   notFound could live beside the routes map.

3. **[SUGGESTION]** `src/server.ts` removed lines 12-15

   ```diff
   -    if (route === undefined) {
   -      res.writeHead(404).end();
   -      return;
   -    }
   ```

   Keep the 404 body empty, as before.

4. **[QUESTION]** `src/server.ts` line 16

   ```diff
        const route = routes.get(`${req.method} ${req.url}`);
   -    if (route === undefined) {
   -      res.writeHead(404).end();
   ```

   Why does a missing route return early here instead of falling through?

5. **[COMMENT]** `style.css` lines 3-4

   ```diff
   +  gap: 8px;
   +  color: light-dark(#222, #eee);
   ```

   Use the gap token here.
