/**
 * The content address — the name a proposal has that nothing else can give it.
 *
 * RFC-002 §5: `Proposal.id : Hash`, a content address over `(parent, author,
 * ops)`. Until this file existed the console answered `"address": null` with
 * `address_computed_by: "the door, in the build"` beside it, and the build had
 * no door. So a proposal had no name at all, `spec replay <id>` (§12 P1) had
 * nothing to take, and §9.1's equal-citizen gate — *a click and a chat that
 * author the same change produce the same id* — was unfalsifiable rather than
 * merely unproven.
 *
 * ## What the address is taken over, and what it deliberately is not
 *
 *     sha256:<64 hex>  over  canonicalJson({ author, ops, parent })
 *
 * Three fields. **`surface` and `intent` are excluded, and that exclusion is the
 * whole point.** RFC-002 §4.1: `Door.admit` takes `{parents, ops}` and *not*
 * provenance, "so a chat-authored change and a click-authored change are
 * indistinguishable downstream — enforced by the signature, not by review
 * discipline". The address is that signature made into a name: two proposals
 * that differ only in which surface composed them, or in the prose the author
 * typed on the way, are ONE proposal with two provenance records.
 *
 * ⚠ This is why the address is NOT a hash of `canonical`. `canonical` (the bytes
 * stored in the log) carries `surface` and `intent` on purpose — provenance is
 * kept, it just does not get a vote. Hashing the stored line would make the two
 * surfaces produce different ids and quietly invert §9.1.
 *
 * ⛔ `author` IS in the pre-image. That is not provenance in the §4.1 sense: it
 * is invariant ⑤ ("nothing is attributed to nobody"), and two people proposing
 * the same ops are making two proposals, each of which someone is answerable
 * for. What §9.1 collapses is the surface, never the person.
 *
 * ## Stability
 *
 * The pre-image is `canonicalJson`, which sorts keys by UTF-8 bytes and refuses
 * to serialize a non-integer number — see the comments there. Both properties
 * exist because this string is a pre-image: a key order that depends on a build
 * flag, or a float whose rendering differs between ryu and JavaScript, is two
 * implementations writing different permanent names for the same proposal.
 *
 * `conformance/address_cases.json` pins the bytes and the digests. Three
 * implementations execute it — this one, `services/spec/src/proposal.rs`, and
 * `conformance/check_conformance.py`, which canonicalizes independently in
 * stdlib Python rather than trusting either.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical";

/** The digest is named in the address. A bare hex string ages badly. */
export const ADDRESS_PREFIX = "sha256:";

/** ⚠ Lower-case hex, exactly 64 of them. Migration 0004 CHECKs the same shape. */
export const ADDRESS_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Everything the door sees, and nothing it does not.
 *
 * The field names are the JSON keys: `canonicalJson` sorts them, so the order
 * they are written in here has no effect on the bytes. Stated because reordering
 * this type looks like it should matter and must not.
 */
export type PreImage = {
  author: string;
  ops: unknown[];
  parent: string;
};

/** The exact bytes the digest is taken over. Returned, not just hashed, so a caller can check the work. */
export function addressPreImage(p: PreImage): string {
  return canonicalJson({ author: p.author, ops: p.ops, parent: p.parent });
}

/** The content address. */
export function contentAddress(p: PreImage): string {
  return ADDRESS_PREFIX + createHash("sha256").update(addressPreImage(p), "utf8").digest("hex");
}

/**
 * The address of an already-written record, from its stored `canonical` bytes.
 *
 * ⛔ Recomputed from the body, never read from the `address` field, because the
 * point of the exercise is to be able to disagree with it. A record whose stored
 * address is not the address of its own body is a record that lies about its own
 * name, and `tools/proposals/replay.py` refuses one.
 *
 * Returns null if the canonical bytes do not parse or do not carry the three
 * fields — a malformed record is skipped by every reader here, never fatal.
 */
export function addressOfCanonical(canonical: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(canonical);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const author = o["author"];
  const parent = o["parent"];
  const ops = o["ops"];
  if (typeof author !== "string" || typeof parent !== "string" || !Array.isArray(ops)) return null;
  try {
    return contentAddress({ author, ops, parent });
  } catch {
    // canonicalJson refuses a non-integer number. A record carrying one cannot
    // have been written by this door; it has no address rather than a wrong one.
    return null;
  }
}
