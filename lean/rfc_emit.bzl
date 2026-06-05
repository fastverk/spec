"""rfc_emit_targets — the generic per-RFC documentation emit shape.

spec hosts the Lean spec-emit framework (`Aion.Emit.TtlEmit`,
`Aion.Emit.MdEmit`, `Aion.Corpus.Schema`). This macro wires the three standard
per-RFC emits — TTL, rationale card, and spec.md — over a consumer's per-RFC
Lean module plus the consumer's thin runner/emit-helper `.lean` files, injecting
the spec framework libraries automatically.

A consumer supplies its own file paths via the `emit_helpers` / `runners`
structs (so each project keeps its own namespace + layout); the spec
framework srcs are resolved here with `Label()` so they bind to spec
regardless of the caller's package.

    load("@spec//lean:rfc_emit.bzl", "rfc_emit_targets")

    rfc_emit_targets(
        num = "0036",
        rfc_src = "MyProj/Spec/Graph/Rfc0036.lean",
        other_rfc_srcs = [...],
        emit_helpers = struct(
            ttl = "MyProj/Emit/RfcTtlEmit.lean",
            card = "MyProj/Emit/RfcCardEmit.lean",
            spec_md = "MyProj/Emit/SpecMdEmit.lean",
        ),
        runners = struct(
            ttl = "MyProj/Emit/Rfc0036TtlRun.lean",
            card = "MyProj/Emit/Rfc0036CardRun.lean",
            spec_md = "MyProj/Emit/Rfc0036SpecMdRun.lean",
        ),
        inference_src = "MyProj/Logic/Inference.lean",
    )

generates `rfc_0036_ttl_generated`, `rfc_0036_card_generated`, and
`rfc_0036_spec_md_generated`.
"""

load("@rules_lean//lean:lean.bzl", "lean_emit")

# spec-hosted Lean spec-emit framework. Label()-wrapped so they resolve
# to spec even when the macro is instantiated in a consumer's package.
_TTL_EMIT_LIB = Label("//lean:Spec/Emit/TtlEmit.lean")
_MD_EMIT_LIB = Label("//lean:Spec/Emit/MdEmit.lean")
_SCHEMA_LIB = Label("//lean:Spec/Corpus/Schema.lean")

def rfc_emit_targets(
        num,
        rfc_src,
        other_rfc_srcs,
        emit_helpers,
        runners,
        inference_src,
        out_prefix = "RFC-"):
    """Generate the ttl / card / spec_md `lean_emit` targets for one RFC.

    Args:
      num: four-digit RFC number string (e.g. "0036").
      rfc_src: path (in the caller's package) to the per-RFC Lean module.
      other_rfc_srcs: the other RFC modules, imported by the spec.md runner so
        its CorpusGraph spans the whole corpus (transitive deps + inverse edges).
      emit_helpers: struct(ttl, card, spec_md) of the caller's emit-helper paths.
      runners: struct(ttl, card, spec_md) of the caller's per-RFC runner paths.
      inference_src: caller's Logic/Inference.lean path (spec.md corpus graph).
      out_prefix: emitted filename prefix (default "RFC-").
    """
    lean_emit(
        name = "rfc_{}_ttl_generated".format(num),
        srcs = [_TTL_EMIT_LIB, _SCHEMA_LIB, rfc_src, emit_helpers.ttl, runners.ttl],
        entry = runners.ttl,
        out = "{}{}.ttl".format(out_prefix, num),
    )

    lean_emit(
        name = "rfc_{}_card_generated".format(num),
        srcs = [_SCHEMA_LIB, rfc_src, emit_helpers.card, runners.card],
        entry = runners.card,
        out = "{}{}-card.md".format(out_prefix, num),
    )

    # spec.md imports every RFC module so the runner's CorpusGraph covers the
    # whole corpus (Aion.Logic.Inference needs it for transitive dependsOn +
    # inverse extendedBy).
    lean_emit(
        name = "rfc_{}_spec_md_generated".format(num),
        srcs = [
            _MD_EMIT_LIB,
            _SCHEMA_LIB,
            inference_src,
            rfc_src,
        ] + other_rfc_srcs + [
            emit_helpers.spec_md,
            runners.spec_md,
        ],
        entry = runners.spec_md,
        out = "{}{}-spec.md".format(out_prefix, num),
    )
