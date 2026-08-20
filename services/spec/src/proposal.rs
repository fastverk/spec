//! proposal — the RFC-002 §5 proposal IR, checker-side.
//!
//! # What this is, and the one thing it deliberately is not
//!
//! RFC-002 puts `Door.admit` in Lean: it takes `{parents, ops}` and **not**
//! provenance, which is what makes a chat-authored change and a click-authored
//! change indistinguishable downstream by signature. That model now exists —
//! `lean/Spec/Authoring/Door.lean`, compiled by `//lean:authoring_test` — and the
//! door that runs is the console's. Neither is simulated here.
//!
//! What lives here is the **checker**: parse a proposal, check every op against
//! the closed vocabulary and its *local* decidable preconditions, and compute the
//! canonical bytes, the content address and the `au:Verdict` those ops imply.
//! `POST /proposal/verdict-preview` is what that is for — an author sees the name
//! and the verdict before submitting (§9 step 6). Nothing here appends.
//!
//! ⚠ This module used to say **"the build adjudicates, the plugin queues"**, and
//! both halves have moved. The plugin does not queue: it has no write path
//! (below). The build still adjudicates the GATE set and only that — RFC-002 §7.1
//! now has a table saying which of admission's four questions is answered where,
//! because "the door can prove it" was doing too much work in one sentence.
//!
//! ⛔ **THE WRITE PATH IS RETIRED.** `POST /proposal` and `POST /proposal/op`
//! answer **410 Gone** and name the console's routes instead. Two doors that both
//! append are two places the op vocabulary, the canonical bytes and the content
//! address can disagree — and they DID: `from_flat` here coerced a form's
//! `bound_value` string to an f64 while the console left it a string, so the same
//! submission got two different names. One door, or the address means nothing.
//!
//! What remains here is the READ side of the same log (the pending overlay) and
//! `verdict-preview`, which writes nothing.
//!
//! Two things worth being blunt about, because a route named `verdict-preview`
//! invites the assumption that it decides everything:
//!
//! 1. **The content address IS computed here**, and this module is one of three
//!    implementations of it — `console/lib/address.ts` and
//!    `conformance/check_conformance.py` are the others, and all three execute
//!    `conformance/address_cases.json`. This paragraph used to say the opposite:
//!    *"this crate has no hash primitive and cannot acquire one without re-pinning
//!    the plugin's crate universe"*, so every response carried `"address": null`.
//!    Re-pinning was one line in Cargo.toml. The claim was true when it was
//!    written and had become a reason not to build the door.
//!
//!    `sha256:<64 hex>` over `canonical_json({author, ops, parent})`. **Three
//!    fields**: `surface` and `intent` are stored and deliberately not hashed, so
//!    a chat-authored and a click-authored change are ONE proposal with two
//!    provenance records (RFC-002 §4.1, §9.1).
//! 2. **`verdict-preview` previews the *structure*, not the gate set.** It answers
//!    "is this a well-formed proposal, what does it touch, and what will it be
//!    called" plus "here is what is currently infeasible". It cannot answer "will
//!    admitting this create an unrecorded empty envelope", because that is a
//!    `GROUP BY … HAVING` over the post-admission graph and this plugin has no
//!    query engine. Saying so in the response body is part of the contract.
//!
//! # What it does enforce
//!
//! Everything decidable from the op alone, which is more than it sounds:
//!
//!   * the op kind is in the closed 17-constructor vocabulary (§5, plus `retractTerm`);
//!   * required fields are present and non-empty, and no unknown field is silently
//!     dropped — a typo'd key is a rejection, not a no-op;
//!   * `declQuantity` carries **all six** referent fields. Dimension alone is
//!     insufficient (MW and MVAr share a dimension; "capacity" is five disjoint
//!     concepts), so the door is where the referent stops being optional;
//!   * `groundNS` carries exactly one of `is_axiom` / `derived_via`;
//!   * enumerated values are checked against the `au:` individuals
//!     (rungs R0–R5, the five `au:Outcome`s, the four `au:Surface`s);
//!   * `declarePrecedence` requires kernel capability — RFC-002 §5's "precedence is
//!     deliberately the expensive move";
//!   * **an agent principal may only `assertNS` at R0.** RFC-002 §7.1 is honest
//!     that this is a code property rather than a theorem. This module is that code,
//!     in one place, which is the most that claim can currently mean.
//!
//! The author is taken from the gateway-injected `X-Fastverk-User-Sub` /
//! `X-Fastverk-User-Email` headers, never from the request body. A proposal cannot
//! name its own author.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// `au:Surface` — audit-only provenance. The door cannot see it (§4); it is
/// recorded so "who authored this, through what" stays answerable, and so the
/// agent-capability rule below has something to key on.
pub const SURFACES: &[&str] = &["Meridian", "Chat", "Ingest", "Agent"];

/// `au:Rung` — the formalization ladder. R4 is the binding threshold for fanout.
pub const RUNGS: &[&str] = &["R0", "R1", "R2", "R3", "R4", "R5"];

/// `au:Outcome` — the five resolution outcomes. `Refute` is in the list because
/// "this conflict rests on a false claim" is a legitimate adjudication, not an
/// evasion of one.
pub const OUTCOMES: &[&str] = &["Narrow", "Prioritize", "Exempt", "Escalate", "Refute"];

/// What a principal must hold to apply an op.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Capability {
    /// Any authenticated author.
    Author,
    /// Kernel only — changes the lattice for every discipline.
    Kernel,
}

/// One constructor of the closed op vocabulary.
pub struct OpSpec {
    pub kind: &'static str,
    /// Fields that must be present and non-empty.
    pub required: &'static [&'static str],
    /// Fields that may be present.
    pub optional: &'static [&'static str],
    /// Exactly one of these must be present (empty = no such constraint).
    pub exactly_one_of: &'static [&'static str],
    pub capability: Capability,
}

/// The closed vocabulary — RFC-002 §5's table, one row per constructor.
///
/// Adding a constructor here is the *whole* edit on the plugin side; the
/// `vocabulary_is_closed_and_total` test below fails if the count drifts from the
/// RFC's 16 + `retractTerm`, which is the cheapest possible guard against this
/// table and the spec disagreeing.
pub const OPS: &[OpSpec] = &[
    // ── claims ──────────────────────────────────────────────────────────────
    OpSpec {
        kind: "assertNS",
        required: &["subject", "text", "discipline", "rung"],
        // `project` scopes the claim, for the same reason it scopes a binding: a
        // requirement written while looking at Studio is not a requirement about
        // AMPERE. `overlay.rs::read` already reads it off an assertNS and carries
        // it onto the pending row, so leaving it out of this list made the two
        // disagree — the overlay expected a field the door rejected, and every
        // "write a new requirement" 422'd with `assertNS has no field project`.
        optional: &[
            "quantity", "bound_kind", "bound_value", "guard", "defeasible", "scope",
            "citation", "modality", "instrument", "project",
        ],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "amendNS",
        required: &["subject", "text"],
        // `discipline` is amendable for the same reason `modality` is: rewording a
        // requirement is often how it turns out to belong to a different area, and
        // `overlay.rs::read` already merges it onto the amended row.
        optional: &[
            "quantity", "bound_kind", "bound_value", "guard", "defeasible", "scope",
            "citation", "modality", "instrument", "discipline",
        ],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // retract never deletes; it demotes. So it needs a reason — a demotion with no
    // stated ground is indistinguishable from a mistake.
    OpSpec {
        kind: "retractNS",
        required: &["subject", "reason"],
        optional: &[],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // ── the glossary ────────────────────────────────────────────────────────
    // bindTerm is FORCED when a term typeahead has no match, which is the one place
    // in the UI where the formal path costs fewer decisions than prose: prose defers
    // the choice between three disjoint senses rather than avoiding it.
    OpSpec {
        kind: "bindTerm",
        required: &["term", "definition"],
        // `project` scopes the binding. Without it a term binds in EVERY corpus
        // that uses the surface, and `public` is a term in more than one of them.
        optional: &["discipline", "project"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "alignTerm",
        required: &["term", "aligns_to"],
        optional: &["discipline", "project"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // ⚠ The 17th constructor, and the vocabulary was closed at 16 by two
    // assertions specifically so this could not happen quietly. It is here
    // because decomposition is machine work that can be WRONG: reading terms off
    // the author's markup pulled `or`, `act`, `intersected` and `rule, not rows`
    // into Studio's queue beside `sponsor:edit`. Without this, the only ways to
    // clear a bad extraction were to bind it to something false or to leave it
    // blocking its claims forever — so the grounding queue would fill with noise
    // that no authoring act could remove, and people would learn to ignore it.
    //
    // Retraction says "this is not a term", which is a judgement about the
    // decomposer's output, not about the business. It is deliberately NOT
    // `alignTerm` to a sentinel: aligning asserts two things mean the same, and
    // this asserts one of them means nothing.
    OpSpec {
        kind: "retractTerm",
        required: &["term"],
        optional: &["reason", "discipline", "project"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // ── the homonym registry ────────────────────────────────────────────────
    // All six referent fields are required. This is the load-bearing strictness in
    // the whole vocabulary: an untyped quantity cannot participate in
    // empty-envelope detection at all, so its conflicts are invisible rather than
    // absent. Over corpus/ampere, `metering & settlement` reads 0.0% typed — and it
    // is the discipline that fixes the referent for every energy quantity there.
    OpSpec {
        kind: "declQuantity",
        required: &[
            "quantity", "dimension", "unit", "measurement_point", "estimator", "time_base",
        ],
        optional: &["label"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "assertDisjoint",
        required: &["quantity", "disjoint_from"],
        optional: &["rationale"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // ── scope ───────────────────────────────────────────────────────────────
    OpSpec {
        kind: "declScope",
        required: &["scope", "label"],
        optional: &["parent"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // Narrowing a guard is the cheapest genuine conflict resolution: it makes two
    // claims stop overlapping instead of ranking one over the other.
    OpSpec {
        kind: "narrowGuard",
        required: &["subject", "guard"],
        optional: &["rationale"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // ── ladder movement ─────────────────────────────────────────────────────
    OpSpec {
        kind: "promote",
        required: &["subject", "rung", "evidence"],
        optional: &[],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "demote",
        required: &["subject", "rung", "reason"],
        optional: &[],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // ── grounding ───────────────────────────────────────────────────────────
    OpSpec {
        kind: "groundNS",
        required: &["subject"],
        optional: &["is_axiom", "derived_via"],
        exactly_one_of: &["is_axiom", "derived_via"],
        capability: Capability::Author,
    },
    // ── the conflict lifecycle ──────────────────────────────────────────────
    OpSpec {
        kind: "openConflict",
        required: &["conflict", "kind", "parties"],
        optional: &["quantity", "owner"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "witness",
        required: &["conflict", "party"],
        optional: &["bound_kind", "bound_value", "guard"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "adjudicate",
        required: &["conflict", "outcome", "rationale"],
        optional: &["expires"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    // ── the lattice ─────────────────────────────────────────────────────────
    OpSpec {
        kind: "declarePrecedence",
        required: &["higher", "lower", "rationale"],
        optional: &[],
        exactly_one_of: &[],
        capability: Capability::Kernel,
    },
];

pub fn op_spec(kind: &str) -> Option<&'static OpSpec> {
    OPS.iter().find(|o| o.kind == kind)
}

/// The authenticated author, from the gateway's injected headers.
#[derive(Clone, Debug)]
pub struct Principal {
    pub sub: String,
    pub email: String,
    /// Whether this principal holds kernel capability (`$SPEC_KERNEL_SUBS`, CSV of
    /// subs). Empty allow-list = nobody, so `declarePrecedence` is queued rather
    /// than applied until an operator names the kernel explicitly. Failing CLOSED
    /// here is the opposite of `pluginCallerIsAdmin`'s fail-open, and deliberately
    /// so: that one hides a nav item, this one changes every discipline's lattice.
    pub kernel: bool,
    /// Whether this principal is an agent (`$SPEC_AGENT_SUBS`, CSV, or a sub
    /// prefixed `agent:`). Agents may only `assertNS` at R0.
    pub agent: bool,
}

impl Principal {
    pub fn from_headers(sub: Option<&str>, email: Option<&str>) -> Option<Self> {
        let sub = sub.map(str::trim).filter(|s| !s.is_empty())?.to_string();
        let kernel = csv_env("SPEC_KERNEL_SUBS").iter().any(|k| *k == sub);
        let agent =
            sub.starts_with("agent:") || csv_env("SPEC_AGENT_SUBS").iter().any(|k| *k == sub);
        Some(Self {
            sub,
            email: email.unwrap_or_default().to_string(),
            kernel,
            agent,
        })
    }

    fn holds(&self, cap: Capability) -> bool {
        match cap {
            Capability::Author => true,
            Capability::Kernel => self.kernel,
        }
    }
}

fn csv_env(key: &str) -> Vec<String> {
    std::env::var(key)
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// One op's structural verdict. `queued` — not `rejected` — is what a
/// capability shortfall yields: RFC-002 §5 makes partial admission normal, so a
/// proposal that mixes author-capability and kernel-capability ops splits rather
/// than failing whole.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OpVerdict {
    Ok,
    Queued,
    Rejected,
}

impl OpVerdict {
    fn as_str(self) -> &'static str {
        match self {
            OpVerdict::Ok => "OK",
            OpVerdict::Queued => "QUEUED",
            OpVerdict::Rejected => "REJECTED",
        }
    }
}

/// Check one op. Returns its verdict plus the reason (empty when `Ok`).
pub fn check_op(op: &Value, who: &Principal) -> (OpVerdict, String) {
    let obj = match op.as_object() {
        Some(o) => o,
        None => return (OpVerdict::Rejected, "op is not a JSON object".into()),
    };
    let kind = match obj.get("op").and_then(Value::as_str) {
        Some(k) => k,
        None => return (OpVerdict::Rejected, "op has no `op` field".into()),
    };
    let spec = match op_spec(kind) {
        Some(s) => s,
        None => {
            return (
                OpVerdict::Rejected,
                format!("`{kind}` is not in the closed op vocabulary"),
            )
        }
    };

    // Required fields, present and non-empty.
    for field in spec.required {
        match obj.get(*field) {
            None => return (OpVerdict::Rejected, format!("`{kind}` requires `{field}`")),
            Some(v) if is_empty_value(v) => {
                return (
                    OpVerdict::Rejected,
                    format!("`{kind}`.`{field}` is present but empty"),
                )
            }
            Some(_) => {}
        }
    }

    // No unknown fields. A silently-dropped key is how a typo'd `bound_vlaue`
    // becomes an unbounded claim that passes every gate.
    for key in obj.keys() {
        if key == "op" || spec.required.contains(&key.as_str()) || spec.optional.contains(&key.as_str())
        {
            continue;
        }
        return (
            OpVerdict::Rejected,
            format!("`{kind}` has no field `{key}`"),
        );
    }

    // Exactly-one-of (groundNS: an axiom or a derivation chain, never both, never
    // neither — "grounded by nothing" is the defect the grounding lint exists for).
    if !spec.exactly_one_of.is_empty() {
        let present: Vec<&str> = spec
            .exactly_one_of
            .iter()
            .copied()
            .filter(|f| obj.get(*f).is_some_and(|v| !is_empty_value(v)))
            .collect();
        if present.len() != 1 {
            return (
                OpVerdict::Rejected,
                format!(
                    "`{kind}` needs exactly one of {:?}; got {}",
                    spec.exactly_one_of,
                    present.len()
                ),
            );
        }
    }

    // Before anything semantic: can these bytes even be a pre-image? An op that
    // cannot be canonicalized has no content address, so it has no name, so it
    // cannot be reviewed or replayed.
    if let Some(why) = unrepresentable(op, kind) {
        return (OpVerdict::Rejected, why);
    }

    // Enumerated values against the au: individuals.
    if let Some(rung) = obj.get("rung").and_then(Value::as_str) {
        if !RUNGS.contains(&rung) {
            return (
                OpVerdict::Rejected,
                format!("`{rung}` is not a rung (expected one of {RUNGS:?})"),
            );
        }
    }
    if let Some(outcome) = obj.get("outcome").and_then(Value::as_str) {
        if !OUTCOMES.contains(&outcome) {
            return (
                OpVerdict::Rejected,
                format!("`{outcome}` is not an au:Outcome (expected one of {OUTCOMES:?})"),
            );
        }
    }

    // `is_axiom: false` is not a grounding. Without this it satisfies
    // exactly_one_of by being present, which would let "this is not an axiom" pass
    // as a ground — the precise vacuity the grounding lint exists to catch.
    if let Some(v) = obj.get("is_axiom") {
        if v != &Value::Bool(true) {
            return (
                OpVerdict::Rejected,
                "`groundNS`.`is_axiom` must be `true` if present — use `derived_via` otherwise"
                    .into(),
            );
        }
    }

    // A conflict needs at least two parties. One-party "conflict" is a claim.
    if kind == "openConflict" {
        let n = obj.get("parties").and_then(Value::as_array).map_or(0, Vec::len);
        if n < 2 {
            return (
                OpVerdict::Rejected,
                format!("`openConflict` needs at least 2 parties; got {n}"),
            );
        }
    }

    // ⛔ A machine may not author (RFC-004a §4). The machine principal exists
    // only on the console's evaluation route and never reaches this door; this
    // is the second lock, for the day something wires one through.
    if who.sub.starts_with(crate::evaluation::MACHINE_PREFIX) {
        return (
            OpVerdict::Rejected,
            format!("machine principals may not author; `{kind}` is out of capability"),
        );
    }

    // Agents may write R0 only (RFC-002 §7.1's code property).
    if who.agent {
        if kind != "assertNS" {
            return (
                OpVerdict::Rejected,
                format!("agent principals may only `assertNS`; `{kind}` is out of capability"),
            );
        }
        if obj.get("rung").and_then(Value::as_str) != Some("R0") {
            return (
                OpVerdict::Rejected,
                "agent principals may only assert at R0".into(),
            );
        }
    }

    // Capability. Queued, not rejected — see OpVerdict.
    if !who.holds(spec.capability) {
        return (
            OpVerdict::Queued,
            format!("`{kind}` requires kernel capability; queued for a kernel principal"),
        );
    }
    (OpVerdict::Ok, String::new())
}

/// Why this value cannot be part of a content address, or `None` if it can.
///
/// ⛔ The rule is `Number.isSafeInteger`'s, and it is stated in JavaScript's
/// terms on purpose: the CONSOLE is the door now, and the two implementations
/// have to refuse the same set or the same submission gets two names.
///
///   * a float renders through ryu here and through `String(n)` there, and the
///     two disagree (`1e21` vs `1e+21`);
///   * an integer outside ±(2^53−1) is a float in JavaScript whatever it is
///     here, so it renders in exponent form there and in full here.
///
/// No op in the vocabulary carries a number today — `bound_value` arrives from a
/// form as a string — so this refuses something nothing sends, which is exactly
/// when to put it in.
///
/// ⚠ There is no surrogate case. A Rust `String` cannot hold an unpaired
/// surrogate and serde_json's parser refuses one on the way in, so the
/// asymmetric half of this rule lives only in `console/lib/canonical.ts`.
fn unrepresentable(v: &Value, path: &str) -> Option<String> {
    const SAFE: i64 = 9_007_199_254_740_991; // 2^53 − 1
    match v {
        Value::Number(n) => match n.as_i64() {
            Some(i) if i.abs() <= SAFE => None,
            _ => Some(format!(
                "`{path}` is {n}, which is not a safe integer; its rendering differs between \
                 implementations and this value is part of a content address — send it as a string"
            )),
        },
        Value::Array(a) => a
            .iter()
            .enumerate()
            .find_map(|(i, item)| unrepresentable(item, &format!("{path}[{i}]"))),
        Value::Object(m) => m
            .iter()
            .find_map(|(k, val)| unrepresentable(val, &format!("{path}.{k}"))),
        _ => None,
    }
}

/// `sha256:` — the digest is named in the address; a bare hex string ages badly.
pub const ADDRESS_PREFIX: &str = "sha256:";

/// The exact bytes a content address is taken over.
///
/// ⛔ **Three fields.** `surface` and `intent` are stored in the log and NOT
/// hashed. RFC-002 §4.1 has `Door.admit` take `{parents, ops}` and not
/// provenance, "so a chat-authored change and a click-authored change are
/// indistinguishable downstream — enforced by the signature, not by review
/// discipline". §9.1 turns that into a mechanical gate; the id can only satisfy
/// it if the surface is outside the pre-image.
///
/// ⛔ `author` IS hashed, and that is not a contradiction: it is invariant ⑤.
/// Two people proposing the same words are making two proposals, each of which
/// one of them is answerable for. The surface collapses; the person never does.
pub fn address_pre_image(author: &str, ops: &[Value], parent: &str) -> String {
    let mut m = Map::new();
    m.insert("author".into(), json!(author));
    m.insert("ops".into(), Value::Array(ops.to_vec()));
    m.insert("parent".into(), json!(parent));
    canonical_json(&Value::Object(m))
}

/// RFC-002 §5's `Proposal.id`.
pub fn content_address(author: &str, ops: &[Value], parent: &str) -> String {
    let digest = Sha256::digest(address_pre_image(author, ops, parent).as_bytes());
    format!("{ADDRESS_PREFIX}{digest:x}")
}

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// `au:Verdict` — the door's answer for the proposal AS A WHOLE
/// (rdf/ontology/authoring.ttl), as distinct from the per-op `OpVerdict`.
///
/// The weakest of the ops': `Rejected` if any op is ill-formed (nothing is
/// appended), else `Queued` if any is out of capability (partial admission is
/// normal — RFC-002 §5), else `Admitted`.
///
/// ⚠ NOT the gate set. §7.1 counts "every named gate returns zero rows after
/// application" as part of admission, and that is a `GROUP BY … HAVING` over the
/// post-admission graph. That verdict is the build's, on the promotion PR.
pub const PROPOSAL_VERDICTS: &[&str] = &["Admitted", "Queued", "Rejected"];

/// A checked proposal: the ops with their verdicts, the canonical bytes, and the
/// name those ops give the proposal.
#[derive(Debug)]
pub struct Checked {
    pub parent: String,
    pub surface: String,
    pub author: Principal,
    pub verdicts: Vec<(String, OpVerdict, String)>,
    /// What is STORED: `{parent, author, surface, ops, intent}`. Provenance kept.
    pub canonical: String,
    /// What the ADDRESS is taken over: `{author, ops, parent}`. `None` only when
    /// an op carries a value with no reproducible rendering — which `check_op`
    /// has already rejected, so this is `Some` whenever `rejected() == 0`.
    pub pre_image: Option<String>,
    /// `sha256:<64 hex>` — RFC-002 §5's `Proposal.id`. `None` for the same reason.
    pub address: Option<String>,
}

impl Checked {
    /// `au:Verdict` for the proposal as a whole.
    pub fn verdict(&self) -> &'static str {
        if self.rejected() > 0 {
            "Rejected"
        } else if self.queued() > 0 {
            "Queued"
        } else {
            "Admitted"
        }
    }

    pub fn admissible(&self) -> usize {
        self.verdicts.iter().filter(|(_, v, _)| *v == OpVerdict::Ok).count()
    }
    pub fn queued(&self) -> usize {
        self.verdicts.iter().filter(|(_, v, _)| *v == OpVerdict::Queued).count()
    }
    pub fn rejected(&self) -> usize {
        self.verdicts.iter().filter(|(_, v, _)| *v == OpVerdict::Rejected).count()
    }

    /// The per-op report, in submission order. Op granularity is the point: RFC-002
    /// §5 makes review a per-row triage over a diff, not an accept/reject on a
    /// record.
    pub fn report(&self) -> Value {
        json!(self
            .verdicts
            .iter()
            .enumerate()
            .map(|(i, (kind, v, why))| json!({
                "index": i,
                "op": kind,
                "verdict": v.as_str(),
                "reason": why,
            }))
            .collect::<Vec<_>>())
    }
}

/// Parse and check a proposal body. `author` comes from the headers, so anything
/// the body says about authorship is ignored (and rejected as an unknown field).
pub fn check(body: &Value, author: Principal) -> Result<Checked, String> {
    let obj = body.as_object().ok_or("body is not a JSON object")?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "parent" | "surface" | "ops" | "intent") {
            return Err(format!(
                "unknown proposal field `{key}` (author is taken from the gateway headers, never the body)"
            ));
        }
    }
    let parent = obj
        .get("parent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("proposal requires `parent` — the bitemporal read point the author saw")?
        .to_string();
    let surface = obj
        .get("surface")
        .and_then(Value::as_str)
        .unwrap_or("Meridian")
        .to_string();
    if !SURFACES.contains(&surface.as_str()) {
        return Err(format!(
            "`{surface}` is not an au:Surface (expected one of {SURFACES:?})"
        ));
    }
    let ops = obj
        .get("ops")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or("proposal requires a non-empty `ops` array")?;

    let verdicts = ops
        .iter()
        .map(|op| {
            let kind = op
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or("<none>")
                .to_string();
            let (v, why) = check_op(op, &author);
            (kind, v, why)
        })
        .collect();

    // ⛔ TWO DIFFERENT STRINGS, on purpose.
    //
    //   canonical   what is STORED — parent, author, surface, ops, intent. Every
    //               provenance record is kept: "who authored this, through what"
    //               stays answerable forever.
    //   pre-image   what the address is TAKEN OVER — author, ops, parent only.
    //
    // Keeping provenance AND excluding it from the name is the whole arrangement
    // (§4.1, §9.1). Both are emitted here byte-for-byte rather than re-derived
    // downstream from a re-serialization that might order keys differently.
    let mut canon = Map::new();
    canon.insert("parent".into(), json!(parent));
    canon.insert("author".into(), json!(author.sub));
    canon.insert("surface".into(), json!(surface));
    canon.insert("ops".into(), Value::Array(ops.clone()));
    canon.insert(
        "intent".into(),
        obj.get("intent").cloned().unwrap_or(Value::Null),
    );
    let canonical = canonical_json(&Value::Object(canon));

    // A proposal whose ops cannot be canonicalized has no name. `check_op`
    // rejected every such op above, so the report already says why with the
    // field named — better than one message about the whole proposal.
    let nameable = ops.iter().all(|op| unrepresentable(op, "op").is_none());
    let (pre_image, address) = if nameable {
        (
            Some(address_pre_image(&author.sub, ops, &parent)),
            Some(content_address(&author.sub, ops, &parent)),
        )
    } else {
        (None, None)
    };

    Ok(Checked {
        parent,
        surface,
        author,
        verdicts,
        canonical,
        pre_image,
        address,
    })
}

// ── the flat, single-op form of a proposal — RETIRED ─────────────────────────
//
// `from_flat` lived here: it lifted a meridian `FormPanel`'s flat object of
// strings into `{parent, ops: [{...}]}`, re-typing the named array / boolean /
// numeric fields on the way. It went with the write path, and the coercion is
// WHY rather than merely a casualty.
//
// The console's `fromFlat` does not coerce. So `bound_value: "70"` from a form
// became the f64 `70.0` here and stayed the string `"70"` there — two different
// canonical bodies, and once the address existed, two different permanent NAMES
// for one submission. RFC-002 §8.1 asserted the opposite property ("a form
// submission and an API submission of the same op produce identical canonical
// bytes") and it was only ever tested WITHIN one implementation, because no
// suite could reach both.
//
// Coercing is arguably the friendlier behaviour, and if it comes back it belongs
// in the one door, checked by `conformance/address_cases.json` so both halves
// coerce identically or neither does. What it cannot be again is a second
// implementation of the same lift.
//
// The lift itself now lives in `console/lib/proposal.ts::fromFlat`, and
// `console/test/door.test.ts` executes the property across both console routes.

/// Deterministic JSON: object keys sorted, no insignificant whitespace, numbers as
/// serde_json renders them.
///
/// Written out rather than relying on `serde_json::to_string`, whose key order
/// depends on whether the `preserve_order` feature is enabled somewhere in the
/// dependency graph — a build-configuration detail that must not be able to change
/// a content address.
pub fn canonical_json(v: &Value) -> String {
    let mut s = String::new();
    write_canonical(v, &mut s);
    s
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// The append-only proposal log.
///
/// One canonical JSON line per accepted proposal. Append-only in the strong sense:
/// the file is opened with `append(true)` and never seeked, so a reader can replay
/// the log by line and a crash mid-write costs at most the tail line. `spec replay`
/// (RFC-002 P1) consumes this.
/// The same append-only primitive carries the evaluation log — measurements
/// rather than judgements — so the name is aliased rather than the type copied.
pub type AppendLog = ProposalLog;

pub struct ProposalLog {
    path: Option<PathBuf>,
    lock: Mutex<()>,
}

impl ProposalLog {
    /// From `$SPEC_PROPOSAL_LOG`. **Unset disables the write path** — the plugin
    /// stays read-only unless an operator configures somewhere durable to write,
    /// which is the right default for a BFF whose other three tables are a scan of
    /// someone else's source tree.
    pub fn from_env() -> Self {
        Self::new(
            std::env::var("SPEC_PROPOSAL_LOG")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
        )
    }

    /// Directly, with no environment lookup — `None` disables the write path. Same
    /// reason as `ReadModel::new`: a test must not have to `set_var`, because
    /// `#[test]`s share one process and race on it.
    pub fn new(path: Option<PathBuf>) -> Self {
        match &path {
            Some(p) => tracing::info!(log = %p.display(), "proposal log enabled (write path live)"),
            None => tracing::info!("SPEC_PROPOSAL_LOG unset; the write path is disabled (read-only)"),
        }
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.path.is_some()
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Append one record. Returns the byte offset it was written at — the only
    /// stable handle this plugin can hand back, since it cannot compute the address.
    pub fn append(&self, record: &Value) -> Result<u64, String> {
        let path = self.path.as_ref().ok_or("the write path is disabled")?;
        let line = canonical_json(record);
        let _guard = self.lock.lock().map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let offset = f.metadata().map(|m| m.len()).unwrap_or(0);
        writeln!(f, "{line}").map_err(|e| format!("{}: {e}", path.display()))?;
        f.flush().map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(offset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn author() -> Principal {
        Principal {
            sub: "u-1".into(),
            email: "a@b.c".into(),
            kernel: false,
            agent: false,
        }
    }
    fn kernel() -> Principal {
        Principal { kernel: true, ..author() }
    }
    fn author_with(sub: &str) -> Principal {
        Principal { sub: sub.into(), ..author() }
    }
    fn agent() -> Principal {
        Principal { agent: true, ..author() }
    }
    fn machine() -> Principal {
        Principal { sub: "machine:studio-nextjs".into(), ..author() }
    }

    #[test]
    fn vocabulary_is_closed_and_total() {
        // RFC-002 §5's table has 16 constructors, plus `retractTerm` — see the
        // note on it above. A drift here means the RFC and the door disagree
        // about what an op is.
        assert_eq!(OPS.len(), 17);
        for o in OPS {
            assert!(op_spec(o.kind).is_some());
        }
        assert!(op_spec("assertNSS").is_none());
    }

    /// RFC-004a §4: a machine reports what it measured and may not author. The
    /// positive control is the same op from an author, which is admitted.
    #[test]
    fn machines_may_not_author() {
        let op = json!({"op": "assertNS", "subject": "s", "text": "t",
                        "discipline": "d", "rung": "R0"});
        let (v, why) = check_op(&op, &machine());
        assert_eq!(v, OpVerdict::Rejected);
        assert!(why.contains("machine"), "{why}");
        assert_eq!(check_op(&op, &author()).0, OpVerdict::Ok);
    }

    #[test]
    fn an_unknown_field_is_rejected_not_dropped() {
        let op = json!({"op": "assertNS", "subject": "s", "text": "t",
                        "discipline": "d", "rung": "R4", "bound_vlaue": 5});
        let (v, why) = check_op(&op, &author());
        assert_eq!(v, OpVerdict::Rejected);
        assert!(why.contains("bound_vlaue"), "{why}");
    }

    #[test]
    fn decl_quantity_requires_all_six_referent_fields() {
        let full = json!({"op": "declQuantity", "quantity": "q", "dimension": "power",
                          "unit": "MW", "measurement_point": "poi", "estimator": "e",
                          "time_base": "15min"});
        assert_eq!(check_op(&full, &author()).0, OpVerdict::Ok);
        for drop in ["dimension", "unit", "measurement_point", "estimator", "time_base"] {
            let mut partial = full.clone();
            partial.as_object_mut().unwrap().remove(drop);
            let (v, why) = check_op(&partial, &author());
            assert_eq!(v, OpVerdict::Rejected, "dropping {drop} should reject: {why}");
        }
    }

    #[test]
    fn ground_ns_needs_exactly_one_ground() {
        let base = json!({"op": "groundNS", "subject": "s"});
        assert_eq!(check_op(&base, &author()).0, OpVerdict::Rejected);
        let axiom = json!({"op": "groundNS", "subject": "s", "is_axiom": true});
        assert_eq!(check_op(&axiom, &author()).0, OpVerdict::Ok);
        let both = json!({"op": "groundNS", "subject": "s", "is_axiom": true,
                          "derived_via": "deriv_1"});
        assert_eq!(check_op(&both, &author()).0, OpVerdict::Rejected);
        // `is_axiom: false` is not a ground, so it cannot satisfy exactly-one-of.
        let negated = json!({"op": "groundNS", "subject": "s", "is_axiom": false});
        assert_eq!(check_op(&negated, &author()).0, OpVerdict::Rejected);
    }

    #[test]
    fn precedence_is_queued_for_a_non_kernel_principal() {
        let op = json!({"op": "declarePrecedence", "higher": "a", "lower": "b",
                        "rationale": "r"});
        assert_eq!(check_op(&op, &author()).0, OpVerdict::Queued);
        assert_eq!(check_op(&op, &kernel()).0, OpVerdict::Ok);
    }

    #[test]
    fn agents_may_only_assert_at_r0() {
        let r0 = json!({"op": "assertNS", "subject": "s", "text": "t",
                        "discipline": "d", "rung": "R0"});
        assert_eq!(check_op(&r0, &agent()).0, OpVerdict::Ok);
        let r4 = json!({"op": "assertNS", "subject": "s", "text": "t",
                        "discipline": "d", "rung": "R4"});
        assert_eq!(check_op(&r4, &agent()).0, OpVerdict::Rejected);
        let promote = json!({"op": "promote", "subject": "s", "rung": "R4", "evidence": "e"});
        assert_eq!(check_op(&promote, &agent()).0, OpVerdict::Rejected);
        // …and the same ops from a human author are fine.
        assert_eq!(check_op(&r4, &author()).0, OpVerdict::Ok);
        assert_eq!(check_op(&promote, &author()).0, OpVerdict::Ok);
    }

    #[test]
    fn a_conflict_needs_two_parties() {
        let one = json!({"op": "openConflict", "conflict": "INV-01", "kind": "envelope",
                         "parties": ["a"]});
        assert_eq!(check_op(&one, &author()).0, OpVerdict::Rejected);
        let two = json!({"op": "openConflict", "conflict": "INV-01", "kind": "envelope",
                         "parties": ["a", "b"]});
        assert_eq!(check_op(&two, &author()).0, OpVerdict::Ok);
    }

    #[test]
    fn bad_enumerated_values_are_rejected() {
        let rung = json!({"op": "promote", "subject": "s", "rung": "R9", "evidence": "e"});
        assert_eq!(check_op(&rung, &author()).0, OpVerdict::Rejected);
        let outcome = json!({"op": "adjudicate", "conflict": "c", "outcome": "Ignore",
                             "rationale": "r"});
        assert_eq!(check_op(&outcome, &author()).0, OpVerdict::Rejected);
    }

    #[test]
    fn the_body_cannot_name_its_own_author() {
        let body = json!({"parent": "p", "surface": "Meridian", "author": "root",
                          "ops": [{"op": "retractNS", "subject": "s", "reason": "r"}]});
        let err = check(&body, author()).expect_err("author in the body must be rejected");
        assert!(err.contains("author"), "{err}");
    }

    #[test]
    fn canonical_json_is_key_order_independent() {
        let a: Value = serde_json::from_str(r#"{"b":1,"a":{"d":2,"c":[3,{"f":4,"e":5}]}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}"#).unwrap();
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_eq!(canonical_json(&a), r#"{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}"#);
    }

    #[test]
    fn a_mixed_proposal_splits_rather_than_failing_whole() {
        let body = json!({
            "parent": "p",
            "surface": "Meridian",
            "ops": [
                {"op": "narrowGuard", "subject": "s", "guard": "ambient_c >= 40"},
                {"op": "declarePrecedence", "higher": "a", "lower": "b", "rationale": "r"},
                {"op": "assertNS", "subject": "s", "text": "t", "discipline": "d", "rung": "R9"}
            ]
        });
        let c = check(&body, author()).unwrap();
        assert_eq!((c.admissible(), c.queued(), c.rejected()), (1, 1, 1));
    }

    /// ⛔ The SHARED cases — `conformance/address_cases.json` — executed here so
    /// this canonicalizer and the console's cannot drift. The pre-image is
    /// asserted as BYTES before the digest is compared: a digest that disagrees
    /// says only THAT two implementations differ; the bytes say where.
    ///
    /// Same `option_env!` + exists() guard as `evaluation.rs`: the fixtures are
    /// source files, so under `cargo test` they are right there and under a
    /// bazel `rust_test` they are not staged — which is why the hand-written
    /// cases below are not deleted.
    #[test]
    fn the_shared_address_cases_all_hold() {
        let Some(dir) = option_env!("CARGO_MANIFEST_DIR") else {
            return;
        };
        let path = std::path::PathBuf::from(dir).join("../../conformance/address_cases.json");
        if !path.is_file() {
            return;
        }
        let raw = std::fs::read_to_string(&path).expect("read address_cases.json");
        let doc: Value = serde_json::from_str(&raw).expect("parse address_cases.json");

        assert_eq!(doc["prefix"].as_str(), Some(ADDRESS_PREFIX));
        // ⛔ The exclusion IS the design (RFC-002 §4.1). Asserting it here means a
        // change that starts hashing the surface fails a named test rather than
        // silently un-collapsing click and chat.
        assert_eq!(doc["pre_image_keys"], json!(["author", "ops", "parent"]));
        assert_eq!(doc["not_in_the_pre_image"], json!(["surface", "intent"]));

        let cases = doc["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 8, "suspiciously few cases: {}", cases.len());
        let mut by_name: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let pr = &c["proposal"];
            let author = pr["author"].as_str().expect("author");
            let parent = pr["parent"].as_str().expect("parent");
            let ops = pr["ops"].as_array().expect("ops");
            assert_eq!(
                address_pre_image(author, ops, parent),
                c["pre_image"].as_str().unwrap_or_default(),
                "{name}: pre-image bytes"
            );
            let got = content_address(author, ops, parent);
            assert_eq!(got, c["address"].as_str().unwrap_or_default(), "{name}: address");
            by_name.insert(name, got);
        }

        for group in doc["same_address"].as_array().unwrap_or(&vec![]) {
            let names: Vec<&str> = group["cases"]
                .as_array()
                .expect("group cases")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            let set: std::collections::HashSet<&String> =
                names.iter().map(|n| &by_name[n]).collect();
            assert_eq!(set.len(), 1, "{}: {}", group["name"], group["why"]);
        }
        for group in doc["different_address"].as_array().unwrap_or(&vec![]) {
            let names: Vec<&str> = group["cases"]
                .as_array()
                .expect("group cases")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            let set: std::collections::HashSet<&String> =
                names.iter().map(|n| &by_name[n]).collect();
            assert_eq!(set.len(), names.len(), "{}: {}", group["name"], group["why"]);
        }
    }

    /// The hand-written half, for the Bazel run where the fixtures are not staged.
    #[test]
    fn the_address_does_not_see_the_surface_and_does_see_the_author() {
        let ops = vec![json!({"op": "retractNS", "subject": "s", "reason": "r"})];
        let a = content_address("google:1", &ops, "corpus:p");

        // Same ops, same author, same read point, another surface and another
        // intent — §9.1: one proposal, two provenance records.
        let click = check(
            &json!({"parent": "corpus:p", "surface": "Meridian", "ops": ops}),
            author_with("google:1"),
        )
        .unwrap();
        let chat = check(
            &json!({"parent": "corpus:p", "surface": "Chat", "ops": ops, "intent": "asked in chat"}),
            author_with("google:1"),
        )
        .unwrap();
        assert_eq!(click.address.as_deref(), Some(a.as_str()));
        assert_eq!(chat.address.as_deref(), Some(a.as_str()));
        // The STORED bytes differ, which is the other half of the claim.
        assert_ne!(click.canonical, chat.canonical);

        // ⑤ The person does not collapse.
        assert_ne!(content_address("google:2", &ops, "corpus:p"), a);
        // The read point does not either.
        assert_ne!(content_address("google:1", &ops, "corpus:q"), a);
        // Ops are ordered, not a set.
        let two = vec![ops[0].clone(), json!({"op": "retractNS", "subject": "t", "reason": "r"})];
        let swapped = vec![two[1].clone(), two[0].clone()];
        assert_ne!(
            content_address("google:1", &two, "corpus:p"),
            content_address("google:1", &swapped, "corpus:p")
        );
    }

    #[test]
    fn the_proposal_verdict_is_the_weakest_of_its_ops() {
        let ok = json!({"op": "retractNS", "subject": "s", "reason": "r"});
        let kernel_op = json!({"op": "declarePrecedence", "higher": "a", "lower": "b", "rationale": "r"});
        let bad = json!({"op": "assertNS", "subject": "s"});

        let v = |ops: Value, who: Principal| {
            check(&json!({"parent": "p", "ops": ops}), who).unwrap().verdict()
        };
        assert_eq!(v(json!([ok.clone()]), author()), "Admitted");
        assert_eq!(v(json!([ok.clone(), kernel_op.clone()]), author()), "Queued");
        assert_eq!(v(json!([ok.clone(), kernel_op.clone()]), kernel()), "Admitted");
        assert_eq!(v(json!([ok, kernel_op, bad.clone()]), author()), "Rejected");
        assert!(PROPOSAL_VERDICTS.contains(&v(json!([bad]), author())));
    }

    #[test]
    fn a_value_with_no_reproducible_rendering_is_refused_and_leaves_no_name() {
        // ⛔ `1e21` is the case that matters and it is NOT a float in JSON's eyes:
        // JavaScript's `Number.isInteger(1e21)` is true and `String(1e21)` is
        // "1e+21", while ryu writes "1e21". Both implementations refuse the whole
        // safe-integer complement so neither ever has to render it.
        for bad in [json!(1.5), json!(1e21), json!(9007199254740992i64)] {
            let op = json!({"op": "assertNS", "subject": "s", "text": "t",
                            "discipline": "d", "rung": "R0", "bound_value": bad});
            let (v, why) = check_op(&op, &author());
            assert_eq!(v, OpVerdict::Rejected, "{bad} should be refused");
            assert!(why.contains("bound_value"), "{why}");
            assert!(why.contains("safe integer"), "{why}");

            let c = check(&json!({"parent": "p", "ops": [op]}), author()).unwrap();
            // No name, rather than a plausible-looking one for bytes the other
            // implementation would spell differently.
            assert!(c.address.is_none(), "{bad} must leave the proposal unnamed");
            assert_eq!(c.verdict(), "Rejected");
        }
        // The safe range is admitted and rendered as plain digits.
        let op = json!({"op": "assertNS", "subject": "s", "text": "t",
                        "discipline": "d", "rung": "R0", "bound_value": 9007199254740991i64});
        assert_eq!(check_op(&op, &author()).0, OpVerdict::Ok);
        assert!(address_pre_image("a", &[op], "p").contains("9007199254740991"));
    }

    #[test]
    fn the_write_path_is_disabled_without_a_log_path() {
        let log = ProposalLog::new(None);
        assert!(!log.enabled());
        assert!(log.append(&json!({"x": 1})).is_err());
    }
}
