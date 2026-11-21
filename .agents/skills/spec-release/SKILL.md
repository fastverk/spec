---
name: spec-release
description: Cut a spec module release — bump MODULE.bazel and LEDGER rows, satisfy source admission, tag vX.Y.Z, publish the registry entry, then bump the consumer smoke pin.
---

# Release the spec module

Read `docs/releasing.md` first; it records the two releases that shipped green
and could not be resolved by a consumer.

1. Change the spine only. Do not bump other vehicles (platform, desktop,
   plugin-shell, contracts) or invent a lockstep version.
2. Bump `module(version = ...)` in the root `MODULE.bazel` and every matching
   `spec` row in `LEDGER.md`; run `bash tools/ledger-check.sh`. Bump the two
   `.agents/` manifests to the same version.
3. Check the public surface for consumer-only failures: no `dev_dependency`
   that a public `.bzl` needs, no `isolate = True`. Run the consumer smoke with
   `--override_module=spec=<checkout>`.
4. Source admission: the four GitHub Actions checks (`ledger check`,
   `bazel build + test`, `registry consumer smoke`,
   `console typecheck + conformance + build`) green on the reviewed tree, with
   step outcomes inspected — a skipped plugin step is incomplete coverage.
5. Merge to `main`, tag the merge commit `vX.Y.Z` (must equal the module
   version). Merging to `main` can trigger the gate-image publication job; that
   needs explicit publication authority.
6. Publish the registry entry from a bazel-registry checkout.
7. Only after the entry resolves from `registry.tbzl.dev`, bump the pin in
   `smoke/consumer/MODULE.bazel`. That job proves the tag resolves.

Report the version, tag, registry entry, smoke result, and anything not done.
