//! Evaluations: how many records a check actually examined.
//!
//! ## Why this is not a proposal
//!
//! A proposal is a person's judgement — what a word means, what a requirement
//! should say. An evaluation is a MEASUREMENT: a project ran a query in its own
//! environment and reported a count. Nobody is asked to agree with it, and
//! `au:promotedBy` would be a category error. So it gets its own append-only log
//! rather than riding the op vocabulary.
//!
//! What travels is the count, the query fingerprint, and the outcome. Never
//! rows: spec has no data access to any project and must not acquire one by the
//! back door of "just a few examples".
//!
//! ## The door refuses a vacuous pass
//!
//! `//rdf/lint/authoring:vacuous-invariant.rq` fails a corpus where an
//! evaluation examined zero records and reports `Passes` or `Fails`. That gate
//! stays — it protects the corpus against anything that writes TTL directly.
//! But an evaluation that reaches this module gets refused BEFORE it is
//! recorded, because the alternative is knowingly appending a defect to an
//! append-only log and relying on a later gate to notice.
//!
//! Zero is an exception, never a result. `au:Vacuous` is the honest recording
//! of "it ran and examined nothing"; `au:CannotBeGrounded` is "it could not run
//! at all". Both legitimately carry a population of zero. Neither is a pass.
//!
//! ## A machine reports, never judges
//!
//! A machine principal — `author` prefixed `machine:`, which only the console's
//! evaluation route mints from a credential (RFC-004a §4) — may report
//! `Examined`, `Vacuous` or `CannotBeGrounded`, and may not report `Passes` or
//! `Fails`. A count says how many records a check would examine; whether the
//! claim holds over them is a judgment, and a `SELECT count(*)` did not make one.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Map, Value};

/// `au:Outcome` — what an evaluation may report.
///
/// ⛔ There is no `Unknown`. An evaluation that cannot say what happened is not
/// an evaluation, and such a bucket would immediately become where anything
/// awkward went.
///
/// ⚠ `Examined` is NOT that bucket, and the distinction is the whole reason it
/// exists. The grounding adapter measures a POPULATION and deliberately refuses
/// to decide the predicate — it returns CANNOT_BE_GROUNDED / VACUOUS /
/// EVALUABLE and never PASSES, because reporting a pass is only meaningful once
/// the predicate itself is evaluated, which nothing yet does. `Examined` records
/// exactly what was learned: this check would look at N records, and nobody has
/// yet decided whether it holds over them.
///
/// Collapsing `Examined` into `Passes` is the exact failure this pipeline is
/// about, committed at the last step. So it is a distinct outcome, and nothing
/// counts it as a pass.
pub const OUTCOMES: &[&str] = &["Passes", "Fails", "Examined", "Vacuous", "CannotBeGrounded"];

/// Outcomes that assert records were examined. A population of zero makes every
/// one of them meaningless — including `Examined`, whose whole content is "there
/// were records to look at".
const POSITIVE: &[&str] = &["Passes", "Fails", "Examined"];

/// Outcomes that are a JUDGMENT rather than a measurement. A machine principal
/// (`author` prefixed `MACHINE_PREFIX`, RFC-004a §4) may report `Examined`,
/// `Vacuous` or `CannotBeGrounded` and may not report either of these: a count
/// says how many records a check would examine, and whether the claim holds
/// over them is a question the machine did not answer. `Examined` is
/// deliberately NOT here — it is the one outcome a machine exists to report.
///
/// ⚠ Asserted against the TypeScript constant and the fixtures by
/// `conformance/check_conformance.py`, like OUTCOMES and POSITIVE.
pub const JUDGMENTS: &[&str] = &["Passes", "Fails"];

/// The author prefix that marks a machine principal (RFC-004a §4). Keying the
/// rule on the string is keying it on the credential, the same way agent
/// capability is keyed on the `agent:` sub prefix.
pub const MACHINE_PREFIX: &str = "machine:";

#[derive(Debug, Clone)]
pub struct Evaluation {
    pub claim: String,
    pub project: String,
    pub implementation: String,
    pub outcome: String,
    pub population: Option<i64>,
    pub fingerprint: String,
    pub author: String,
    pub detail: String,
}

/// Validate a submitted evaluation. `Err` is the message shown to the caller.
pub fn check(body: &Value, author: &str) -> Result<Evaluation, String> {
    let obj = body.as_object().ok_or("body is not a JSON object")?;
    let s = |k: &str| -> String {
        obj.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string()
    };

    let claim = s("claim");
    if claim.is_empty() {
        return Err("`claim` is required — an evaluation of nothing is not a measurement".into());
    }
    let implementation = s("implementation");
    if implementation.is_empty() {
        return Err(
            "`implementation` is required — the same claim can pass in one product and be \
             ungroundable in another, and an unattributed count cannot tell you which"
                .into(),
        );
    }
    let outcome = s("outcome");
    if !OUTCOMES.contains(&outcome.as_str()) {
        return Err(format!("`{outcome}` is not an au:Outcome (expected one of {OUTCOMES:?})"));
    }

    // ⛔ A machine reports, never judges. Before the population rules, so a
    // machine's `Examined` over zero still hears "Vacuous": this rule adds a
    // refusal and removes none.
    if author.starts_with(MACHINE_PREFIX) && JUDGMENTS.contains(&outcome.as_str()) {
        return Err(format!(
            "`{outcome}` is a judgment, and a machine reports what it measured — record Examined \
             with the population and let a person decide whether the claim holds"
        ));
    }

    let population = match obj.get("population") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_i64()
                .ok_or("`population` must be an integer count of records examined")?,
        ),
    };

    // ⛔ The two refusals this module exists for.
    if population.is_none() && POSITIVE.contains(&outcome.as_str()) {
        return Err(format!(
            "`{outcome}` without a population is a result nobody can audit — say how many \
             records were examined, or report CannotBeGrounded"
        ));
    }
    if population == Some(0) && POSITIVE.contains(&outcome.as_str()) {
        return Err(format!(
            "examined 0 records but reports {outcome}. An invariant that examined nothing \
             succeeds trivially; record it as Vacuous, which is what it is"
        ));
    }
    if population.map(|n| n < 0).unwrap_or(false) {
        return Err("`population` cannot be negative".into());
    }

    Ok(Evaluation {
        claim,
        project: s("project"),
        implementation,
        outcome,
        population,
        fingerprint: s("query_fingerprint"),
        author: author.to_string(),
        detail: s("detail"),
    })
}

impl Evaluation {
    pub fn record(&self) -> Value {
        json!({
            "claim": self.claim,
            "project": self.project,
            "implementation": self.implementation,
            "outcome": self.outcome,
            "population": self.population,
            "query_fingerprint": self.fingerprint,
            "author": self.author,
            "detail": self.detail,
        })
    }
}

/// The latest evaluation per (claim, implementation), replayed from the log.
#[derive(Debug, Default)]
pub struct Evaluated {
    pub by_claim: HashMap<(String, String), Value>,
    pub records: usize,
}

impl Evaluated {
    /// A malformed line is skipped rather than fatal — same reason as the
    /// proposal log: one bad record must not hide the good ones after it.
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
            let Some(o) = rec.as_object() else { continue };
            let claim = o.get("claim").and_then(Value::as_str).unwrap_or("").to_string();
            let imp = o
                .get("implementation")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if claim.is_empty() {
                continue;
            }
            out.records += 1;
            // Later wins: re-running a check is how drift is detected, and the
            // current answer is the recent one.
            out.by_claim.insert((claim, imp), rec);
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.by_claim.is_empty()
    }

    /// Overlay onto the `requirements` payload.
    ///
    /// ⚠ Only rows whose `population` is still the never-evaluated placeholder
    /// are filled. A corpus that already carries an adopted evaluation wins, for
    /// the same reason pending bindings defer to adopted ones: the log keeps
    /// every record forever, and letting it overwrite the corpus would make the
    /// two disagree with the log always winning.
    pub fn apply(&self, rows: &mut [Value]) {
        for row in rows.iter_mut() {
            let Some(o) = row.as_object_mut() else { continue };
            let id = o.get("requirement_id").and_then(Value::as_str).unwrap_or("").to_string();
            let candidates: Vec<&Value> = self
                .by_claim
                .iter()
                .filter(|((c, _), _)| *c == id)
                .map(|(_, v)| v)
                .collect();
            let Some(ev) = candidates.first() else { continue };

            let adopted = o.get("population").and_then(Value::as_str).unwrap_or("—") != "—";
            let pop = ev.get("population").and_then(Value::as_i64);
            o.insert(
                "population".into(),
                json!(pop.map(|n| n.to_string()).unwrap_or_else(|| "—".into())),
            );
            o.insert(
                "outcome".into(),
                ev.get("outcome").cloned().unwrap_or(json!("NOT-EVALUATED")),
            );
            o.insert(
                "implementation".into(),
                ev.get("implementation").cloned().unwrap_or(json!("")),
            );
            if !adopted {
                o.insert("evaluation_pending".into(), json!(true));
                o.insert(
                    "evaluated_by".into(),
                    ev.get("author").cloned().unwrap_or(json!("")),
                );
            }
        }
    }

    pub fn to_rows(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self.by_claim.values().cloned().collect();
        out.sort_by_key(|v| {
            v.get("claim").and_then(Value::as_str).unwrap_or("").to_string()
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(outcome: &str, population: Option<i64>) -> Value {
        let mut m = Map::new();
        m.insert("claim".into(), json!("auth-24"));
        m.insert("implementation".into(), json!("studio-nextjs"));
        m.insert("outcome".into(), json!(outcome));
        if let Some(n) = population {
            m.insert("population".into(), json!(n));
        }
        Value::Object(m)
    }

    /// ⛔ The SHARED cases — `conformance/evaluation_cases.json` — executed here so
    /// this door and the console's TypeScript one cannot drift. Two
    /// implementations of a safety rule diverge silently: each keeps passing its
    /// own suite while they come apart, and the suites are all anybody looks at.
    ///
    /// Resolved relative to the crate dir with the same `option_env!` + exists()
    /// guard as `readmodel::tests::the_committed_payloads_carry_their_rows_field`:
    /// the fixtures are source files, not runfiles, so under `cargo test` they are
    /// right there and under a bazel `rust_test` they are not staged.
    ///
    /// ⚠ Which is exactly why the hand-written cases below are NOT deleted. They
    /// are what runs under Bazel, and they exercise the control flow this one
    /// would silently skip.
    #[test]
    fn the_shared_conformance_cases_all_hold() {
        let Some(dir) = option_env!("CARGO_MANIFEST_DIR") else {
            return;
        };
        let path = std::path::PathBuf::from(dir).join("../../conformance/evaluation_cases.json");
        if !path.is_file() {
            return;
        }
        let raw = std::fs::read_to_string(&path).expect("read evaluation_cases.json");
        let doc: Value = serde_json::from_str(&raw).expect("parse evaluation_cases.json");

        // The fixtures name the vocabulary too, so a change to either constant
        // that the other does not follow fails here rather than in a browser.
        let listed = |key: &str| -> Vec<String> {
            match doc[key].as_array() {
                Some(a) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                None => Vec::new(),
            }
        };
        assert_eq!(listed("outcomes"), OUTCOMES, "fixtures and OUTCOMES disagree");
        assert_eq!(
            listed("positive_outcomes"),
            POSITIVE,
            "fixtures and POSITIVE disagree"
        );
        assert_eq!(listed("judgments"), JUDGMENTS, "fixtures and JUDGMENTS disagree");
        assert_eq!(
            doc["machine_author_prefix"].as_str(),
            Some(MACHINE_PREFIX),
            "fixtures and MACHINE_PREFIX disagree"
        );

        let cases = doc["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 10, "suspiciously few cases: {}", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let author = c["author"].as_str().unwrap_or("");
            let got = check(&c["body"], author);
            match c["expect"].as_str() {
                Some("accepted") => {
                    let ok = got.unwrap_or_else(|e| {
                        panic!("{name}: expected accepted, refused with {e}")
                    });
                    if let Some(n) = c
                        .get("normalized")
                        .and_then(|n| n.get("population"))
                        .and_then(Value::as_i64)
                    {
                        assert_eq!(ok.population, Some(n), "{name}: population");
                    }
                }
                Some("refused") => {
                    let err = got
                        .err()
                        .unwrap_or_else(|| panic!("{name}: expected refused, was accepted"));
                    if let Some(sub) = c.get("message_contains").and_then(Value::as_str) {
                        assert!(
                            err.contains(sub),
                            "{name}: message {err:?} does not mention {sub:?}"
                        );
                    }
                }
                other => panic!("{name}: `expect` is {other:?}, not accepted|refused"),
            }
        }
    }

    /// ⛔ Both directions. The refusal is the point of this module, and a check
    /// only ever shown to accept is an assertion.
    #[test]
    fn a_pass_over_zero_records_is_refused_and_a_real_one_is_not() {
        let vacuous_pass = check(&body("Passes", Some(0)), "a@b.c");
        assert!(vacuous_pass.is_err(), "0 records + Passes must be refused");
        assert!(
            vacuous_pass.unwrap_err().contains("Vacuous"),
            "and must say what to record instead"
        );

        // ⛔ Examined over zero is the same lie in a quieter voice.
        assert!(check(&body("Examined", Some(0)), "a@b.c").is_err());

        // The same zero, honestly labelled, is fine.
        assert!(check(&body("Vacuous", Some(0)), "a@b.c").is_ok());
        // So is a check that could not run at all.
        assert!(check(&body("CannotBeGrounded", Some(0)), "a@b.c").is_ok());
        // And a real result over real records.
        let ok = check(&body("Passes", Some(88)), "a@b.c").expect("88 records is a result");
        assert_eq!(ok.population, Some(88));
    }

    /// A missing count is not a zero count — it is a result nobody can audit,
    /// and it would slip past the zero check precisely because there is nothing
    /// to compare.
    #[test]
    fn a_result_with_no_population_at_all_is_refused() {
        assert!(check(&body("Passes", None), "a@b.c").is_err());
        assert!(check(&body("Fails", None), "a@b.c").is_err());
        // CannotBeGrounded may legitimately have no count: nothing ran.
        assert!(check(&body("CannotBeGrounded", None), "a@b.c").is_ok());
    }

    #[test]
    fn an_unattributed_or_unknown_outcome_is_refused() {
        let mut b = body("Passes", Some(5));
        b.as_object_mut().unwrap().remove("implementation");
        assert!(check(&b, "a@b.c").is_err(), "implementation is required");

        assert!(check(&body("Probably", Some(5)), "a@b.c").is_err(), "not an au:Outcome");
    }

    /// ⛔ A machine reports, never judges — both directions, hand-written so it
    /// runs under Bazel where the shared fixture is not staged.
    #[test]
    fn a_machine_may_report_what_it_examined_and_may_not_judge() {
        let machine = "machine:studio-nextjs";
        assert!(check(&body("Passes", Some(88)), machine).is_err(), "a pass is a judgment");
        assert!(check(&body("Fails", Some(88)), machine).is_err(), "so is a failure");
        let ok = check(&body("Examined", Some(1412)), machine).expect("a count is a measurement");
        assert_eq!(ok.population, Some(1412));
        assert!(check(&body("Vacuous", Some(0)), machine).is_ok());
        assert!(check(&body("CannotBeGrounded", None), machine).is_ok());
        // The rule adds a refusal and removes none: Examined over zero is the
        // same lie whoever tells it.
        assert!(check(&body("Examined", Some(0)), machine).is_err());
        // And a person may still judge.
        assert!(check(&body("Passes", Some(88)), "a@b.c").is_ok());
    }
}
