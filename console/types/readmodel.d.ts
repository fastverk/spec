/**
 * `@readmodel/*.json` — the read-model payloads, wherever this deployment's are.
 *
 * ⛔ DECLARED HERE RATHER THAN IN `tsconfig.json`'s `paths`, and the difference
 * is load-bearing. Next installs `JsConfigPathsPlugin` into webpack's resolver
 * and it taps `described-resolve`, which runs BEFORE `resolve.alias` — so a
 * `paths` entry for `@readmodel/*` silently wins over the alias in
 * `next.config.mjs` and `SPEC_READMODEL_DIR` does nothing at all. Measured: the
 * first attempt at this seam built cleanly against the wrong corpus, printed no
 * warning, and baked in this repository's `corpus_version` while pointed at a
 * different one.
 *
 * An ambient declaration gives `tsc` a type without giving webpack a path, which
 * is exactly the division of labour required: `tsc` type-checks, the bundler
 * decides which bytes.
 *
 * ⚠ The type is deliberately weak. These payloads are DATA, validated at import
 * by `lib/readmodel.ts::ingest` against the route→field table — a structural type
 * here would be a second, unchecked description of the same envelope, and the
 * one that drifts. `ingest` fails the build with a named reason; a `.d.ts` would
 * only fail `tsc`, and only for this repository's own payloads.
 */
declare module "@readmodel/*.json" {
  const payload: Record<string, unknown>;
  export default payload;
}
