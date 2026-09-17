/**
 * Canonical JSON — the pre-image of a content address.
 *
 * Port of `canonical_json` / `write_canonical` (services/spec/src/proposal.rs:
 * 700-738). Object keys sorted at every level, no whitespace.
 *
 * ⛔ Written out rather than delegated to JSON.stringify's replacer, for the same
 * reason the Rust one is written out rather than delegated to serde_json: key
 * order must not depend on anything but the keys.
 */

/**
 * ⚠ Sort by UTF-8 BYTES, not by JavaScript's default.
 *
 * Rust sorts `String` by byte order. `Array.prototype.sort()` with no comparator
 * sorts by UTF-16 code unit, and the two disagree across the astral-plane
 * boundary: a key starting U+10000 sorts BELOW one starting U+E000 in UTF-16 and
 * ABOVE it in UTF-8. Op field names are ASCII today, so this cannot bite today —
 * which is exactly when to fix it, because the failure mode is two
 * implementations writing different permanent bytes for the same proposal.
 */
const enc = new TextEncoder();
function byUtf8(a: string, b: string): number {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const xi = x[i] as number;
    const yi = y[i] as number;
    if (xi !== yi) return xi - yi;
  }
  return x.length - y.length;
}

export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    // ⛔ A float in a canonical proposal is precisely the hash-stability hazard
    // this function exists to eliminate: JS renders 1e21 as "1e+21" and Rust's
    // ryu renders it "1e21", so the same value would produce different bytes.
    // Refuse rather than write something that cannot be reproduced.
    if (!Number.isFinite(v)) throw new Error(`canonical json: ${v} is not a finite number`);
    // ⚠ SAFE integer, not merely integer. `Number.isInteger(1e21)` is TRUE — it
    // is a whole number, just one no `i64` holds — and `String(1e21)` is
    // "1e+21", which is the exponent form this comment has always named as the
    // hazard and the check did not catch. Measured by the test beside this file,
    // not inferred. Below 2^53 `String()` never uses exponential notation and
    // the value round-trips through an f64 and an i64 alike, so the safe-integer
    // range is exactly the range where the two renderings cannot diverge.
    if (!Number.isSafeInteger(v)) {
      throw new Error(
        `canonical json: ${v} is not a safe integer — its rendering differs between ` +
          "implementations, and this string is the pre-image of a content address",
      );
    }
    return String(v);
  }
  if (typeof v === "string") {
    // ⛔ A lone surrogate is representable in a JavaScript string and NOT in a
    // Rust `String`. `JSON.stringify` escapes it to `\ud800` and produces
    // perfectly valid-looking JSON; serde_json's parser REFUSES the same bytes
    // ("lone leading surrogate in hex escape"). So a proposal carrying one would
    // get a content address here that no other implementation can reproduce —
    // not a disagreement about bytes, but a name only one reader can compute.
    // Refuse it where the bytes are made, which is the only place that can.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)) {
      throw new Error(
        "canonical json: the string carries an unpaired surrogate — it has no UTF-8 " +
          "encoding, so no other implementation could reproduce this pre-image",
      );
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort(byUtf8);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonical json: cannot serialize ${typeof v}`);
}
