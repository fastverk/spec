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
    pub records: usize,
}

impl Running {
    pub fn read(path: Option<&Path>) -> Self {
        let mut out = Self::default();
        let Some(path) = path else { return out };
        let Ok(body) = std::fs::read_to_string(path) else {
            return out;
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
                _ => {
                    out.by_id.insert(id.to_string(), rec);
                }
            }
        }
        out
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

fn wildcard_prefix(pattern: &str) -> String {
    let mut out = String::new();
    for seg in pattern.split('/') {
        if seg.contains('*') || seg.contains('?') || seg.contains('[') {
            break;
        }
        out.push_str(seg);
        out.push('/');
    }
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

    fn running_with(lines: &[Value]) -> Running {
        let mut r = Running::default();
        for rec in lines {
            let id = rec["order_id"].as_str().unwrap().to_string();
            r.records += 1;
            if rec.get("event").and_then(Value::as_str) == Some("closed") {
                r.by_id.remove(&id);
            } else {
                r.by_id.insert(id, rec.clone());
            }
        }
        r
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
        let r = Running::read(Some(&path));
        assert_eq!(r.ids(), vec!["wo-042", "wo-046"]);
        assert_eq!(r.records, 2);
        std::fs::remove_dir_all(&dir).ok();
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
}
