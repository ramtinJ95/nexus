# One services.yaml schema verification

Verified in this task's pylon on 2026-10-27, on branch `fix/issue-128-one-services-schema`, against
main at `137242d`. No live control plane, node, image or other thread was touched.

## What runs

`run.sh` checks out main in a temporary worktree and runs the same two things there and on this branch:

- `compare.ts` feeds each `.nexus/services.yaml` case to both real validators. The Nexus side is
  `parseServicesFile` in `src/project.ts`, which the Docker backend reads the file with. The pylon side is
  `GuestServices` in `src/pylon-vm/services.ts`, the real pylon controller's supervisor, running the `ensure`
  every boot runs against a guest whose only file is that case. A stub stands in for the Gondolin VM: every
  command succeeds and every port answers, so only the supervisor's own checks can refuse a file. It then
  feeds each ad hoc service to both boundaries of `nexus service start`: `serviceDecl`, which the in-pylon API
  parses the request with, and the controller's `service-start` action. It exits with the number of
  disagreements.
- This branch's `src/project.test.ts`, its two agreement tests only.

Captures, each with its exit code:

- `main.txt` and `branch.txt`, from `compare.ts`. Main has 15 disagreements, the branch none.
- `main-test.txt` and `branch-test.txt`, from the tests. Both fail on main, listing every case where the two
  sides disagree. Both pass on the branch.
- `login-shell.txt`, run in this pylon. A service's script exports the env the file gives, then runs the
  command in a login shell (`startService` in `src/pylon-vm/guest.ts`). The login shell sets
  `NEXUS_THREAD_ID` again, so a value from the file never reaches the command. `NEXUS_FOO`, which Nexus does
  not set, gets through.

## What was not checked

- No real pylon VM booted a refused file. The supervisor's code ran for real, against a stub VM.
- Code search and the contents API found no `.nexus/services.yaml` on the default branch of any of the
  person's 74 GitHub repos, so no file in use there is newly refused. Other branches and repos were not
  searched.
