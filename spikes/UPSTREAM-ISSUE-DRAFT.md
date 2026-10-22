# Draft only — not filed

## Title

OCI build aborts in kernel-module copy when an Alpine absolute symlink targets an unreadable host `/boot`

## Environment and impact

Gondolin 0.13.0, Linux x86-64, unprivileged build user, Docker 29.7.2. Reproduced with Node 26.8.1 and official Node 24.22.1. Host `/boot` is root-owned mode 0700. No Gondolin patches, privileged builds, or host permission changes were used.

A supported `gondolin build` with a Debian OCI rootfs terminates with SIGABRT while copying Alpine kernel modules, before creating the rootfs image. Changing the OCI image does not help. This blocks custom glibc images on this host unless a configuration workaround is used.

## Reproduction

```json
{
  "arch": "x86_64",
  "distro": "alpine",
  "oci": {
    "image": "debian:bookworm-slim",
    "runtime": "docker",
    "platform": "linux/amd64"
  }
}
```

Run `gondolin build --config config.json --output assets` as a user who cannot traverse host `/boot`.

```text
Copying all kernel modules for 6.18.58-0-virt into rootfs
terminate called after throwing an instance of 'std::filesystem::__cxx11::filesystem_error'
  what(): filesystem error: status: Permission denied [/boot/vmlinuz-virt]
```

The same failure occurs with `debian:bookworm`, `debian:trixie-slim`, and `ubuntu:24.04`. With `alpine.kernelPackage: "linux-lts"` and `kernelImage: "vmlinuz-lts"`, the inaccessible target becomes `/boot/vmlinuz-lts`.

### Small Node-only reproduction

On the affected host, `s1-cp-repro.mjs` creates a scratch source directory with `vmlinuz -> /boot/vmlinuz-virt` and executes:

```js
fs.cpSync(src, dest, { recursive: true, dereference: false });
```

Both Node versions abort with status 134. The same copy with `verbatimSymlinks: true` succeeds and preserves the link text. This comparison is an isolated test, **not a patch to Gondolin**.

`s1-cp-isolated.mjs` provides a self-contained reproduction without host `/boot`: it creates a scratch-only mode-000 directory, points the source symlink at a file inside it, and runs the copy in a child process. The child aborts with the same error; the parent restores permissions and removes the fixture. Run as a non-root user with `ulimit -c 0`.

## Root cause / evidence

Paths and line numbers below refer to the published 0.13.0 JavaScript artifacts:

- `dist/src/build/alpine.js:109–111` calls `syncKernelModules()` with `copyRootfsToInitramfs: false` for OCI builds.
- `dist/src/alpine/kernel-modules.js:8–9,25–29` resolves the **destination** inside the OCI rootfs and selects the **source** under the Alpine initramfs tree.
- `dist/src/alpine/kernel-modules.js:45–50` copies the entire module directory with `fs.cpSync(srcDir, dstDir, { recursive: true, dereference: false })`, omitting `verbatimSymlinks`.
- The source contains `initramfs-root/lib/modules/6.18.58-0-virt/vmlinuz -> /boot/vmlinuz-virt`. Debian's extracted `boot/` is empty, `lib -> usr/lib` is relative, and there is no top-level `vmlinuz*`. The troublesome absolute link comes from the **Alpine kernel package, not the OCI image**.
- `dist/src/alpine/rootfs.js:37–71` resolves the relative `lib -> usr/lib` inside the rootfs; `:73–91` checks destination containment. OCI absolute links are separately normalized in `:111–120`. That hardening does not apply to this later Alpine-source copy.
- Official Node v24.22.1 `lib/internal/fs/cp/cp-sync.js:149–159` selects the C++ recursive-copy fast path when no filter is supplied.
- Official Node v24.22.1 `src/node_file.cc:3946–3947` computes `weakly_canonical(absolute(src / symlink_target))`; an absolute target discards `src`, causing a host-root lookup. The following `dir_entry.is_directory()` at `:3954` also follows the target. The observed uncaught C++ filesystem exception terminates Node. Without syscall tracing we cannot identify which of those two metadata operations threw first.

**Security boundary:** this reproduces a host-root **metadata lookup** through an absolute source symlink. It does **not** establish a host-root write. The inspected destination remains within the scratch rootfs. `ls /boot/vmlinuz-virt` returns permission denied, so target existence cannot be determined. `strace` was not installed and was not added; no syscall-trace claim is made.

Node source: https://github.com/nodejs/node/blob/v24.22.1/src/node_file.cc#L3946

## Configuration-only workaround tested successfully

Use documented `postBuild.copy` to copy the **unchanged matching Alpine module tree** into `/lib/modules` before module synchronization. This copy implementation preserves symlinks, and the later sync sees the already-present matching version and skips the failing bulk copy:

```json
"postBuild": {
  "copy": [{ "src": "state/kernel-module-seed", "dest": "/lib/modules" }]
}
```

The seed contains `6.18.58-0-virt/` from the previous failed build's extracted Alpine initramfs; no module or library file was modified. Result: build completed in 35.131 seconds and the Debian VM booted successfully. This is version-coupled input staging, not an ideal user-facing solution: the seed must match the selected Alpine kernel exactly.

An upstream fix could investigate preserving link text (`verbatimSymlinks`) or explicit link-safe traversal, with tests for absolute links to inaccessible/missing host paths and relative links. Please retain rootfs destination-containment checks. No fix is applied by this spike.
