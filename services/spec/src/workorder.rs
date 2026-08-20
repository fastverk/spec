//! Work orders: what may be dispatched, and why not.
//!
//! ## The order is derived, the verdict is computed
//!
//! Nothing in this module authors a work order. The build derives them
//! (`//rdf/fanout`, `//tools/fanout:derive`) from one corpus at one bitemporal
//! cursor and commits the payload; this module serves that payload and answers
//! one question about it — may this order dispatch now — from the payload plus
//! the dispatch log. `mocks/ux/panels.authoring.textproto` states the rule this
//! encodes: "an order with a non-empty `conflict_holds` cannot dispatch, so
//! HELD is a computed state and not a human's label."
//!
//! ## Four refusals, and why each is a refusal rather than a warning
//!
//! * **HELD** — `conflict_holds` is non-empty. RFC-002 §10 mechanism 3, and
//!   P7's acceptance bar: "an order whose closure touches an open conflict
//!   refuses to dispatch." Deliberately not overridable at this door. The
//!   override is adjudicating the conflict, which is a different act by a
//!   different principal with its own record — an override flag here would make
//!   the gate advisory, and an advisory gate is the thing this plane exists to
//!   stop being.
//! * **OVERLAP** — the order's scope or write paths collide with a RUNNING
//!   order. P7's exit bar is "zero cross-scope writes (verified, not observed)";
//!   two agents authorized to write the same path is how that stops being true,
//!   and it is checkable here before either starts.
//! * **UNKNOWN** — no such order at the read model's cursor. A dispatch naming
//!   an order the corpus does not derive is a stale caller, not a new order.
//! * **ALREADY RUNNING** — dispatch is not idempotent re-arming. Re-dispatching
//!   a running order would fan out a second wave against the same paths, which
//!   is the OVERLAP failure with extra steps.
//!
//! ## Refuse before appending
//!
//! Same rule as `crate::evaluation`, for the same reason: a refusal appends
//! nothing. Writing a dispatch record and letting something downstream notice
//! it should not have happened means the log — the only durable account of what
//! was authorized — is knowingly wrong.
//!
//! ## An agent may not dispatch
//!
//! `crate::proposal` restricts an agent principal to `assertNS` at R0. Dispatch
//! is a wider act than anything in that vocabulary: it authorizes writes to a
//! path set. An agent that could dispatch could widen its own scope by
//! dispatching an order with better paths, which is exactly the containment
//! RFC-002 §10 mechanism 4 describes. So the door refuses it here, and — as
//! §7.1 and §13 item 1 are honest about — that is a code property, not a
//! theorem.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

/// `spec.v1.DispatchVerdict`, as the wire strings the route returns.
pub const DISPATCHED: &str = "DISPATCH_VERDICT_DISPATCHED";
pub const REFUSED_HELD: &str = "DISPATCH_VERDICT_REFUSED_HELD";
pub const REFUSED_OVERLAP: &str = "DISPATCH_VERDICT_REFUSED_OVERLAP";
pub const REFUSED_UNKNOWN: &str = "DISPATCH_VERDICT_REFUSED_UNKNOWN";
pub const REFUSED_ALREADY_RUNNING: &str = "DISPATCH_VERDICT_REFUSED_ALREADY_RUNNING";

/// `spec.v1.StopCause` — why a dispatched order stopped. A stop is an EVENT
/// with a named cause, never an absence: an order that vanishes from the
/// running set is otherwise indistinguishable from one nobody dispatched.
pub const STOP_BUDGET_EXHAUSTED: &str = "STOP_CAUSE_BUDGET_EXHAUSTED";
pub const STOP_COMPLETED: &str = "STOP_CAUSE_COMPLETED";
pub const STOP_WITHDRAWN: &str = "STOP_CAUSE_WITHDRAWN";
pub const STOP_CAUSES: &[&str] = &[STOP_BUDGET_EXHAUSTED, STOP_COMPLETED, STOP_WITHDRAWN];

/// `spec.v1.WorkOrderState`.
pub const STATE_READY: &str = "WORK_ORDER_STATE_READY";
pub const STATE_HELD: &str = "WORK_ORDER_STATE_HELD";
pub const STATE_RUNNING: &str = "WORK_ORDER_STATE_RUNNING";

/// The fields of a derived order this door reads. Everything else in the packet
/// (obligations, glossary, acceptance) is for the agent, not the gate.
#[derive(Debug, Clone)]
pub struct Order {
    pub order_id: String,
    pub scope: String,
    pub conflict_holds: Vec<String>,
    pub write_paths: Vec<String>,
    /// The token ceiling set at derivation, immutable after dispatch (#46).
    /// 0 means NO CEILING WAS SET — stated, never defaulted, because "unbounded
    /// by decision" and "unbounded because nobody said" are different facts and
    /// only one of them is a budget.
    pub budget_tokens: i64,
    pub discipline: String,
}

impl Order {
    /// From one row of the `workorders` payload. A row without an `order_id` is
    /// skipped rather than defaulted: an unnamed order cannot be dispatched,
    /// and inventing a name would make it dispatchable.
    fn from_row(row: &Value) -> Option<Self> {
        let order = row.get("order").unwrap_or(row);
        let order_id = order.get("order_id").and_then(Value::as_str)?.trim();
        if order_id.is_empty() {
            return None;
        }
        Some(Self {
            order_id: order_id.to_string(),
            scope: order.get("scope").and_then(Value::as_str).unwrap_or("").to_string(),
            conflict_holds: strings(order.get("conflict_holds")),
            write_paths: strings(
                order
                    .get("write_capability")
                    .and_then(|c| c.get("artifact_paths")),
            ),
            budget_tokens: order
                .pointer("/budget/max_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            discipline: order
                .get("discipline")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Every derived order in a `workorders` payload, keyed by id.
pub fn orders(payload: &Value) -> HashMap<String, Order> {
    payload
        .get("orders")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Order::from_row)
                .map(|o| (o.order_id.clone(), o))
                .collect()
        })
        .unwrap_or_default()
}

/// What the dispatch log says is running, replayed.
///
/// Append-only, so the log carries `dispatched` and `closed` records and the
/// running set is their fold — the same shape as `Evaluated`'s replay next
/// door. A malformed line is skipped rather than fatal: one bad record must not
/// hide the good ones after it.
#[derive(Debug, Default)]
pub struct Running {
    by_id: HashMap<String, Value>,
    /// Cumulative reported spend per order, and where the last report came
    /// from. Kept for CLOSED orders too — the ledger's question is "where did
    /// this week's tokens go", and dropping an order's spend when it finishes
    /// would answer it only for work still in flight.
    spend: HashMap<String, (i64, String)>,
    stops: HashMap<String, String>,
    pub records: usize,
}

impl Running {
    /// Replay the dispatch log.
    ///
    /// ⛔ FAILS CLOSED. `Err` is NOT an empty log: an unreadable file (permissions,
    /// a half-mounted volume, a truncated read) returning "nothing is running"
    /// makes every live order look never-dispatched, so its scope and paths are
    /// free and the door hands them to a SECOND set of agents while the first is
    /// still writing. An absent path is a different fact — the write path is
    /// disabled, nothing was ever dispatched — and stays empty.
    pub fn read(path: Option<&Path>) -> Result<Self, String> {
        let mut out = Self::default();
        let Some(path) = path else { return Ok(out) };
        let body = match std::fs::read_to_string(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Not yet created: the log is enabled and nothing has been
                // written. That IS an empty log.
                return Ok(out);
            }
            Err(e) => {
                return Err(format!(
                    "dispatch log at {} could not be read ({e}) — refusing rather than \
                     reporting an empty running set, which would free every live order's \
                     scope",
                    path.display()
                ))
            }
        };
        for line in body.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(rec) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(id) = rec.get("order_id").and_then(Value::as_str) else {
                continue;
            };
            out.records += 1;
            match rec.get("event").and_then(Value::as_str).unwrap_or("dispatched") {
                "closed" => {
                    out.by_id.remove(id);
                }
                "stopped" => {
                    out.by_id.remove(id);
                    if let Some(cause) = rec.get("cause").and_then(Value::as_str) {
                        out.stops.insert(id.to_string(), cause.to_string());
                    }
                }
                "spend" => {
                    // Reports are CUMULATIVE snapshots of the platform's own
                    // accumulator, so a delayed or duplicated report must be
                    // idempotent rather than double-counted — and a report
                    // LOWER than one already recorded is a stale snapshot, not
                    // a refund. Keep the high-water mark and say so.
                    let tokens = rec.get("tokens").and_then(Value::as_i64).unwrap_or(0);
                    let source = rec
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let entry = out.spend.entry(id.to_string()).or_insert((0, String::new()));
                    if tokens >= entry.0 {
                        *entry = (tokens, source);
                    }
                }
                _ => {
                    out.by_id.insert(id.to_string(), rec);
                }
            }
        }
        Ok(out)
    }

    pub fn is_running(&self, order_id: &str) -> bool {
        self.by_id.contains_key(order_id)
    }

    pub fn ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.by_id.keys().map(String::as_str).collect();
        ids.sort_unstable();
        ids
    }

    /// Agents on a running order, 0 if not running or unrecorded.
    pub fn agents(&self, order_id: &str) -> i64 {
        self.by_id
            .get(order_id)
            .and_then(|r| r.get("agents"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    }
}

impl Running {
    /// Cumulative reported spend for an order, and the last reported source.
    pub fn spent(&self, order_id: &str) -> (i64, &str) {
        self.spend
            .get(order_id)
            .map(|(n, s)| (*n, s.as_str()))
            .unwrap_or((0, ""))
    }

    /// Why an order stopped, if it did.
    pub fn stop_cause(&self, order_id: &str) -> &str {
        self.stops.get(order_id).map(String::as_str).unwrap_or("")
    }

    /// Whether the order was ever dispatched — running, stopped or closed.
    /// Spend cannot be reported against a thread that never started.
    pub fn was_dispatched(&self, order_id: &str) -> bool {
        self.by_id.contains_key(order_id)
            || self.spend.contains_key(order_id)
            || self.stops.contains_key(order_id)
    }
}

/// A close, checked. The counterpart of dispatch: a thread ends because its
/// acceptance checks passed or because a person stopped it, and either way the
/// ending is an EVENT with a cause rather than the absence of one.
///
/// ⛔ Budget exhaustion is NOT closable here. That cause is written by the
/// spend door at the moment it can see the crossing, and letting a caller
/// assert it would let anyone retroactively label a thread they stopped for
/// another reason as having run out of money.
pub fn check_close(
    body: &Value,
    orders: &HashMap<String, Order>,
    running: &Running,
) -> Result<(String, &'static str), String> {
    let obj = body.as_object().ok_or("body is not a JSON object")?;
    let order_id = obj
        .get("order_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if order_id.is_empty() {
        return Err("`order_id` is required — a close ends one thread".into());
    }
    if !orders.contains_key(&order_id) {
        return Err(format!("no work order `{order_id}` at this cursor"));
    }
    if !running.is_running(&order_id) {
        return Err(format!(
            "`{order_id}` is not running — there is no thread to end. Closing a stopped \
             order would write a second terminal event over the first"
        ));
    }
    let cause = match obj.get("cause").and_then(Value::as_str).unwrap_or("").trim() {
        "" | "completed" | "COMPLETED" | STOP_COMPLETED => STOP_COMPLETED,
        "withdrawn" | "WITHDRAWN" | STOP_WITHDRAWN => STOP_WITHDRAWN,
        other => {
            return Err(format!(
                "`{other}` is not a cause a person may record — completed (the acceptance \
                 checks passed) or withdrawn (someone stopped it). Budget exhaustion is \
                 written by the spend door at the moment it sees the crossing"
            ))
        }
    };
    Ok((order_id, cause))
}

/// A spend report, checked. `crate::evaluation`'s posture applies verbatim:
/// this is a MEASUREMENT a machine reports, not a judgement anyone is asked to
/// agree with, and spec does not meter it — the platform's scheduler holds the
/// ceiling and accumulates the number. What spec keeps is the account.
#[derive(Debug, Clone)]
pub struct Spend {
    pub order_id: String,
    pub tokens: i64,
    pub source: String,
}

pub fn check_spend(
    body: &Value,
    orders: &HashMap<String, Order>,
    running: &Running,
) -> Result<Spend, String> {
    let obj = body.as_object().ok_or("body is not a JSON object")?;
    let order_id = obj
        .get("order_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if order_id.is_empty() {
        return Err("`order_id` is required — spend belongs to one thread".into());
    }
    if !orders.contains_key(&order_id) {
        return Err(format!(
            "no work order `{order_id}` at this cursor — spend reported against an order \
             nobody derived cannot be reconciled with any budget"
        ));
    }
    // ⛔ A thread that never started cannot have spent anything. Accepting this
    // would let an unbudgeted number into the account and, worse, let a
    // never-dispatched order read as exhausted.
    if !running.was_dispatched(&order_id) {
        return Err(format!(
            "`{order_id}` was never dispatched — there is no thread to spend against"
        ));
    }
    let tokens = obj
        .get("tokens")
        .and_then(Value::as_i64)
        .ok_or("`tokens` must be an integer count of tokens spent")?;
    if tokens < 0 {
        return Err("`tokens` cannot be negative — a report is a cumulative total".into());
    }
    Ok(Spend {
        order_id,
        tokens,
        source: obj
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
    })
}

impl Spend {
    pub fn record(&self, author: &str) -> Value {
        json!({
            "event": "spend",
            "order_id": self.order_id,
            "tokens": self.tokens,
            "source": self.source,
            "author": author,
        })
    }

    /// Does admitting this report exhaust the order's budget?
    ///
    /// A crossing report is ACCEPTED and then stops the order — refusing it
    /// would leave the account understated at exactly the moment it matters
    /// most, and the ceiling is the platform's to enforce anyway. What spec
    /// does is record the stop, with its cause, at the moment it can see it.
    pub fn exhausts(&self, order: &Order) -> bool {
        order.budget_tokens > 0 && self.tokens >= order.budget_tokens
    }
}

/// The record appended when a dispatched order stops.
pub fn stop_record(order_id: &str, cause: &str, tokens: i64, author: &str) -> Value {
    json!({
        "event": "stopped",
        "order_id": order_id,
        "cause": cause,
        "tokens": tokens,
        "author": author,
    })
}

/// One ledger row per derived order: allocated, reported, remaining, and what
/// became of the thread.
pub fn ledger(orders: &HashMap<String, Order>, running: &Running) -> Vec<Value> {
    let mut ids: Vec<&String> = orders.keys().collect();
    ids.sort();
    ids.iter()
        .map(|id| {
            let order = &orders[*id];
            let (spent, source) = running.spent(id);
            let remaining = if order.budget_tokens > 0 {
                (order.budget_tokens - spent).max(0)
            } else {
                0
            };
            json!({
                "order_id": order.order_id,
                "discipline": local_name(&order.discipline),
                "budget_tokens": order.budget_tokens,
                "spent_tokens": spent,
                // ⚠ Zero remaining with a zero budget means NO CEILING WAS SET,
                // not "nothing left". `budget_tokens` is what tells them apart,
                // which is why both travel rather than one derived number.
                "remaining_tokens": remaining,
                "state": state(order, running),
                "stop_cause": running.stop_cause(id),
                "spend_source": source,
            })
        })
        .collect()
}

/// Spend summed per discipline — "where did this week's tokens go", which the
/// issue asks be a table rather than a guess.
pub fn ledger_by_discipline(rows: &[Value]) -> Vec<Value> {
    let mut totals: HashMap<String, (i64, i64, usize)> = HashMap::new();
    for row in rows {
        let d = row["discipline"].as_str().unwrap_or("").to_string();
        let e = totals.entry(d).or_insert((0, 0, 0));
        e.0 += row["budget_tokens"].as_i64().unwrap_or(0);
        e.1 += row["spent_tokens"].as_i64().unwrap_or(0);
        e.2 += 1;
    }
    let mut out: Vec<(String, (i64, i64, usize))> = totals.into_iter().collect();
    out.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(a.0.cmp(&b.0)));
    out.into_iter()
        .map(|(discipline, (budget, spent, orders))| {
            json!({
                "discipline": discipline,
                "orders": orders,
                "budget_tokens": budget,
                "spent_tokens": spent,
            })
        })
        .collect()
}

fn local_name(iri: &str) -> String {
    for sep in ['#', '/'] {
        if let Some((_, tail)) = iri.rsplit_once(sep) {
            return tail.to_string();
        }
    }
    iri.to_string()
}

/// The dispatch gate's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub verdict: &'static str,
    /// For HELD: the live holds. For OVERLAP: the running orders it collides
    /// with, each with what collided. Empty on DISPATCHED.
    pub because: Vec<String>,
}

impl Verdict {
    fn refused(verdict: &'static str, because: Vec<String>) -> Self {
        Self { verdict, because }
    }
    pub fn is_dispatched(&self) -> bool {
        self.verdict == DISPATCHED
    }
    pub fn to_json(&self) -> Value {
        json!({ "verdict": self.verdict, "because": self.because })
    }
}

/// May `order_id` dispatch, given the derived orders and what is running?
///
/// Order of checks is deliberate: UNKNOWN before everything (nothing else can
/// be evaluated without the order), ALREADY_RUNNING before HELD (a caller
/// re-dispatching a running order needs to hear that, not a stale hold list),
/// then HELD before OVERLAP, because a held order's overlap is irrelevant — it
/// is not going anywhere either way, and reporting the weaker refusal would
/// invite fixing the wrong thing.
pub fn check(order_id: &str, orders: &HashMap<String, Order>, running: &Running) -> Verdict {
    let Some(order) = orders.get(order_id) else {
        return Verdict::refused(
            REFUSED_UNKNOWN,
            vec![format!(
                "no work order `{order_id}` at this cursor — the read model derives {}",
                describe_ids(orders)
            )],
        );
    };
    if running.is_running(order_id) {
        return Verdict::refused(
            REFUSED_ALREADY_RUNNING,
            vec![format!("`{order_id}` is already running")],
        );
    }
    if !order.conflict_holds.is_empty() {
        return Verdict::refused(REFUSED_HELD, order.conflict_holds.clone());
    }
    let mut collisions = Vec::new();
    for other_id in running.ids() {
        let Some(other) = orders.get(other_id) else {
            // Running an order this cursor no longer derives: the corpus moved
            // under a live dispatch. Not this call's problem to fix, but its
            // paths are still claimed, and treating an order we cannot read as
            // claiming nothing is the fail-OPEN direction.
            collisions.push(format!(
                "`{other_id}` is running and is not derived at this cursor — its scope and \
                 paths cannot be compared, so it is treated as claiming everything"
            ));
            continue;
        };
        if other.scope == order.scope && !order.scope.is_empty() {
            collisions.push(format!("`{other_id}` holds the same scope `{}`", order.scope));
        }
        for p in &order.write_paths {
            for q in &other.write_paths {
                if paths_overlap(p, q) {
                    collisions.push(format!(
                        "`{other_id}` writes `{q}`, which overlaps `{p}`"
                    ));
                }
            }
        }
    }
    if !collisions.is_empty() {
        collisions.sort();
        collisions.dedup();
        return Verdict::refused(REFUSED_OVERLAP, collisions);
    }
    Verdict {
        verdict: DISPATCHED,
        because: Vec::new(),
    }
}

/// The state the panel renders — computed, never stored.
pub fn state(order: &Order, running: &Running) -> &'static str {
    if running.is_running(&order.order_id) {
        STATE_RUNNING
    } else if order.conflict_holds.is_empty() {
        STATE_READY
    } else {
        STATE_HELD
    }
}

/// Do two write-path patterns claim any file in common?
///
/// ⚠ CONSERVATIVE ON PURPOSE, and this is the one place in the door where
/// "conservative" needs saying out loud. Full glob semantics are not
/// implemented: each pattern is truncated at its first wildcard segment and the
/// two prefixes are compared for a prefix relation. `src/thermal/**` overlaps
/// `src/thermal/derate/**` (true), and `src/*/gen` overlaps `src/bid/gen`
/// (true, and a precise matcher would agree). Where it errs it errs toward
/// REPORTING an overlap — `src/*/a` vs `src/*/b` truncate to the same `src/`
/// prefix and are called overlapping although a precise matcher would not.
///
/// That direction is the safe one for a gate whose bar is "zero cross-scope
/// writes": a false overlap refuses a dispatch a person can re-scope; a missed
/// overlap authorizes two agents to write one file and is discovered by
/// whichever one loses. The precise matcher is worth building the day a corpus
/// wants patterns this cannot separate — and NOT before, because a glob
/// implementation that is 99% right is worse here than one that is
/// deliberately, legibly blunt.
fn paths_overlap(a: &str, b: &str) -> bool {
    let pa = wildcard_prefix(a);
    let pb = wildcard_prefix(b);
    pa.starts_with(&pb) || pb.starts_with(&pa)
}

/// The literal prefix of a pattern, NORMALIZED.
///
/// ⛔ Normalization is not tidiness here, it is the difference between failing
/// open and failing closed. `src/thermal/**` and `./src/thermal/**` and
/// `/src/thermal/**` and `src/bid/../thermal/**` all name the same files, and a
/// raw string comparison calls the last three disjoint from the first — so two
/// orders would both be authorized to write one tree, which is precisely the
/// cross-scope write P7's exit bar forbids. `..` is resolved rather than
/// rejected because a config is written by a person, and a person who writes
/// `src/bid/../thermal` means `src/thermal`.
fn wildcard_prefix(pattern: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in pattern.split('/') {
        if seg.contains('*') || seg.contains('?') || seg.contains('[') {
            break;
        }
        match seg {
            // A leading empty segment is an absolute path; an interior one is a
            // doubled slash. Both mean "nothing here".
            "" | "." => continue,
            ".." => {
                // Above the root is still the root: a pattern that escapes the
                // repo claims everything under it, which is the conservative
                // reading and the one that refuses rather than authorizes.
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let mut out = parts.join("/");
    out.push('/');
    out
}

fn describe_ids(orders: &HashMap<String, Order>) -> String {
    if orders.is_empty() {
        return "none".to_string();
    }
    let mut ids: Vec<&str> = orders.keys().map(String::as_str).collect();
    ids.sort_unstable();
    ids.join(", ")
}

/// The record appended on a dispatch. Deliberately minimal and self-describing:
/// what was dispatched, at which cursor, by whom, with how many agents. The
/// packet itself is not copied in — it is derivable from `as_of` and the config,
/// and copying it would make the log a second source of truth for obligations.
pub fn record(order: &Order, as_of: &str, author: &str, agents: i64) -> Value {
    json!({
        "event": "dispatched",
        "order_id": order.order_id,
        "scope": order.scope,
        "as_of": as_of,
        "author": author,
        "agents": agents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Value {
        json!({
            "orders": [
                {
                    "order_id": "wo-041",
                    "order": {
                        "order_id": "wo-041",
                        "scope": "s-oem-warranty",
                        "conflict_holds": ["INV-03", "INV-11"],
                        "write_capability": { "artifact_paths": ["src/thermal/**"] }
                    }
                },
                {
                    "order_id": "wo-042",
                    "order": {
                        "order_id": "wo-042",
                        "scope": "s-market-b",
                        "conflict_holds": [],
                        "write_capability": { "artifact_paths": ["src/bid/**"] }
                    }
                },
                {
                    "order_id": "wo-046",
                    "order": {
                        "order_id": "wo-046",
                        "scope": "s-lgia",
                        "conflict_holds": [],
                        "write_capability": { "artifact_paths": ["src/bid/settle/**"] }
                    }
                },
                {
                    "order_id": "wo-057",
                    "order": {
                        "order_id": "wo-057",
                        "scope": "s-market-b",
                        "conflict_holds": [],
                        "write_capability": { "artifact_paths": ["src/itc/**"] }
                    }
                }
            ]
        })
    }

    /// ⛔ Through `Running::read`, NOT by populating the maps directly.
    ///
    /// The first version of this helper reimplemented the replay — and passed
    /// every dispatch test while silently ignoring `spend` and `stopped`,
    /// because a double that reimplements the thing under test proves the
    /// double works. Writing the records and reading them back means these
    /// tests exercise the parser they are about, including the event
    /// dispatch, the high-water rule, and the malformed-line skip.
    fn running_with(lines: &[Value]) -> Running {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "spec-wo-replay-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dispatch.jsonl");
        let body: String = lines
            .iter()
            .map(|r| format!("{r}\n"))
            .collect::<Vec<_>>()
            .join("");
        std::fs::write(&path, body).unwrap();
        let running = Running::read(Some(&path)).expect("fixture log is readable");
        std::fs::remove_dir_all(&dir).ok();
        running
    }

    #[test]
    fn a_ready_order_dispatches() {
        let o = orders(&payload());
        let v = check("wo-042", &o, &Running::default());
        assert_eq!(v.verdict, DISPATCHED, "{v:?}");
        assert!(v.because.is_empty());
    }

    #[test]
    fn a_held_order_refuses_and_says_which_conflicts() {
        let o = orders(&payload());
        let v = check("wo-041", &o, &Running::default());
        assert_eq!(v.verdict, REFUSED_HELD);
        assert_eq!(v.because, vec!["INV-03".to_string(), "INV-11".to_string()]);
    }

    #[test]
    fn the_hold_is_not_overridable_because_there_is_no_flag_to_pass() {
        // Encoded as a test because it is a DESIGN property, not an
        // implementation detail: `check` takes no override argument, so no
        // caller — route, MCP tool, or future gRPC — can pass one. If someone
        // adds a parameter, this test is where the argument happens.
        let o = orders(&payload());
        for _ in 0..3 {
            assert_eq!(check("wo-041", &o, &Running::default()).verdict, REFUSED_HELD);
        }
    }

    #[test]
    fn an_unknown_order_refuses_and_names_what_exists() {
        let o = orders(&payload());
        let v = check("wo-999", &o, &Running::default());
        assert_eq!(v.verdict, REFUSED_UNKNOWN);
        assert!(v.because[0].contains("wo-041, wo-042, wo-046, wo-057"), "{:?}", v.because);
    }

    #[test]
    fn a_running_order_will_not_re_dispatch() {
        let o = orders(&payload());
        let r = running_with(&[json!({"order_id": "wo-042", "agents": 3})]);
        assert_eq!(check("wo-042", &o, &r).verdict, REFUSED_ALREADY_RUNNING);
    }

    #[test]
    fn same_scope_as_a_running_order_refuses() {
        let o = orders(&payload());
        let r = running_with(&[json!({"order_id": "wo-042", "agents": 3})]);
        // wo-057 is scoped s-market-b, same as the running wo-042 — its paths
        // do not collide, so scope alone must be enough to refuse.
        let v = check("wo-057", &o, &r);
        assert_eq!(v.verdict, REFUSED_OVERLAP);
        assert!(v.because[0].contains("same scope"), "{:?}", v.because);
    }

    #[test]
    fn nested_write_paths_collide_even_across_different_scopes() {
        let o = orders(&payload());
        let r = running_with(&[json!({"order_id": "wo-042", "agents": 2})]);
        // wo-046 is s-lgia (a different scope) but writes src/bid/settle/**,
        // under the running order's src/bid/**. This is the cross-scope write
        // P7's exit bar forbids, caught before either agent starts.
        let v = check("wo-046", &o, &r);
        assert_eq!(v.verdict, REFUSED_OVERLAP);
        assert!(v.because[0].contains("src/bid/**"), "{:?}", v.because);
    }

    #[test]
    fn closing_an_order_frees_its_scope_and_paths() {
        let o = orders(&payload());
        let r = running_with(&[
            json!({"order_id": "wo-042", "agents": 2}),
            json!({"order_id": "wo-042", "event": "closed"}),
        ]);
        assert!(!r.is_running("wo-042"));
        assert_eq!(check("wo-046", &o, &r).verdict, DISPATCHED);
        assert_eq!(check("wo-057", &o, &r).verdict, DISPATCHED);
    }

    #[test]
    fn a_running_order_this_cursor_cannot_read_claims_everything() {
        let o = orders(&payload());
        let r = running_with(&[json!({"order_id": "wo-from-another-cursor", "agents": 1})]);
        let v = check("wo-042", &o, &r);
        assert_eq!(v.verdict, REFUSED_OVERLAP, "fail closed, not open");
        assert!(v.because[0].contains("treated as claiming everything"), "{:?}", v.because);
    }

    #[test]
    fn held_is_reported_before_overlap() {
        let o = orders(&payload());
        // wo-041 is both held and (were it not) path-clear; make a collision
        // exist too and assert the stronger refusal wins.
        let r = running_with(&[json!({"order_id": "wo-042", "agents": 1})]);
        assert_eq!(check("wo-041", &o, &r).verdict, REFUSED_HELD);
    }

    #[test]
    fn state_is_computed_from_holds_and_the_log() {
        let o = orders(&payload());
        let empty = Running::default();
        assert_eq!(state(&o["wo-041"], &empty), STATE_HELD);
        assert_eq!(state(&o["wo-042"], &empty), STATE_READY);
        let r = running_with(&[json!({"order_id": "wo-042", "agents": 4})]);
        assert_eq!(state(&o["wo-042"], &r), STATE_RUNNING);
        assert_eq!(r.agents("wo-042"), 4);
        assert_eq!(r.agents("wo-041"), 0);
    }

    #[test]
    fn path_overlap_is_blunt_in_the_safe_direction() {
        assert!(paths_overlap("src/thermal/**", "src/thermal/derate/**"));
        assert!(paths_overlap("src/bid/**", "src/bid/settle/**"));
        assert!(paths_overlap("src/a/**", "src/a/**"));
        assert!(!paths_overlap("src/thermal/**", "src/bid/**"));
        assert!(!paths_overlap("src/itc/**", "src/bid/**"));
        // Documented imprecision: two different wildcard segments truncate to
        // the same prefix and are reported as overlapping.
        assert!(paths_overlap("src/*/a", "src/*/b"));
    }

    #[test]
    fn a_row_without_an_id_is_skipped_not_defaulted() {
        let o = orders(&json!({"orders": [{"order": {"scope": "s-x"}}, {"order": {"order_id": "  "}}]}));
        assert!(o.is_empty());
    }

    #[test]
    fn a_malformed_log_line_does_not_hide_the_records_after_it() {
        let dir = std::env::temp_dir().join(format!("wo-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dispatch.jsonl");
        std::fs::write(
            &path,
            "{\"order_id\":\"wo-042\",\"agents\":2}\nnot json\n{\"order_id\":\"wo-046\",\"agents\":1}\n",
        )
        .unwrap();
        let r = Running::read(Some(&path)).unwrap();
        assert_eq!(r.ids(), vec!["wo-042", "wo-046"]);
        assert_eq!(r.records, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_absent_log_is_empty_but_an_unreadable_one_is_an_error() {
        // The distinction the whole fail-closed rule rests on: "the log does
        // not exist yet" is an empty running set; "the log cannot be read" is
        // NOT, because reporting empty frees every live order's scope.
        let dir = std::env::temp_dir().join(format!("wo-unreadable-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(Running::read(None).unwrap().ids().is_empty());
        let missing = dir.join("never-written.jsonl");
        assert!(Running::read(Some(&missing)).unwrap().ids().is_empty());
        // A directory where a file should be: readable metadata, unreadable
        // contents — the closest portable stand-in for a broken mount.
        let as_dir = dir.join("adirectory.jsonl");
        std::fs::create_dir_all(&as_dir).unwrap();
        let err = Running::read(Some(&as_dir)).unwrap_err();
        assert!(err.contains("could not be read"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn path_normalization_closes_the_aliasing_hole() {
        // Every one of these names the same tree. A raw string comparison
        // called them disjoint, which authorized two orders to write it.
        for alias in ["./src/thermal/**", "/src/thermal/**", "src//thermal/**",
                      "src/bid/../thermal/**"] {
            assert!(
                paths_overlap("src/thermal/**", alias),
                "{alias} must overlap src/thermal/**"
            );
        }
        // And normalization must not invent overlaps between real siblings.
        assert!(!paths_overlap("src/thermal/**", "./src/bid/**"));
        assert!(!paths_overlap("/src/itc/**", "src/bid/**"));
    }

    #[test]
    fn the_record_names_the_cursor_it_was_dispatched_at() {
        let o = orders(&payload());
        let rec = record(&o["wo-042"], "sha256:deadbeefdeadbeef", "a@example.com", 3);
        assert_eq!(rec["event"], "dispatched");
        assert_eq!(rec["as_of"], "sha256:deadbeefdeadbeef");
        assert_eq!(rec["agents"], 3);
        // The packet is NOT copied into the log.
        assert!(rec.get("obligations").is_none());
    }

    // ── The ledger (#46) ────────────────────────────────────────────────────

    fn budgeted() -> Value {
        let mut p = payload();
        p["orders"][1]["order"]["budget"] = json!({"max_tokens": 1000, "max_probes": 0});
        p["orders"][1]["order"]["discipline"] = json!("https://x/corpus#d-market");
        p["orders"][3]["order"]["discipline"] = json!("https://x/corpus#d-market");
        p
    }

    #[test]
    fn spend_cannot_be_reported_against_a_thread_that_never_started() {
        let o = orders(&budgeted());
        let err = check_spend(&json!({"order_id": "wo-042", "tokens": 10}), &o, &Running::default())
            .unwrap_err();
        assert!(err.contains("never dispatched"), "{err}");
    }

    #[test]
    fn spend_cannot_be_reported_against_an_order_nobody_derived() {
        let o = orders(&budgeted());
        let r = running_with(&[json!({"order_id": "wo-042"})]);
        let err = check_spend(&json!({"order_id": "wo-999", "tokens": 10}), &o, &r).unwrap_err();
        assert!(err.contains("nobody derived"), "{err}");
    }

    #[test]
    fn spend_must_be_a_non_negative_integer() {
        let o = orders(&budgeted());
        let r = running_with(&[json!({"order_id": "wo-042"})]);
        assert!(check_spend(&json!({"order_id": "wo-042"}), &o, &r).is_err());
        assert!(check_spend(&json!({"order_id": "wo-042", "tokens": -1}), &o, &r)
            .unwrap_err()
            .contains("negative"));
    }

    #[test]
    fn reports_are_cumulative_snapshots_so_a_stale_one_does_not_refund() {
        let r = running_with(&[
            json!({"order_id": "wo-042"}),
            json!({"event": "spend", "order_id": "wo-042", "tokens": 800, "source": "run-7"}),
            // Arrives late, reports less. A refund would understate the account.
            json!({"event": "spend", "order_id": "wo-042", "tokens": 300, "source": "run-7-retry"}),
        ]);
        assert_eq!(r.spent("wo-042"), (800, "run-7"));
    }

    #[test]
    fn a_duplicate_report_is_idempotent() {
        let r = running_with(&[
            json!({"order_id": "wo-042"}),
            json!({"event": "spend", "order_id": "wo-042", "tokens": 500, "source": "run-7"}),
            json!({"event": "spend", "order_id": "wo-042", "tokens": 500, "source": "run-7"}),
        ]);
        assert_eq!(r.spent("wo-042").0, 500);
    }

    #[test]
    fn a_report_reaching_the_ceiling_exhausts_it() {
        let o = orders(&budgeted());
        let order = &o["wo-042"];
        assert_eq!(order.budget_tokens, 1000);
        let r = running_with(&[json!({"order_id": "wo-042"})]);
        let under = check_spend(&json!({"order_id": "wo-042", "tokens": 999}), &o, &r).unwrap();
        assert!(!under.exhausts(order));
        let at = check_spend(&json!({"order_id": "wo-042", "tokens": 1000}), &o, &r).unwrap();
        assert!(at.exhausts(order), "reaching the ceiling exhausts it");
        let over = check_spend(&json!({"order_id": "wo-042", "tokens": 5000}), &o, &r).unwrap();
        assert!(over.exhausts(order));
    }

    #[test]
    fn an_unbudgeted_order_is_never_exhausted_by_any_number() {
        let o = orders(&budgeted());
        // wo-046 has no budget set — 0 means nobody set a ceiling, which is not
        // the same as a ceiling of zero.
        assert_eq!(o["wo-046"].budget_tokens, 0);
        let r = running_with(&[json!({"order_id": "wo-046"})]);
        let s = check_spend(&json!({"order_id": "wo-046", "tokens": 10_000_000}), &o, &r).unwrap();
        assert!(!s.exhausts(&o["wo-046"]));
    }

    #[test]
    fn a_stop_frees_the_scope_and_names_its_cause() {
        let o = orders(&budgeted());
        let r = running_with(&[
            json!({"order_id": "wo-042", "agents": 3}),
            stop_record("wo-042", STOP_BUDGET_EXHAUSTED, 1000, "machine:ci"),
        ]);
        assert!(!r.is_running("wo-042"));
        assert_eq!(r.stop_cause("wo-042"), STOP_BUDGET_EXHAUSTED);
        // Its scope and paths are released — a stopped thread holds nothing.
        assert_eq!(check("wo-057", &o, &r).verdict, DISPATCHED);
        // But it is not re-dispatchable by accident: it is READY again only
        // because a stop is not a hold. That is deliberate — re-dispatching a
        // budget-exhausted order is a decision someone makes, and the ledger
        // shows them the spend it already carries.
        assert_eq!(state(&o["wo-042"], &r), STATE_READY);
    }

    #[test]
    fn the_ledger_reports_allocation_spend_and_fate() {
        let o = orders(&budgeted());
        let r = running_with(&[
            json!({"order_id": "wo-042", "agents": 3}),
            json!({"event": "spend", "order_id": "wo-042", "tokens": 400, "source": "fanout/run-7"}),
        ]);
        let rows = ledger(&o, &r);
        let row = rows.iter().find(|r| r["order_id"] == "wo-042").unwrap();
        assert_eq!(row["budget_tokens"], 1000);
        assert_eq!(row["spent_tokens"], 400);
        assert_eq!(row["remaining_tokens"], 600);
        assert_eq!(row["state"], STATE_RUNNING);
        assert_eq!(row["spend_source"], "fanout/run-7");
        assert_eq!(row["stop_cause"], "");
    }

    #[test]
    fn spend_survives_the_thread_that_spent_it() {
        // The ledger's question is "where did this week's tokens go", which a
        // view that forgets finished work answers only for work in flight.
        let o = orders(&budgeted());
        let r = running_with(&[
            json!({"order_id": "wo-042", "agents": 3}),
            json!({"event": "spend", "order_id": "wo-042", "tokens": 900, "source": "run-7"}),
            json!({"event": "closed", "order_id": "wo-042"}),
        ]);
        let rows = ledger(&o, &r);
        let row = rows.iter().find(|r| r["order_id"] == "wo-042").unwrap();
        assert_eq!(row["spent_tokens"], 900);
        assert_eq!(row["state"], STATE_READY);
    }

    #[test]
    fn an_unbudgeted_row_does_not_read_as_out_of_budget() {
        let o = orders(&budgeted());
        let r = running_with(&[
            json!({"order_id": "wo-046"}),
            json!({"event": "spend", "order_id": "wo-046", "tokens": 12_345, "source": "run-9"}),
        ]);
        let rows = ledger(&o, &r);
        let row = rows.iter().find(|r| r["order_id"] == "wo-046").unwrap();
        assert_eq!(row["budget_tokens"], 0, "no ceiling was set");
        assert_eq!(row["remaining_tokens"], 0);
        assert_eq!(row["spent_tokens"], 12_345);
        // The pair (budget 0, spent > 0) is what a reader distinguishes on;
        // remaining alone would read identically to an exhausted budget.
    }

    #[test]
    fn spend_rolls_up_per_discipline() {
        let o = orders(&budgeted());
        let r = running_with(&[
            json!({"order_id": "wo-042"}),
            json!({"event": "spend", "order_id": "wo-042", "tokens": 400, "source": "a"}),
            json!({"order_id": "wo-057"}),
            json!({"event": "spend", "order_id": "wo-057", "tokens": 100, "source": "b"}),
        ]);
        let rolled = ledger_by_discipline(&ledger(&o, &r));
        let market = rolled.iter().find(|r| r["discipline"] == "d-market").unwrap();
        assert_eq!(market["orders"], 2);
        assert_eq!(market["spent_tokens"], 500);
        assert_eq!(market["budget_tokens"], 1000);
        // Sorted by spend, so the biggest line item is first.
        assert_eq!(rolled[0]["discipline"], "d-market");
    }
}
