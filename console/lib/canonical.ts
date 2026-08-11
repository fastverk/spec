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
    // ryu does not, so the same value would produce different bytes. Refuse
    // rather than write something that cannot be reproduced.
    if (!Number.isFinite(v)) throw new Error(`canonical json: ${v} is not a finite number`);
    if (!Number.isInteger(v)) {
      throw new Error(
        `canonical json: ${v} is not an integer — a float's rendering differs between ` +
          "implementations, and this string is the pre-image of a content address",
      );
    }
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort(byUtf8);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonical json: cannot serialize ${typeof v}`);
}
