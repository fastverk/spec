import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The read model lives above this directory until the console is extracted
  // into its own repo. Tracing from the repo root so the imported payloads are
  // bundled rather than resolved at runtime.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,

  // A self-contained server bundle, for the container image. Harmless on
  // Vercel, which ignores it and does its own tracing.
  output: "standalone",

  /**
   * `@readmodel/` — where THIS deployment's read model comes from.
   *
   * The flagship serves this repository's own corpus, so the default is the
   * committed payloads. A per-tenant deployment (#52 — one console per consumer,
   * see docs/consumer-onboarding.md) sets `SPEC_READMODEL_DIR` to a directory of
   * payloads emitted from its own corpus, which is never committed here.
   *
   * ⛔ The alias must NOT also be declared in `tsconfig.json`'s `paths`. Next
   * installs `JsConfigPathsPlugin` into webpack's resolver and it taps
   * `described-resolve`, which runs BEFORE `resolve.alias` — a `paths` entry
   * wins silently and this override does nothing. Measured: the first attempt
   * built against the wrong corpus and said nothing. `tsc` resolves the imports
   * through `types/readmodel.d.ts` instead.
   *
   * ⚠ `resolve()` so a RELATIVE value means what the person who typed it meant —
   * relative to where `next build` ran, not to webpack's context, which is a
   * different directory and would fail with a module-not-found naming a path
   * nobody wrote.
   */
  webpack: (config) => {
    const dir = process.env["SPEC_READMODEL_DIR"]?.trim();
    config.resolve.alias["@readmodel"] = dir
      ? resolve(dir)
      : fileURLToPath(new URL("../services/spec/readmodel", import.meta.url));
    return config;
  },
};
export default nextConfig;
