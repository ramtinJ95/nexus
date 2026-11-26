# Public facts about the @earendil-works/gondolin package: its npm release history and its repository's counters.
# Reads only the public npm registry and GitHub API, and sends nothing but the package's own name.
import json
import urllib.request

doc = json.load(urllib.request.urlopen("https://registry.npmjs.org/@earendil-works/gondolin"))
t = doc["time"]
vs = sorted((v, k) for k, v in t.items() if k not in ("created", "modified"))
print("npm: first publish", t["created"][:10], "| last modified", t["modified"][:10], "| versions published", len(vs), "| latest", doc["dist-tags"]["latest"])
print("npm: maintainers", ", ".join(m["name"] for m in doc["maintainers"]))
for v, k in vs[-10:]:
    print("  ", k, v[:10])
repo = json.load(urllib.request.urlopen("https://api.github.com/repos/earendil-works/gondolin"))
print("github: created", repo["created_at"][:10], "| last push", repo["pushed_at"][:10], "| stars", repo["stargazers_count"], "| open issues and pull requests", repo["open_issues_count"], "| archived", repo["archived"])
