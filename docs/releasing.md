# Releasing spec

Spec is a Bazel module before it is anything else: the corpus gates, the
authoring vocabulary and the fanout derivation are all consumed by *other*
repositories through `bazel_dep(name = "spec", ...)`. A release is therefore
not "we tagged it" — it is "a consumer can resolve it", and those have been
different things twice.

## What went wrong the two times it went wrong

Both were invisible from inside this repository, and both shipped green:

* **#58** — `rules_shell` was declared `dev_dependency = True`. Dev deps are
  dropped from every module graph but this one's, so `sh_test` resolved here
  and nowhere else. The first external corpus got
  `No repository visible as '@rules_shell'`.
* **#59** — `use_extension(..., isolate = True)` on the crate extension. The
  usage was dev-scoped, but Bazel rejects the *keyword* before it considers the
  scope, so a consumer's module graph failed to compute at all — with an error
  naming an experimental flag and not spec.

Neither is a subtle bug. Both are simply unreachable from the position this
repo's own CI stands in, which is why the checklist below ends where it does.

## The checklist

1. **Merge to main, green.** The `gate` job builds the working tree; the
   `consumer` job builds `smoke/consumer` twice — once against the published
   pin, once against the commit under review. The second is what catches a
   consumer-visible break *before* it is published.

2. **Bump `module(version = ...)`** in `MODULE.bazel` if main is not already at
   the version you intend to publish.

3. **Simulate the registry ratchet** *before* tagging. `tomato-bazel/gate`
   blocks any new module version that makes D2 (undeclared toolchain leak), D3
   (unnamespaced repo chosen on a shared extension) or C1 (atom multi-version)
   worse. There is no override and admins are not exempt, so a ratchet failure
   discovered after tagging means a new version rather than a fixed one. Run
   the gate at the ref `gate-ratchet.yml` pins, over a staged registry carrying
   the proposed `MODULE.bazel`.

   The three questions worth asking by hand first, because they answer most
   cases in a minute:
   * Did a `bazel_dep` move from `dev_dependency = True` to non-dev, or a new
     non-dev one appear? That changes what consumers resolve.
   * Does any new tag on a *foreign* extension pass an explicit `name =`? That
     is what D3 means by "chose" — a `python.toolchain(python_version = ...)`
     chooses nothing and is fine; an `oci.pull(name = "distroless_static")` is
     the exact bug D3 exists for.
   * Does a module in the registry depend on spec? If so, a new selection here
     can silently upgrade what *it* resolves.

4. **Tag and push** `vX.Y.Z` on the merge commit.

5. **Publish to `tomato-bazel/bazel-registry`**: `modules/spec/X.Y.Z/MODULE.bazel`
   (a copy of the tag's), `modules/spec/X.Y.Z/source.json` (the sha256 of the
   GitHub tag tarball, base64, as `integrity`), and the version appended to
   `modules/spec/metadata.json`. Regenerate the README with its own tool rather
   than by hand. Land it as a PR — the real ratchet runs there.

   ⚠ That repository is **shared and often parked on someone else's branch**.
   Check `git branch --show-current` before committing, or work from a
   worktree off `origin/main`.

6. **Bump the smoke pin.** `smoke/consumer/MODULE.bazel` moves to the version
   you just published, and CI's first consumer step resolves it from
   `registry.tbzl.dev` for real. **This is the step that proves the release
   exists**, and it is deliberately last: until the registry entry is live, the
   pin cannot resolve, so a green `consumer` job after the bump is the release
   verifying itself.

   For v0.7.0 this had to be done by hand, in another repository, by a person
   who thought to try. That is the gap the smoke module closes.

## Known-flaky, not your change

* **"warm the tectonic cache" fails with 429** — the LaTeX bundle CDN
  (`fullyjustified.net`) rate-limiting the org, not the PR. Reruns *feed* the
  limiter; back off before retrying. The Actions cache added in #62 converges
  across attempts because a partial download is still saved, but the cache is
  branch-scoped, so `main` starts cold until one run gets through.
* **A network error naming `registry.tbzl.dev`** in the consumer job is the
  Fastly CDN, not the release. Bazel only falls through registries on a 404, so
  a mirror second in line would not absorb an outage.
