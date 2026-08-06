//! proposal — the RFC-002 §5 proposal IR, queue-side.
//!
//! # What this is, and the one thing it deliberately is not
//!
//! RFC-002 puts `Door.admit` in Lean: it takes `{parents, ops}` and **not**
//! provenance, which is what makes a chat-authored change and a click-authored
//! change indistinguishable downstream by signature. That door does not live here
//! and must not be simulated here.
//!
//! What lives here is the **queue side**: accept a proposal from a browser or an
//! MCP client, check every op against the closed vocabulary and its *local*
//! decidable preconditions, and append the canonical bytes to an append-only log.
//! Admission — the content address, the parent check against a real bitemporal read
//! point, and the gate verdict — happens in the build, where the SPARQL gates and
//! the Lean kernel already are. This is the write-side reading of the same decision
//! `readmodel.rs` records for reads: **the build adjudicates, the plugin queues.**
//!
//! Two consequences worth being blunt about, because a route named `POST /proposal`
//! invites the assumption that it decides something:
//!
//! 1. **No content address is computed here.** `Proposal.id` is a hash over
//!    `(parent, author, ops)`; this crate has no hash primitive and cannot acquire
//!    one without re-pinning the plugin's crate universe. Rather than mint a
//!    plausible-looking identifier from `DefaultHasher` — which is neither stable
//!    across releases nor collision-resistant, and whose docs say so — the response
//!    returns the exact canonical bytes the address will be taken over and
//!    `"address": null`. A fabricated address is strictly worse than an absent one:
//!    it would be indistinguishable from a real one at every downstream callsite.
//! 2. **`verdict-preview` previews the *structure*, not the verdict.** It answers
//!    "is this a well-formed proposal, and what does it touch" plus "here is what is
//!    currently infeasible". It cannot answer "will admitting this create an
//!    unrecorded empty envelope", because that is a `GROUP BY … HAVING` over the
//!    post-admission graph and this plugin has no query engine. Saying so in the
//!    response body is part of the contract.
//!
//! # What it does enforce
//!
//! Everything decidable from the op alone, which is more than it sounds:
//!
//!   * the op kind is in the closed 16-constructor vocabulary (§5);
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
/// RFC's 16, which is the cheapest possible guard against this table and the spec
/// disagreeing.
pub const OPS: &[OpSpec] = &[
    // ── claims ──────────────────────────────────────────────────────────────
    OpSpec {
        kind: "assertNS",
        required: &["subject", "text", "discipline", "rung"],
        optional: &[
            "quantity", "bound_kind", "bound_value", "guard", "defeasible", "scope",
            "citation", "modality", "instrument",
        ],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "amendNS",
        required: &["subject", "text"],
        optional: &[
            "quantity", "bound_kind", "bound_value", "guard", "defeasible", "scope",
            "citation", "modality", "instrument",
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
        optional: &["discipline"],
        exactly_one_of: &[],
        capability: Capability::Author,
    },
    OpSpec {
        kind: "alignTerm",
        required: &["term", "aligns_to"],
        optional: &["discipline"],
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

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// A checked proposal: the ops with their verdicts, plus the canonical bytes.
#[derive(Debug)]
pub struct Checked {
    pub parent: String,
    pub surface: String,
    pub author: Principal,
    pub verdicts: Vec<(String, OpVerdict, String)>,
    pub canonical: String,
}

impl Checked {
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

    // The canonical bytes: exactly `(parent, author, surface, ops, intent)` with
    // keys in a fixed order at every level. This is what the door's content address
    // will be taken over, so it is emitted here — byte-for-byte — rather than
    // re-derived downstream from a re-serialization that might order keys
    // differently.
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

    Ok(Checked {
        parent,
        surface,
        author,
        verdicts,
        canonical,
    })
}

// ── the flat, single-op form of a proposal ────────────────────────────────────
//
// A meridian `FormPanel` submits a FLAT object: `buildRequestFromBindings` maps
// each binding to `req[request_field] = <form field value>`, and every value is a
// string because it came out of an `<input>`. So a declarative form cannot post
// `{parent, ops: [{...}]}` directly — the shape is one level too deep and the types
// are all strings.
//
// Rather than give up on declarative writes (which would mean every write
// affordance needs shell-side JavaScript), the plugin accepts the flat form of the
// COMMON case: a proposal carrying exactly one op. Multi-op proposals with per-op
// triage still need a richer surface; one-op proposals are most of them, and they
// become expressible with no browser code at all.
//
// The coercion below is deliberately narrow and declared, not inferred: only these
// named fields are re-typed, only on this route, and a value that doesn't parse is
// an error rather than a silent passthrough. `POST /proposal` (the nested route)
// coerces nothing — a programmatic client sends real JSON types.

/// Fields whose form value is a comma-separated list.
const ARRAY_FIELDS: &[&str] = &["parties"];
/// Fields whose form value is a boolean.
const BOOL_FIELDS: &[&str] = &["is_axiom", "defeasible"];
/// Fields whose form value is a number.
const NUMBER_FIELDS: &[&str] = &["bound_value"];

/// Turn a flat form submission into a one-op proposal body.
///
/// `{parent, surface?, op, <op fields…>}` → `{parent, surface, ops: [{op, …}]}`.
pub fn from_flat(body: &Value) -> Result<Value, String> {
    let obj = body.as_object().ok_or("body is not a JSON object")?;
    let parent = obj
        .get("parent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("a form submission requires `parent` — the read point the author saw")?;
    let surface = obj
        .get("surface")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("Meridian");
    let kind = obj
        .get("op")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("a form submission requires `op` — bind it as a literal in the descriptor")?;

    let mut op = Map::new();
    op.insert("op".into(), json!(kind));
    for (key, raw) in obj {
        if matches!(key.as_str(), "parent" | "surface" | "op") {
            continue;
        }
        // An empty optional field is what an untouched form input sends. Dropping it
        // is the difference between "the author left this blank" and "the author set
        // this to the empty string", and only the first is what a form can mean.
        if is_empty_value(raw) {
            continue;
        }
        op.insert(key.clone(), coerce(key, raw)?);
    }
    Ok(json!({ "parent": parent, "surface": surface, "ops": [Value::Object(op)] }))
}

fn coerce(key: &str, raw: &Value) -> Result<Value, String> {
    // Already the right type (a programmatic caller, or a form field the shell sent
    // as a number) — leave it alone.
    let s = match raw.as_str() {
        Some(s) => s.trim(),
        None => return Ok(raw.clone()),
    };
    if ARRAY_FIELDS.contains(&key) {
        let items: Vec<Value> = s
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(|x| json!(x))
            .collect();
        return Ok(Value::Array(items));
    }
    if BOOL_FIELDS.contains(&key) {
        return match s {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            other => Err(format!("`{key}` must be true or false; got `{other}`")),
        };
    }
    if NUMBER_FIELDS.contains(&key) {
        return s
            .parse::<f64>()
            .map(|n| json!(n))
            .map_err(|_| format!("`{key}` must be a number; got `{s}`"));
    }
    Ok(json!(s))
}

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
    fn agent() -> Principal {
        Principal { agent: true, ..author() }
    }

    #[test]
    fn vocabulary_is_closed_and_total() {
        // RFC-002 §5's table has 16 constructors. A drift here means the RFC and
        // the door disagree about what an op is.
        assert_eq!(OPS.len(), 16);
        for o in OPS {
            assert!(op_spec(o.kind).is_some());
        }
        assert!(op_spec("assertNSS").is_none());
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

    #[test]
    fn a_flat_form_submission_becomes_a_one_op_proposal() {
        // Every value a string, as a meridian FormPanel sends them.
        let flat = json!({
            "parent": "p", "op": "assertNS", "subject": "fire-soc-cap",
            "text": "MUST NOT exceed 70 MW", "discipline": "fire & life safety",
            "rung": "R4", "quantity": "q-sustained-discharge",
            "bound_kind": "UpperBound", "bound_value": "70", "defeasible": "false",
            "guard": ""
        });
        let body = from_flat(&flat).unwrap();
        let ops = body["ops"].as_array().unwrap();
        assert_eq!(ops.len(), 1);
        // Coerced by the declared tables…
        assert_eq!(ops[0]["bound_value"], json!(70.0));
        assert_eq!(ops[0]["defeasible"], json!(false));
        // …and the blank optional field dropped, not sent as "".
        assert!(ops[0].get("guard").is_none(), "an untouched input must not be sent");
        let c = check(&body, author()).unwrap();
        assert_eq!((c.admissible(), c.queued(), c.rejected()), (1, 0, 0));
    }

    #[test]
    fn a_flat_parties_list_becomes_an_array() {
        let flat = json!({"parent": "p", "op": "openConflict", "conflict": "INV-20",
                          "kind": "EmptyEnvelope", "parties": "claim-a, claim-b"});
        let body = from_flat(&flat).unwrap();
        assert_eq!(body["ops"][0]["parties"], json!(["claim-a", "claim-b"]));
        assert_eq!(check(&body, author()).unwrap().admissible(), 1);
        // One party is still a rejection — the coercion must not smuggle past the check.
        let one = json!({"parent": "p", "op": "openConflict", "conflict": "INV-20",
                         "kind": "EmptyEnvelope", "parties": "claim-a"});
        let body = from_flat(&one).unwrap();
        assert_eq!(check(&body, author()).unwrap().rejected(), 1);
    }

    #[test]
    fn a_flat_field_that_will_not_coerce_is_an_error_not_a_passthrough() {
        let flat = json!({"parent": "p", "op": "assertNS", "subject": "s", "text": "t",
                          "discipline": "d", "rung": "R4", "bound_value": "seventy"});
        let err = from_flat(&flat).expect_err("a non-numeric bound must not pass");
        assert!(err.contains("bound_value"), "{err}");
    }

    #[test]
    fn a_flat_submission_needs_a_parent_and_an_op() {
        assert!(from_flat(&json!({"op": "retractNS"})).is_err());
        assert!(from_flat(&json!({"parent": "p"})).is_err());
    }

    #[test]
    fn the_write_path_is_disabled_without_a_log_path() {
        let log = ProposalLog::new(None);
        assert!(!log.enabled());
        assert!(log.append(&json!({"x": 1})).is_err());
    }
}
