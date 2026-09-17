/**
 * The closed op vocabulary and the door that checks against it.
 *
 * Port of `services/spec/src/proposal.rs`. RFC-002 §5's table, one row per
 * constructor: 16, plus `retractTerm`.
 *
 * ⛔ The author is taken from the session, never from the request body. A
 * proposal cannot name its own author.
 */
import { contentAddress } from "./address";
import { canonicalJson } from "./canonical";
import { MACHINE_PREFIX } from "./evaluation";

export type Capability = "Author" | "Kernel";

export type OpSpec = {
  kind: string;
  required: string[];
  optional: string[];
  exactlyOneOf: string[];
  capability: Capability;
};

export const SURFACES = ["Meridian", "Chat", "Ingest", "Agent"];
export const RUNGS = ["R0", "R1", "R2", "R3", "R4", "R5"];
/** au:Outcome for an ADJUDICATION. Not the evaluation outcomes — see evaluation.ts. */
export const ADJUDICATION_OUTCOMES = ["Narrow", "Prioritize", "Exempt", "Escalate", "Refute"];

/**
 * ⚠ Count is asserted at 17 by `proposal.rs`'s `vocabulary_is_closed_and_total`
 * and by `check_wiring.py`. Adding one here without adding it there is the drift
 * those assertions exist to make loud.
 */
export const OPS: OpSpec[] = [
  { kind: "assertNS", required: ["subject", "text", "discipline", "rung"],
    optional: ["quantity", "bound_kind", "bound_value", "guard", "defeasible", "scope",
      "citation", "modality", "instrument", "project"], exactlyOneOf: [], capability: "Author" },
  { kind: "amendNS", required: ["subject", "text"],
    optional: ["quantity", "bound_kind", "bound_value", "guard", "defeasible", "scope",
      "citation", "modality", "instrument", "discipline"], exactlyOneOf: [], capability: "Author" },
  // retract never deletes; it demotes. So it needs a reason — a demotion with no
  // stated ground is indistinguishable from a mistake.
  { kind: "retractNS", required: ["subject", "reason"], optional: [], exactlyOneOf: [], capability: "Author" },
  // `project` scopes the binding. Without it a term binds in EVERY corpus that
  // uses the surface, and `public` is a term in more than one of them.
  { kind: "bindTerm", required: ["term", "definition"], optional: ["discipline", "project"],
    exactlyOneOf: [], capability: "Author" },
  { kind: "alignTerm", required: ["term", "aligns_to"], optional: ["discipline", "project"],
    exactlyOneOf: [], capability: "Author" },
  // The 17th. Decomposition is machine work that can be WRONG: reading terms off
  // the author's markup pulled `or`, `act` and `rule, not rows` into Studio's
  // queue. Deliberately NOT alignTerm to a sentinel — aligning asserts two things
  // mean the same, this asserts one of them means nothing.
  { kind: "retractTerm", required: ["term"], optional: ["reason", "discipline", "project"],
    exactlyOneOf: [], capability: "Author" },
  // All six referent fields required: an untyped quantity cannot participate in
  // empty-envelope detection at all, so its conflicts are invisible rather than absent.
  { kind: "declQuantity",
    required: ["quantity", "dimension", "unit", "measurement_point", "estimator", "time_base"],
    optional: ["label"], exactlyOneOf: [], capability: "Author" },
  { kind: "assertDisjoint", required: ["quantity", "disjoint_from"], optional: ["rationale"],
    exactlyOneOf: [], capability: "Author" },
  { kind: "declScope", required: ["scope", "label"], optional: ["parent"], exactlyOneOf: [], capability: "Author" },
  { kind: "narrowGuard", required: ["subject", "guard"], optional: ["rationale"], exactlyOneOf: [], capability: "Author" },
  { kind: "promote", required: ["subject", "rung", "evidence"], optional: [], exactlyOneOf: [], capability: "Author" },
  { kind: "demote", required: ["subject", "rung", "reason"], optional: [], exactlyOneOf: [], capability: "Author" },
  { kind: "groundNS", required: ["subject"], optional: ["is_axiom", "derived_via"],
    exactlyOneOf: ["is_axiom", "derived_via"], capability: "Author" },
  { kind: "openConflict", required: ["conflict", "kind", "parties"], optional: ["quantity", "owner"],
    exactlyOneOf: [], capability: "Author" },
  { kind: "witness", required: ["conflict", "party"], optional: ["bound_kind", "bound_value", "guard"],
    exactlyOneOf: [], capability: "Author" },
  { kind: "adjudicate", required: ["conflict", "outcome", "rationale"], optional: ["expires"],
    exactlyOneOf: [], capability: "Author" },
  { kind: "declarePrecedence", required: ["higher", "lower", "rationale"], optional: [],
    exactlyOneOf: [], capability: "Kernel" },
];

export const opSpec = (kind: string) => OPS.find((o) => o.kind === kind);

export type Principal = { sub: string; email: string; kernel: boolean; agent: boolean };
export type Verdict = "OK" | "QUEUED" | "REJECTED";

/**
 * `au:Verdict` — the door's answer for the proposal AS A WHOLE, in the
 * ontology's own words (rdf/ontology/authoring.ttl). Distinct from the per-op
 * `Verdict` above, which is this door's internal three-way split.
 *
 * The proposal's verdict is the weakest of its ops':
 *
 *   Rejected  some op is not well-formed. NOTHING is appended — a half-written
 *             proposal is a permanent record of something nobody proposed.
 *   Queued    every op is well-formed and at least one is out of capability.
 *             Partial admission is normal (§5); the proposal is appended and the
 *             queued ops wait for an operator.
 *   Admitted  every op is well-formed and in capability.
 *
 * ⛔ What this verdict does NOT include is the gate set. RFC-002 §7.1 lists what
 * the door can prove — typing and capability — and the gates are a `GROUP BY …
 * HAVING` over the POST-admission graph, which needs a query engine and the
 * whole corpus. That verdict is the build's, on the promotion PR, and the two
 * are deliberately not conflated: this one is decidable from the proposal alone.
 */
export const PROPOSAL_VERDICTS = ["Admitted", "Queued", "Rejected"] as const;
export type ProposalVerdict = (typeof PROPOSAL_VERDICTS)[number];

const isEmpty = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

/**
 * Why this value cannot be part of a content address, or null if it can.
 *
 * ⛔ This exists because `canonicalJson` THROWS on a value it cannot render
 * reproducibly, and a throw inside the write route is a 500 — an author told
 * "internal server error" for typing `1.5` into a bound. The door's job is to
 * refuse legibly, so the same rule is applied here, per op, where the refusal
 * lands in the per-op report with the field named.
 *
 * The two cases are the two ways two implementations end up writing different
 * permanent bytes for the same proposal:
 *
 *   a non-integer number   JavaScript renders 1e21 as "1e+21" and Rust's ryu
 *                          does not. There is no float in the op vocabulary
 *                          today — `bound_value` arrives from a form as a
 *                          string — so this refuses something nothing sends,
 *                          which is exactly when to refuse it.
 *   an unpaired surrogate  representable in a JS string, not in a Rust `String`.
 *                          See lib/canonical.ts.
 */
function unrepresentable(v: unknown, path: string): string | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return `\`${path}\` is ${v}, which JSON cannot represent`;
    // ⚠ SAFE integer. `Number.isInteger(1e21)` is true and `String(1e21)` is
    // "1e+21", which Rust's ryu spells "1e21" — see lib/canonical.ts.
    if (!Number.isSafeInteger(v)) {
      return (
        `\`${path}\` is ${v}, which is not a safe integer; its rendering differs between ` +
        "implementations and this value is part of a content address — send it as a string"
      );
    }
    return null;
  }
  if (typeof v === "string") {
    return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)
      ? `\`${path}\` carries an unpaired surrogate, which has no UTF-8 encoding`
      : null;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const why = unrepresentable(v[i], `${path}[${i}]`);
      if (why) return why;
    }
    return null;
  }
  if (typeof v === "object" && v !== null) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const why = unrepresentable(k, `${path} key`) ?? unrepresentable(val, `${path}.${k}`);
      if (why) return why;
    }
  }
  return null;
}

/** Check one op. `queued` — not `rejected` — is what a capability shortfall yields. */
export function checkOp(op: unknown, who: Principal): { verdict: Verdict; reason: string } {
  const bad = (reason: string) => ({ verdict: "REJECTED" as const, reason });
  if (typeof op !== "object" || op === null || Array.isArray(op)) return bad("op is not a JSON object");
  const o = op as Record<string, unknown>;
  const kind = typeof o["op"] === "string" ? o["op"] : "";
  if (!kind) return bad("op has no `op` field");
  const spec = opSpec(kind);
  if (!spec) return bad(`\`${kind}\` is not in the closed op vocabulary`);

  for (const field of spec.required) {
    if (!(field in o)) return bad(`\`${kind}\` requires \`${field}\``);
    if (isEmpty(o[field])) return bad(`\`${kind}\`.\`${field}\` is present but empty`);
  }

  // No unknown fields. A silently-dropped key is how a typo'd `bound_vlaue`
  // becomes an unbounded claim that passes every gate.
  for (const key of Object.keys(o)) {
    if (key === "op" || spec.required.includes(key) || spec.optional.includes(key)) continue;
    return bad(`\`${kind}\` has no field \`${key}\``);
  }

  // Before anything semantic: can these bytes even be a pre-image? An op that
  // cannot be canonicalized has no content address, so it has no name, so it
  // cannot be reviewed or replayed — that is a well-formedness failure, not a
  // serialization detail to be discovered later inside a 500.
  const un = unrepresentable(o, kind);
  if (un) return bad(un);

  if (spec.exactlyOneOf.length > 0) {
    const present = spec.exactlyOneOf.filter((f) => f in o && !isEmpty(o[f]));
    if (present.length !== 1) {
      return bad(
        `\`${kind}\` needs exactly one of ${JSON.stringify(spec.exactlyOneOf)}; got ${present.length}`,
      );
    }
  }

  const rung = o["rung"];
  if (typeof rung === "string" && !RUNGS.includes(rung)) {
    return bad(`\`${rung}\` is not a rung (expected one of ${RUNGS.join(", ")})`);
  }
  const outcome = o["outcome"];
  if (typeof outcome === "string" && !ADJUDICATION_OUTCOMES.includes(outcome)) {
    return bad(`\`${outcome}\` is not an au:Outcome (expected one of ${ADJUDICATION_OUTCOMES.join(", ")})`);
  }

  // `is_axiom: false` is not a grounding. Without this it satisfies
  // exactlyOneOf by being present, which would let "this is not an axiom" pass as
  // a ground — the precise vacuity the grounding lint exists to catch.
  if ("is_axiom" in o && o["is_axiom"] !== true) {
    return bad("`groundNS`.`is_axiom` must be `true` if present — use `derived_via` otherwise");
  }

  // A conflict needs at least two parties. A one-party "conflict" is a claim.
  if (kind === "openConflict") {
    const n = Array.isArray(o["parties"]) ? (o["parties"] as unknown[]).length : 0;
    if (n < 2) return bad(`\`openConflict\` needs at least 2 parties; got ${n}`);
  }

  // ⛔ A machine may not author. RFC-004a §4: a machine principal reports what
  // it measured (POST /api/evaluation) and may not author, amend or withdraw a
  // requirement. The evaluation route is the only place a `machine:` principal
  // is ever minted, and it never reaches this door — this is the second lock,
  // for the day something wires one through.
  if (who.sub.startsWith(MACHINE_PREFIX)) {
    return bad(`machine principals may not author; \`${kind}\` is out of capability`);
  }

  if (who.agent) {
    if (kind !== "assertNS") {
      return bad(`agent principals may only \`assertNS\`; \`${kind}\` is out of capability`);
    }
    if (o["rung"] !== "R0") return bad("agent principals may only assert at R0");
  }

  // Capability shortfall QUEUES rather than rejects: partial admission is normal,
  // so a proposal mixing author and kernel ops splits rather than failing whole.
  // Fails CLOSED — an empty kernel allow-list means nobody.
  if (spec.capability === "Kernel" && !who.kernel) {
    return { verdict: "QUEUED", reason: `\`${kind}\` needs kernel capability; queued for an operator` };
  }
  return { verdict: "OK", reason: "" };
}

/**
 * Lift a flat form submission into a one-op proposal.
 * Port of `proposal.rs::from_flat`.
 */
export function fromFlat(body: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "body is not a JSON object" };
  }
  const o = body as Record<string, unknown>;
  const parent = typeof o["parent"] === "string" ? o["parent"].trim() : "";
  if (!parent) return { ok: false, message: "a form submission requires `parent` — the read point the author saw" };
  const surface = typeof o["surface"] === "string" && o["surface"] !== "" ? o["surface"] : "Meridian";
  const kind = typeof o["op"] === "string" ? o["op"].trim() : "";
  if (!kind) return { ok: false, message: "a form submission requires `op`" };

  const op: Record<string, unknown> = { op: kind };
  for (const [key, raw] of Object.entries(o)) {
    if (key === "parent" || key === "surface" || key === "op") continue;
    // An empty optional field is what an untouched form input sends. Dropping it
    // is the difference between "the author left this blank" and "the author set
    // this to the empty string", and only the first is what a form can mean.
    if (isEmpty(raw)) continue;
    op[key] = raw;
  }
  return { ok: true, value: { parent, surface, ops: [op] } };
}

export type CheckedProposal = {
  parent: string;
  surface: string;
  /** The bytes STORED in the log: `{parent, author, surface, ops, intent}`. Provenance is kept. */
  canonical: string;
  /** The bytes the ADDRESS is taken over: `{author, ops, parent}`. Provenance does not get a vote. */
  addressPreImage: string | null;
  /**
   * `sha256:<64 hex>` — RFC-002 §5's `Proposal.id`.
   *
   * ⚠ Null ONLY when some op carries a value that has no reproducible rendering,
   * which `checkOp` has already rejected. A proposal that cannot be canonicalized
   * cannot be named, and saying so is better than minting a name for bytes that
   * two implementations would spell differently. When `rejected === 0` this is
   * always a string.
   */
  address: string | null;
  /** `au:Verdict` for the proposal as a whole — the weakest of its ops'. */
  verdict: ProposalVerdict;
  ops: { index: number; op: string; verdict: Verdict; reason: string }[];
  rejected: number;
  admissible: number;
  queued: number;
};

/** Check a whole proposal body against the vocabulary and the author's capability. */
export function checkProposal(
  body: unknown,
  who: Principal,
): { ok: true; checked: CheckedProposal } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "body is not a JSON object" };
  }
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["parent", "surface", "ops", "intent"].includes(key)) {
      return { ok: false, message: `unknown proposal field \`${key}\` (author is taken from the session, never the body)` };
    }
  }
  const parent = typeof o["parent"] === "string" ? o["parent"].trim() : "";
  if (!parent) return { ok: false, message: "a proposal requires `parent` — the read point the author saw" };
  const surface = typeof o["surface"] === "string" && o["surface"] !== "" ? o["surface"] : "Meridian";
  if (!SURFACES.includes(surface)) return { ok: false, message: `\`${surface}\` is not an au:Surface` };
  const ops = o["ops"];
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, message: "a proposal needs at least one op" };

  const report = ops.map((op, index) => {
    const { verdict, reason } = checkOp(op, who);
    const kind = (op as Record<string, unknown> | null)?.["op"];
    return { index, op: typeof kind === "string" ? kind : "", verdict, reason };
  });

  // ⛔ TWO DIFFERENT STRINGS, on purpose.
  //
  //   canonical   what is STORED — parent, author, surface, ops, intent. Every
  //               provenance record is kept: "who authored this, through what"
  //               stays answerable forever.
  //   pre-image   what the address is TAKEN OVER — author, ops, parent only.
  //
  // RFC-002 §4.1 puts the difference in the door's signature: `Door.admit` takes
  // `{parents, ops}` and not provenance, so a chat-authored change and a
  // click-authored change are indistinguishable downstream. §9.1 turns that into
  // a mechanical gate — the same change from two surfaces must produce the same
  // id — and the id can only satisfy it if the surface is outside the pre-image.
  // Keeping provenance AND excluding it from the name is the whole arrangement.
  //
  // ⚠ Both are computed inside a guard. `canonicalJson` refuses values it cannot
  // render reproducibly, and `checkOp` already rejects an op carrying one — but
  // `parent`, `surface` and `intent` do not go through `checkOp`, and an
  // uncaught throw here is a 500 telling the author nothing.
  const rejected = report.filter((r) => r.verdict === "REJECTED").length;
  const queued = report.filter((r) => r.verdict === "QUEUED").length;

  let canonical: string | null = null;
  let addressPreImage: string | null = null;
  let address: string | null = null;
  try {
    canonical = canonicalJson({
      parent,
      author: who.sub,
      surface,
      ops,
      intent: o["intent"] ?? null,
    });
    addressPreImage = canonicalJson({ author: who.sub, ops, parent });
    address = contentAddress({ author: who.sub, ops, parent });
  } catch (e) {
    // ⛔ Order matters here and it is not obvious. `checkOp` already rejects an
    // op carrying a value with no reproducible rendering, so if anything is
    // rejected the proposal is refused either way — and the per-op reason names
    // the FIELD, which is a better answer than a whole-proposal message. So the
    // throw is swallowed, the address stays null, and the 422 carries the
    // report. With nothing rejected the offending value is outside the ops
    // (`intent` is arbitrary JSON from the body), and then this is the only
    // thing that can say so.
    if (rejected === 0) return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  return {
    ok: true,
    checked: {
      parent,
      surface,
      canonical: canonical ?? "",
      addressPreImage,
      address,
      // The weakest of the ops'. A rejected proposal is never appended, so this
      // value is reported to the author and not recorded; Admitted and Queued
      // are what the log ever carries.
      verdict: rejected > 0 ? "Rejected" : queued > 0 ? "Queued" : "Admitted",
      ops: report,
      rejected,
      admissible: report.filter((r) => r.verdict === "OK").length,
      queued,
    },
  };
}
