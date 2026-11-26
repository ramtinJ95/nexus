| probe | expect | A | B | off: GitHub's own answer (status, first 80 chars) |
|---|---|---|---|---|
| 1 git clone | pass | passed exit0 | passed exit0 | exit0 2ed1567 landed via createCommitOnBranch |
| 1 git push new branch | pass | passed exit0 | passed exit0 | exit0 remote: remote: Create a pull request for 'guest-off-mwxiyxwa' on GitHub by visi |
| 2 gh pr create | pass | passed exit0 | passed exit0 | exit0 https://github.com/ramtinJ95/nexus-guard-scratch/pull/36 |
| 3 gh pr comment | pass | passed exit0 | passed exit0 | exit0 https://github.com/ramtinJ95/nexus-guard-scratch/pull/1#issuecomment-7191976657 |
| 3 gh pr review --comment | pass | passed exit0 | passed exit0 | exit0  |
| 3 REST issue comment | pass | passed 201 | passed 201 | 201 { "url": "https://api.github.com/repos/ramtinJ95/nexus-guard-scratch/issues/comm |
| 3 REST review COMMENT | pass | passed 200 | passed 200 | 200 { "id": 6074085195, "node_id": "PRR_kwDOV83q2c8AAAABagsvSw", "user": { "login":  |
| 3 REST pending review (no event) | pass | passed 200 | passed 200 | 200 { "id": 6074085704, "node_id": "PRR_kwDOV83q2c8AAAABagsxSA", "user": { "login":  |
| 4 gh pr view | pass | passed exit0 | passed exit0 | exit0 #1 OPEN |
| 4 gh pr checks | pass | passed exit0 | passed exit0 | exit0 no checks reported on the 'seed-42656806' branch exit=1 |
| 4 gh api GET repo | pass | passed exit0 | passed exit0 | exit0 ramtinJ95/nexus-guard-scratch |
| 4 gh api graphql query | pass | passed exit0 | passed exit0 | exit0 ramtinJ95 |
| 5 gh pr merge --merge | refuse | REFUSED exit1 | REFUSED exit1 | exit0 [MERGED #1, MAIN MOVED 2ed1567->a0c862f]  |
| 5 gh pr merge --squash | refuse | REFUSED exit1 | REFUSED exit1 | exit0 [MERGED #3, MAIN MOVED a0c862f->e5df55d]  |
| 5 gh pr merge --rebase | refuse | REFUSED exit1 | REFUSED exit1 | exit0 [MERGED #4, MAIN MOVED e5df55d->0ed4049]  |
| 5 gh pr merge --auto | refuse | REFUSED exit1 | REFUSED exit1 | exit1 GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMer |
| 6 REST PUT pulls/n/merge | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #5, MAIN MOVED 0ed4049->734892c] { "sha": "734892cc1dc9f11d2226b3804bfc558a1d9130fd", "merged": true, "message":  |
| 7 GraphQL mergePullRequest | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #6, MAIN MOVED 734892c->4c6f17f] {"data":{"mergePullRequest":{"pullRequest":{"state":"MERGED"}}}} |
| 7 GraphQL enablePullRequestAutoMerge | refuse | REFUSED 403 | REFUSED 403 | 200 {"data":{"enablePullRequestAutoMerge":null},"errors":[{"type":"UNPROCESSABLE","p |
| 7 GraphQL enqueuePullRequest | refuse | REFUSED 403 | REFUSED 403 | 200 {"data":{"enqueuePullRequest":null},"errors":[{"type":"UNPROCESSABLE","path":["e |
| 8 gh pr review --approve | refuse | REFUSED exit1 | REFUSED exit1 | exit1 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] failed to create review: GraphQL: Review Can not approve your own pull request ( |
| 8 REST review event APPROVE | refuse | REFUSED 403 | REFUSED 403 | 422 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] { "message": "Unprocessable Entity", "errors": [ "Review Can not approve your ow |
| 8 REST pending review events APPROVE | refuse | REFUSED 403 | REFUSED 403 | 422 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] { "message": "Validation Failed", "errors": [ "Could not approve for pull reques |
| 8 GraphQL addPullRequestReview APPROVE | refuse | REFUSED 403 | REFUSED 403 | 200 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] {"data":{"addPullRequestReview":null},"errors":[{"type":"UNPROCESSABLE","path":[ |
| 8 GraphQL submitPullRequestReview APPROVE | refuse | REFUSED 403 | REFUSED 403 | 200 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] {"data":{"submitPullRequestReview":null},"errors":[{"type":"UNPROCESSABLE","path |
| 3 REST submit pending review COMMENT | pass | passed 200 | passed 200 | 200 { "id": 6074085704, "node_id": "PRR_kwDOV83q2c8AAAABagsxSA", "user": { "login":  |
| 9 REST POST merges (branch into main) | refuse | REFUSED 403 | REFUSED 403 | 201 [MAIN MOVED 4c6f17f->f3eca7d] { "sha": "f3eca7d62beca96edb12aefbe701a50a12992f68", "node_id": "C_kwDOV83q2doAK |
| 9 REST PATCH git/refs/heads/main | refuse | REFUSED 403 | REFUSED 403 | 422 { "message": "Update is not a fast forward", "documentation_url": "https://docs. |
| 9 REST POST git/refs main | refuse | REFUSED 403 | REFUSED 403 | 422 { "message": "Reference already exists", "documentation_url": "https://docs.gith |
| 9 git push to main | refuse | REFUSED exit0 | REFUSED exit0 | exit0 [MAIN MOVED f3eca7d->c50e088] To https://github.com/ramtinJ95/nexus-guard-scratch f3eca7d..c50e088 HEAD -> mai |
| 9 REST contents PUT (default branch) | refuse | REFUSED 403 | REFUSED 403 | 201 [MAIN MOVED c50e088->fcd3a70] { "content": { "name": "landed-off-mwxiyxwa-a.txt", "path": "landed-off-mwxiyxwa |
| 9 REST contents PUT branch=main | refuse | REFUSED 403 | REFUSED 403 | 201 [MAIN MOVED fcd3a70->e537d6a] { "content": { "name": "landed-off-mwxiyxwa-b.txt", "path": "landed-off-mwxiyxwa |
| 9+ GraphQL mergeBranch | refuse | passed 200 SLIP(MAIN MOVED 4fee3f0->372e202) | REFUSED 403 | 200 [MAIN MOVED e537d6a->932e394] {"data":{"mergeBranch":{"mergeCommit":{"oid":"932e39427cc34ad5cd0bbc092d9c7b64b3 |
| 9+ GraphQL createCommitOnBranch main | refuse | passed 200 SLIP(MAIN MOVED 372e202->2ed1567) | REFUSED 403 | 200 [MAIN MOVED 932e394->a7dffed] {"data":{"createCommitOnBranch":{"commit":{"oid":"a7dffeda992bc145e7a4f288386649 |
| 9+ GraphQL updateRef main | refuse | passed 200 | REFUSED 403 | 200 {"data":{"updateRef":null},"errors":[{"type":"UNPROCESSABLE","path":["updateRef" |
| 9+ REST PATCH repo default_branch | refuse | passed 200 SLIP(DEFAULT BRANCH -> guest-A-mwxipf4h) | REFUSED 403 | 200 [DEFAULT BRANCH -> guest-off-mwxiyxwa] { "id": 1473112793, "node_id": "R_kgDOV83q2Q", "name": "nexus-guard-scratch", "f |
| 9+ git push workflow file | refuse | passed exit0 | passed exit0 | exit0 To https://github.com/ramtinJ95/nexus-guard-scratch ! [remote rejected] wf-off-m |
| 10 GraphQL aliased mergePullRequest | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #7, MAIN MOVED a7dffed->f212774] {"data":{"m":{"clientMutationId":null}}} |
| 10 GraphQL two ops + operationName | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #10, MAIN MOVED f212774->7e334ab] {"data":{"mergePullRequest":{"clientMutationId":null}}} |
| 10 GraphQL fragment on Mutation | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #11, MAIN MOVED 7e334ab->5342d3d] {"data":{"mergePullRequest":{"clientMutationId":null}}} |
| 10 GraphQL JSON-escaped field name | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #12, MAIN MOVED 5342d3d->6b18ff9] {"data":{"mergePullRequest":{"clientMutationId":null}}} |
| 10 GraphQL review event in variable | refuse | REFUSED 403 | REFUSED 403 | 200 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] {"data":{"addPullRequestReview":null},"errors":[{"type":"UNPROCESSABLE","path":[ |
| 10 GraphQL review input as variable | refuse | REFUSED 403 | REFUSED 403 | 200 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] {"data":{"addPullRequestReview":null},"errors":[{"type":"UNPROCESSABLE","path":[ |
| 10 GraphQL event variable default | refuse | REFUSED 403 | REFUSED 403 | 200 [REACHED GITHUB AS APPROVE (GitHub refused: own PR)] {"data":{"addPullRequestReview":null},"errors":[{"type":"UNPROCESSABLE","path":[ |
| 10 GraphQL batched array | refuse | REFUSED 403 | REFUSED 403 | 400 { "message": "Body should be a JSON object", "documentation_url": "https://docs. |
| 10 GraphQL GET ?query=mutation | refuse | REFUSED 403 | REFUSED 403 | 200 {"data":{"__schema":{"queryType":{"name":"Query"},"mutationType":{"name":"Mutati |
| 10 GraphQL POST ?query= with empty body | refuse | REFUSED 403 | REFUSED 403 | 200 {"errors":[{"message":"A query attribute must be specified and must be a string. |
| 10 GraphQL persisted query | refuse | REFUSED 403 | REFUSED 403 | 200 {"errors":[{"message":"A query attribute must be specified and must be a string. |
| 10 GraphQL application/graphql raw body | refuse | REFUSED 403 | REFUSED 403 | 400 { "message": "Problems parsing JSON", "documentation_url": "https://docs.github. |
| 10 GraphQL gzip body | refuse | REFUSED 403 | REFUSED 403 | 400 { "message": "Problems parsing JSON", "documentation_url": "https://docs.github. |
| 10 GraphQL chunked | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #13, MAIN MOVED 6b18ff9->74653de] {"data":{"mergePullRequest":{"clientMutationId":null}}} |
| 10 GraphQL Expect: 100-continue, 4 KiB body | refuse | REFUSED 403 | REFUSED 403 | 502 502 Bad Gateway |
| 10 GraphQL api.github.com/graphql/ | refuse | REFUSED 403 | REFUSED 403 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 GraphQL api.github.com//GRAPHQL | refuse | REFUSED 403 | REFUSED 403 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 GraphQL github.com/graphql | refuse | passed 422 | REFUSED 403 | 422 <!DOCTYPE html> <html lang="en"> <head> <meta http-equiv="Content-type" content= |
| 10 GraphQL github.com/api/graphql | refuse | passed 422 | REFUSED 403 | 422 <!DOCTYPE html> <html lang="en"> <head> <meta http-equiv="Content-type" content= |
| 10 GraphQL uploads.github.com/graphql | refuse | REFUSED 403 | REFUSED 403 | 400 {"message":"Multipart form data required","request_id":"AE12:183B0B:865A5:AF282: |
| 10 GET uploads.github.com/repos/o/r (routes API?) | info | passed exit0 | REFUSED 403 | exit0 404 |
| 10 REST merge via uploads.github.com | refuse | REFUSED 403 | REFUSED 403 | 404 {"message":"Not found","request_id":"AE12:183B0B:86657:AF37C:6B0825D4"} |
| 10 GET /REPOS/O/R/PULLS/n (case accepted?) | info | passed 404 | passed 404 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 GET //repos/o/r/pulls/n/ (slashes accepted?) | info | passed 404 | passed 404 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 REST merge upper-case path | refuse | REFUSED 403 | REFUSED 403 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 REST merge trailing slash | refuse | REFUSED 403 | REFUSED 403 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 REST merge // path | refuse | REFUSED 403 | REFUSED 403 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 REST merge %6Derge | refuse | REFUSED 403 | REFUSED 403 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest", " |
| 10 REST merge /repositories/:id | refuse | REFUSED 403 | REFUSED 403 | 200 [MERGED #14, MAIN MOVED 74653de->ad22d38] { "sha": "ad22d387e105cd9df482e64431e181021243e6d2", "merged": true, "message":  |
| 10 REST merge GET + X-HTTP-Method-Override: PUT | refuse | passed 404 | REFUSED 403 | 404 { "message": "Not Found", "documentation_url": "https://docs.github.com/rest/pul |
| 10 REST merge POST + X-HTTP-Method-Override: PUT | refuse | passed 200 | REFUSED 403 | 200 { "url": "https://api.github.com/repos/ramtinJ95/nexus-guard-scratch/pulls/16",  |
| 10 REST merge Expect: 100-continue | refuse | REFUSED 403 | REFUSED 403 | 502 502 Bad Gateway |
| 10 REST review event approve (lower-case) | refuse | REFUSED 403 | REFUSED 403 | 422 { "message": "Unprocessable Entity", "errors": [ "Variable $event of type PullRe |
| 10 REST review ?event=APPROVE, body {} | refuse | REFUSED 403 | REFUSED 403 | 200 { "id": 6074125916, "node_id": "PRR_kwDOV83q2c8AAAABagvOXA", "user": { "login":  |
| 10 REST review duplicate key, APPROVE last | refuse | REFUSED 403 | REFUSED 403 | 422 { "message": "Unprocessable Entity", "errors": [ "User can only have one pending |
| 10 REST review duplicate key, APPROVE first | refuse | passed 200 | passed 200 | 422 { "message": "Unprocessable Entity", "errors": [ "User can only have one pending |
| 10 REST review JSON-escaped APPROVE | refuse | REFUSED 403 | REFUSED 403 | 422 { "message": "Unprocessable Entity", "errors": [ "User can only have one pending |
| 10 REST review form-encoded | refuse | REFUSED 403 | REFUSED 403 | 400 { "message": "Problems parsing JSON", "documentation_url": "https://docs.github. |
| 10 REST review gzip body | refuse | REFUSED 403 | REFUSED 403 | 400 { "message": "Problems parsing JSON", "documentation_url": "https://docs.github. |
| 10 REST PATCH git/refs/heads%2Fmain | refuse | REFUSED 403 | REFUSED 403 | 422 { "message": "Update is not a fast forward", "documentation_url": "https://docs. |

hook bodies (A, B) for refused rows, first 80 chars:
A 5 gh pr merge --merge: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[A] refused: gra
A 5 gh pr merge --squash: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[A] refused: gra
A 5 gh pr merge --rebase: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[A] refused: gra
A 5 gh pr merge --auto: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[A] refused: gra
A 6 REST PUT pulls/n/merge: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 7 GraphQL mergePullRequest: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 7 GraphQL enablePullRequestAutoMerge: {"message":"nexus-guard[A] refused: graphql enablePullRequestAutoMerge"}
A 7 GraphQL enqueuePullRequest: {"message":"nexus-guard[A] refused: graphql enqueuePullRequest"}
A 8 gh pr review --approve: failed to create review: non-200 OK status code: 403 OK body: "{\"message\":\"ne
A 8 REST review event APPROVE: {"message":"nexus-guard[A] refused: rest review APPROVE"}
A 8 REST pending review events APPROVE: {"message":"nexus-guard[A] refused: rest review APPROVE"}
A 8 GraphQL addPullRequestReview APPROVE: {"message":"nexus-guard[A] refused: graphql addPullRequestReview APPROVE"}
A 8 GraphQL submitPullRequestReview APPROVE: {"message":"nexus-guard[A] refused: graphql submitPullRequestReview APPROVE"}
A 9 REST POST merges (branch into main): {"message":"nexus-guard[A] refused: rest merge branch"}
A 9 REST PATCH git/refs/heads/main: {"message":"nexus-guard[A] refused: rest ref update on main"}
A 9 REST POST git/refs main: {"message":"nexus-guard[A] refused: rest ref create main"}
A 9 git push to main: send-pack: unexpected disconnect while reading sideband packet fatal: the remote
A 9 REST contents PUT (default branch): {"message":"nexus-guard[A] refused: rest contents write on main"}
A 9 REST contents PUT branch=main: {"message":"nexus-guard[A] refused: rest contents write on main"}
A 10 GraphQL aliased mergePullRequest: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL two ops + operationName: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL fragment on Mutation: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL JSON-escaped field name: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL review event in variable: {"message":"nexus-guard[A] refused: graphql addPullRequestReview APPROVE"}
A 10 GraphQL review input as variable: {"message":"nexus-guard[A] refused: graphql addPullRequestReview APPROVE"}
A 10 GraphQL event variable default: {"message":"nexus-guard[A] refused: graphql addPullRequestReview APPROVE"}
A 10 GraphQL batched array: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL GET ?query=mutation: {"message":"nexus-guard[A] refused: graphql unreadable (no query string)"}
A 10 GraphQL POST ?query= with empty body: {"message":"nexus-guard[A] refused: graphql unreadable (no query string)"}
A 10 GraphQL persisted query: {"message":"nexus-guard[A] refused: graphql unreadable (no query string)"}
A 10 GraphQL application/graphql raw body: {"message":"nexus-guard[A] refused: graphql unreadable (no query string)"}
A 10 GraphQL gzip body: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL chunked: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL Expect: 100-continue, 4 KiB body: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL api.github.com/graphql/: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL api.github.com//GRAPHQL: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 GraphQL uploads.github.com/graphql: {"message":"nexus-guard[A] refused: graphql mergePullRequest"}
A 10 REST merge via uploads.github.com: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 10 REST merge upper-case path: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 10 REST merge trailing slash: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 10 REST merge // path: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 10 REST merge %6Derge: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 10 REST merge /repositories/:id: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 10 REST merge Expect: 100-continue: {"message":"nexus-guard[A] refused: rest merge pull request"}
A 10 REST review event approve (lower-case): {"message":"nexus-guard[A] refused: rest review APPROVE"}
A 10 REST review ?event=APPROVE, body {}: {"message":"nexus-guard[A] refused: rest review APPROVE"}
A 10 REST review duplicate key, APPROVE last: {"message":"nexus-guard[A] refused: rest review APPROVE"}
A 10 REST review JSON-escaped APPROVE: {"message":"nexus-guard[A] refused: rest review APPROVE"}
A 10 REST review form-encoded: {"message":"nexus-guard[A] refused: review body unreadable"}
A 10 REST review gzip body: {"message":"nexus-guard[A] refused: rest review APPROVE"}
A 10 REST PATCH git/refs/heads%2Fmain: {"message":"nexus-guard[A] refused: rest ref update on main"}
B 5 gh pr merge --merge: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[B] refused: gra
B 5 gh pr merge --squash: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[B] refused: gra
B 5 gh pr merge --rebase: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[B] refused: gra
B 5 gh pr merge --auto: non-200 OK status code: 403 OK body: "{\"message\":\"nexus-guard[B] refused: gra
B 6 REST PUT pulls/n/merge: {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 7 GraphQL mergePullRequest: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 7 GraphQL enablePullRequestAutoMerge: {"message":"nexus-guard[B] refused: graphql mutation enablePullRequestAutoMerge 
B 7 GraphQL enqueuePullRequest: {"message":"nexus-guard[B] refused: graphql mutation enqueuePullRequest not allo
B 8 gh pr review --approve: failed to create review: non-200 OK status code: 403 OK body: "{\"message\":\"ne
B 8 REST review event APPROVE: {"message":"nexus-guard[B] refused: rest review event APPROVE"}
B 8 REST pending review events APPROVE: {"message":"nexus-guard[B] refused: rest review event APPROVE"}
B 8 GraphQL addPullRequestReview APPROVE: {"message":"nexus-guard[B] refused: graphql addPullRequestReview event APPROVE"}
B 8 GraphQL submitPullRequestReview APPROVE: {"message":"nexus-guard[B] refused: graphql submitPullRequestReview event APPROV
B 9 REST POST merges (branch into main): {"message":"nexus-guard[B] refused: rest POST /repos/ramtinj95/nexus-guard-scrat
B 9 REST PATCH git/refs/heads/main: {"message":"nexus-guard[B] refused: rest PATCH /repos/ramtinj95/nexus-guard-scra
B 9 REST POST git/refs main: {"message":"nexus-guard[B] refused: rest POST /repos/ramtinj95/nexus-guard-scrat
B 9 git push to main: send-pack: unexpected disconnect while reading sideband packet fatal: the remote
B 9 REST contents PUT (default branch): {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 9 REST contents PUT branch=main: {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 9+ GraphQL mergeBranch: {"message":"nexus-guard[B] refused: graphql mutation mergeBranch not allowed"}
B 9+ GraphQL createCommitOnBranch main: {"message":"nexus-guard[B] refused: graphql mutation createCommitOnBranch not al
B 9+ GraphQL updateRef main: {"message":"nexus-guard[B] refused: graphql mutation updateRef not allowed"}
B 9+ REST PATCH repo default_branch: {"message":"nexus-guard[B] refused: rest PATCH /repos/ramtinj95/nexus-guard-scra
B 10 GraphQL aliased mergePullRequest: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL two ops + operationName: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL fragment on Mutation: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL JSON-escaped field name: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL review event in variable: {"message":"nexus-guard[B] refused: graphql addPullRequestReview event APPROVE"}
B 10 GraphQL review input as variable: {"message":"nexus-guard[B] refused: graphql addPullRequestReview event APPROVE"}
B 10 GraphQL event variable default: {"message":"nexus-guard[B] refused: graphql addPullRequestReview event APPROVE"}
B 10 GraphQL batched array: {"message":"nexus-guard[B] refused: graphql batch"}
B 10 GraphQL GET ?query=mutation: {"message":"nexus-guard[B] refused: graphql over GET"}
B 10 GraphQL POST ?query= with empty body: {"message":"nexus-guard[B] refused: graphql with query-string parameters"}
B 10 GraphQL persisted query: {"message":"nexus-guard[B] refused: graphql unreadable (no query string)"}
B 10 GraphQL application/graphql raw body: {"message":"nexus-guard[B] refused: graphql unreadable (no query string)"}
B 10 GraphQL gzip body: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL chunked: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL Expect: 100-continue, 4 KiB body: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL api.github.com/graphql/: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL api.github.com//GRAPHQL: {"message":"nexus-guard[B] refused: graphql mutation mergePullRequest not allowe
B 10 GraphQL github.com/graphql: {"message":"nexus-guard[B] refused: github.com path is not git smart HTTP"}
B 10 GraphQL github.com/api/graphql: {"message":"nexus-guard[B] refused: github.com path is not git smart HTTP"}
B 10 GraphQL uploads.github.com/graphql: {"message":"nexus-guard[B] refused: uploads.github.com not allowed"}
B 10 GET uploads.github.com/repos/o/r (routes API?): {"message":"nexus-guard[B] refused: uploads.github.com not allowed"}
B 10 REST merge via uploads.github.com: {"message":"nexus-guard[B] refused: uploads.github.com not allowed"}
B 10 REST merge upper-case path: {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 10 REST merge trailing slash: {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 10 REST merge // path: {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 10 REST merge %6Derge: {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 10 REST merge /repositories/:id: {"message":"nexus-guard[B] refused: rest PUT /repos/~/~/pulls/1/merge not allowe
B 10 REST merge GET + X-HTTP-Method-Override: PUT: {"message":"nexus-guard[B] refused: method override header"}
B 10 REST merge POST + X-HTTP-Method-Override: PUT: {"message":"nexus-guard[B] refused: method override header"}
B 10 REST merge Expect: 100-continue: {"message":"nexus-guard[B] refused: rest PUT /repos/ramtinj95/nexus-guard-scratc
B 10 REST review event approve (lower-case): {"message":"nexus-guard[B] refused: rest review event approve"}
B 10 REST review ?event=APPROVE, body {}: {"message":"nexus-guard[B] refused: write with query-string parameters"}
B 10 REST review duplicate key, APPROVE last: {"message":"nexus-guard[B] refused: rest review event APPROVE"}
B 10 REST review JSON-escaped APPROVE: {"message":"nexus-guard[B] refused: rest review event APPROVE"}
B 10 REST review form-encoded: {"message":"nexus-guard[B] refused: write body is not a JSON object"}
B 10 REST review gzip body: {"message":"nexus-guard[B] refused: rest review event APPROVE"}
B 10 REST PATCH git/refs/heads%2Fmain: {"message":"nexus-guard[B] refused: rest PATCH /repos/ramtinj95/nexus-guard-scra
