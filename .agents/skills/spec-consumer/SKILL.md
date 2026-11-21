---
name: spec-consumer
description: Onboard another repository as a spec consumer — bazel_dep on spec, wire its corpus to the corpus and authoring gates, derive the read model, and optionally stand up a console.
---

# Onboard a consumer corpus

Follow `docs/consumer-onboarding.md`; `smoke/consumer/` is the worked example and
is held green in CI against the published registry entry.

1. **Resolve spec from the registry.** In the consumer's `MODULE.bazel`, add
   `bazel_dep(name = "spec", version = "<latest tag>")` plus `rules_rdf` and
   `rules_jena` at the versions spec's own `MODULE.bazel` pins. In its
   `.bazelrc`, list `https://registry.tbzl.dev/` then `https://bcr.bazel.build/`
   (passing any `--registry` drops Bazel's default).
2. **Gate the corpus.** One TTL per act; the corpus directory contains only the
   corpus.

   ```starlark
   load("@rules_rdf//rdf:dataset.bzl", "rdf_dataset")
   load("@spec//rdf:gates.bzl", "spec_corpus_gates")
   load("@spec//rdf:authoring_gates.bzl", "spec_authoring_gates")

   rdf_dataset(
       name = "corpus",
       srcs = glob(["*.ttl"]),
       in_format = "turtle",
       deps = ["@spec//rdf:authoring_vocab"],  # NOT :vocab — gates go vacuous
   )
   spec_corpus_gates(name = "corpus_gates", dataset = ":corpus")
   spec_authoring_gates(name = "corpus_authoring", dataset = ":corpus")
   ```

3. **Import honestly.** A fresh corpus reads R0, dark fraction 100%. Use the
   `spec-corpus` skill for import and decomposition.
4. **Read model.** Derive the eight console payloads in the consumer's own build
   from the same dataset (`docs/consumer-onboarding.md` §3.2). Add a
   corpus-is-the-corpus check comparing `srcs` with `glob(["*.ttl"])`.
5. **Console (optional).** One console per consumer; see §3.3 and
   `docs/rfc-003-hosted-console.md`.

Verify with `bazel --nohome_rc test //...` in the consumer, and confirm each gate
reports a nonzero population. When testing unreleased spec changes, use
`--override_module=spec=/path/to/spec` and say that the result does not prove
the published version resolves.
