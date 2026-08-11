/**
 * The closed op vocabulary and the door that checks against it.
 *
 * Port of `services/spec/src/proposal.rs`. RFC-002 §5's table, one row per
 * constructor: 16, plus `retractTerm`.
 *
 * ⛔ The author is taken from the session, never from the request body. A
 * proposal cannot name its own author.
 */
import { canonicalJson } from "./canonical";

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

const isEmpty = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

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
  canonical: string;
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

  const canonical = canonicalJson({
    parent,
    author: who.sub,
    surface,
    ops,
    intent: o["intent"] ?? null,
  });

  return {
    ok: true,
    checked: {
      parent,
      surface,
      canonical,
      ops: report,
      rejected: report.filter((r) => r.verdict === "REJECTED").length,
      admissible: report.filter((r) => r.verdict === "OK").length,
      queued: report.filter((r) => r.verdict === "QUEUED").length,
    },
  };
}
