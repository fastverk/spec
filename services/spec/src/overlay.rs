//! Pending proposals, applied over the read model.
//!
//! ## Why this exists
//!
//! The write path was complete and had no consumer. `POST /proposal/op` checked
//! an op, appended it to an append-only log, and returned a byte offset — and
//! nothing ever read that log back. Every write therefore had NO observable
//! effect: a person could bind a term, get a 202, and watch the screen report
//! the term as unbound forever. A write path whose result is invisible is
//! indistinguishable from one that does not work, and it teaches people that
//! the buttons are decorative.
//!
//! ## The distinction this module is careful to keep
//!
//! A proposal is **not** the corpus. The corpus is the TTL the gates run over;
//! promoting a proposal into it is a deliberate act (`tools/proposals/
//! materialize.py`), reviewable like a merge.
//!
//! So everything here is marked `pending: true` and rendered as *proposed*, not
//! as fact. That is both the honest reading and the more useful one: the person
//! who bound a term needs to see that their answer was recorded AND that it has
//! not yet been adopted. Silently folding pending state into the corpus numbers
//! would make "46 terms pinned down" mean two different things depending on who
//! was looking.
//!
//! ⚠ The log is the record; this is a projection of it. It is rebuilt on read
//! (cheap — the log is one small JSONL) rather than cached, so a write is
//! visible on the very next request without an invalidation protocol to get
//! wrong.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{json, Map, Value};

/// One amendment to an existing claim.
#[derive(Debug, Default, Clone)]
pub struct Amend {
    pub text: Option<String>,
    pub discipline: Option<String>,
    pub modality: Option<String>,
    pub author: String,
}

/// Everything the log says has been proposed but not yet adopted.
#[derive(Debug, Default)]
pub struct Pending {
    /// bindTerm: (project, surface) → the reading chosen.
    pub bound: HashMap<(String, String), (String, String)>,
    /// alignTerm: (project, surface) → the surface it is the same thing as.
    pub aligned: HashMap<(String, String), (String, String)>,
    /// retractTerm: surfaces the author says are not terms at all.
    pub retracted_terms: HashMap<(String, String), (String, String)>,
    /// amendNS: claim id → the new wording/placement.
    pub amended: HashMap<String, Amend>,
    /// retractNS: claim ids withdrawn.
    pub retracted_ns: HashMap<String, String>,
    /// assertNS: claims that do not exist in the corpus yet.
    pub asserted: Vec<Value>,
    /// How many log records were read, for the UI to show a count.
    pub records: usize,
}

fn s(op: &Map<String, Value>, k: &str) -> String {
    op.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

/// A term op's scope. Ops carry `project` optionally; without it the binding
/// applies to every project that uses the surface.
///
/// ⚠ That fallback is a real ambiguity, not a convenience: `public` is a term in
/// more than one corpus and they need not mean the same thing. The portal always
/// sends `project`; the empty key exists so a hand-written op still does
/// something rather than silently nothing.
fn scope(op: &Map<String, Value>, key: &str) -> (String, String) {
    (s(op, "project"), s(op, key))
}

impl Pending {
    /// Read the whole log. A malformed line is SKIPPED, not fatal: the log is
    /// append-only and one bad record must not blind the reader to the good ones
    /// written after it.
    pub fn read(path: Option<&Path>) -> Self {
        let mut p = Self::default();
        let Some(path) = path else { return p };
        let Ok(body) = std::fs::read_to_string(path) else {
            return p;
        };

        for line in body.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(rec) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let author = rec
                .get("author_email")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| rec.get("author").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();

            // `canonical` is the canonical JSON of the proposal body, as a string.
            let Some(canon) = rec.get("canonical").and_then(Value::as_str) else {
                continue;
            };
            let Ok(body) = serde_json::from_str::<Value>(canon) else {
                continue;
            };
            let Some(ops) = body.get("ops").and_then(Value::as_array) else {
                continue;
            };
            p.records += 1;

            for op in ops.iter().filter_map(Value::as_object) {
                // Later records win: the log is ordered, and a person who binds a
                // term twice means the second one.
                match op.get("op").and_then(Value::as_str).unwrap_or("") {
                    "bindTerm" => {
                        p.bound.insert(scope(op, "term"), (s(op, "definition"), author.clone()));
                    }
                    "alignTerm" => {
                        p.aligned.insert(scope(op, "term"), (s(op, "aligns_to"), author.clone()));
                    }
                    "retractTerm" => {
                        p.retracted_terms
                            .insert(scope(op, "term"), (s(op, "reason"), author.clone()));
                    }
                    "amendNS" => {
                        let e = p.amended.entry(s(op, "subject")).or_default();
                        let set = |cur: &mut Option<String>, v: String| {
                            if !v.is_empty() {
                                *cur = Some(v);
                            }
                        };
                        set(&mut e.text, s(op, "text"));
                        set(&mut e.discipline, s(op, "discipline"));
                        set(&mut e.modality, s(op, "modality"));
                        e.author = author.clone();
                    }
                    "retractNS" => {
                        p.retracted_ns.insert(s(op, "subject"), author.clone());
                    }
                    "assertNS" => {
                        p.asserted.push(json!({
                            "requirement_id": s(op, "subject"),
                            "predicate": s(op, "text"),
                            "discipline": s(op, "discipline"),
                            "modality": if s(op, "modality").is_empty() { "MUST".into() } else { s(op, "modality") },
                            "project": s(op, "project"),
                            "rung": s(op, "rung"),
                            "author": author.clone(),
                        }));
                    }
                    _ => {}
                }
            }
        }
        p
    }

    pub fn is_empty(&self) -> bool {
        self.bound.is_empty()
            && self.aligned.is_empty()
            && self.retracted_terms.is_empty()
            && self.amended.is_empty()
            && self.retracted_ns.is_empty()
            && self.asserted.is_empty()
    }

    /// Look a term op up by exact (project, surface), then by surface alone.
    fn find<'a, T>(m: &'a HashMap<(String, String), T>, project: &str, surface: &str) -> Option<&'a T> {
        m.get(&(project.to_string(), surface.to_string()))
            .or_else(|| m.get(&(String::new(), surface.to_string())))
    }

    /// Apply to the `terms` payload.
    pub fn apply_terms(&self, rows: &mut Vec<Value>) {
        for row in rows.iter_mut() {
            let Some(o) = row.as_object_mut() else { continue };
            let project = o.get("project").and_then(Value::as_str).unwrap_or("").to_string();
            let surface = o.get("surface").and_then(Value::as_str).unwrap_or("").to_string();

            if let Some((def, who)) = Self::find(&self.bound, &project, &surface) {
                // ⛔ PENDING MEANS "differs from the corpus", not "is in the log".
                // The log is append-only, so a proposal stays in it forever —
                // including after it has been promoted into the TTL. Marking on
                // presence alone would leave every adopted decision reading
                // "proposed, not yet adopted" for the rest of time, and the one
                // badge that tells people whether their answer landed would
                // become permanently meaningless.
                let already =
                    o.get("bound_to").and_then(Value::as_str).unwrap_or("").to_string();
                o.insert("bound_to".into(), json!(def));
                o.insert("open".into(), json!(false));
                if already != *def {
                    o.insert("pending".into(), json!(true));
                    o.insert("pending_by".into(), json!(who));
                }
            }
            if let Some((to, who)) = Self::find(&self.aligned, &project, &surface) {
                o.insert("aligns_to".into(), json!(to));
                o.insert("pending".into(), json!(true));
                o.insert("pending_by".into(), json!(who));
            }
            if let Some((why, who)) = Self::find(&self.retracted_terms, &project, &surface) {
                o.insert("retracted".into(), json!(true));
                o.insert("retracted_reason".into(), json!(why));
                o.insert("pending".into(), json!(true));
                o.insert("pending_by".into(), json!(who));
            }
        }
    }

    /// Apply to the `requirements` payload.
    pub fn apply_requirements(&self, rows: &mut Vec<Value>) {
        let known: HashSet<String> = rows
            .iter()
            .filter_map(|r| r.get("requirement_id").and_then(Value::as_str))
            .map(str::to_string)
            .collect();

        for row in rows.iter_mut() {
            let Some(o) = row.as_object_mut() else { continue };
            let id = o.get("requirement_id").and_then(Value::as_str).unwrap_or("").to_string();

            if let Some(a) = self.amended.get(&id) {
                // Same rule as bindTerm: pending is a DIFFERENCE from the corpus.
                // Scoped so the immutable borrows end before the inserts below.
                let changed = {
                    let differs = |key: &str, v: &Option<String>| match v {
                        Some(v) => o.get(key).and_then(Value::as_str).unwrap_or("") != v.as_str(),
                        None => false,
                    };
                    differs("predicate", &a.text)
                        || differs("discipline", &a.discipline)
                        || differs("modality", &a.modality)
                };
                if let Some(t) = &a.text {
                    o.insert("predicate".into(), json!(t));
                }
                if let Some(d) = &a.discipline {
                    o.insert("discipline".into(), json!(d));
                }
                if let Some(m) = &a.modality {
                    o.insert("modality".into(), json!(m));
                }
                if changed {
                    o.insert("pending".into(), json!(true));
                    o.insert("pending_by".into(), json!(a.author));
                }
            }
            if let Some(who) = self.retracted_ns.get(&id) {
                o.insert("retracted".into(), json!(true));
                o.insert("pending".into(), json!(true));
                o.insert("pending_by".into(), json!(who));
            }
        }

        // A claim asserted twice, or asserted over an id the corpus already has,
        // must not double the list. The corpus wins: an assertNS colliding with a
        // real id is an authoring mistake worth seeing rather than silently
        // shadowing the original.
        let mut seen = known;
        for a in &self.asserted {
            let id = a.get("requirement_id").and_then(Value::as_str).unwrap_or("").to_string();
            if id.is_empty() || !seen.insert(id) {
                continue;
            }
            let mut row = a.clone();
            if let Some(o) = row.as_object_mut() {
                o.insert("pending".into(), json!(true));
                o.insert("pending_by".into(), json!(o.get("author").cloned().unwrap_or(json!(""))));
                o.insert("population".into(), json!("—"));
                o.insert("outcome".into(), json!("NOT-EVALUATED"));
                o.insert("implementation".into(), json!(""));
                o.insert("blocked_on".into(), json!("not-decomposed: newly written, nothing has broken it into terms yet"));
            }
            rows.push(row);
        }
    }

    /// The proposal set as its own payload, each row marked `adopted` or not.
    ///
    /// ⛔ Adoption is computed against the CORPUS, never assumed from the log.
    /// The log is append-only, so a proposal is in it forever; a pane that
    /// counted rows would report "2 waiting to be adopted" for work that landed
    /// an hour ago and would never go down. Same rule as `apply_terms`: waiting
    /// means *differs from the corpus*.
    pub fn to_rows(&self, corpus_terms: &[Value], corpus_reqs: &[Value]) -> Vec<Value> {
        let field = |rows: &[Value], id_key: &str, id: &str, key: &str| -> String {
            rows.iter()
                .find(|r| r.get(id_key).and_then(Value::as_str) == Some(id))
                .and_then(|r| r.get(key))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let term_bound = |surface: &str| field(corpus_terms, "surface", surface, "bound_to");
        let claim_text = |id: &str| field(corpus_reqs, "requirement_id", id, "predicate");
        let claim_exists = |id: &str| {
            corpus_reqs
                .iter()
                .any(|r| r.get("requirement_id").and_then(Value::as_str) == Some(id))
        };
        let mut out = Vec::new();
        let term_row = |kind: &str, k: &(String, String), v: &(String, String), adopted: bool| {
            json!({
                "kind": kind,
                "project": k.0,
                "subject": k.1,
                "detail": v.0,
                "author": v.1,
                "adopted": adopted,
            })
        };
        for (k, v) in &self.bound {
            let adopted = term_bound(&k.1) == v.0;
            out.push(term_row("bindTerm", k, v, adopted));
        }
        for (k, v) in &self.aligned {
            // The corpus carries alignment as a triple the read model does not
            // project, so this cannot be confirmed here yet and says so by
            // staying unadopted rather than guessing.
            out.push(term_row("alignTerm", k, v, false));
        }
        for (k, v) in &self.retracted_terms {
            let adopted = corpus_terms.iter().any(|r| {
                r.get("surface").and_then(Value::as_str) == Some(k.1.as_str())
                    && r.get("retired").and_then(Value::as_bool) == Some(true)
            });
            out.push(term_row("retractTerm", k, v, adopted));
        }
        for (id, a) in &self.amended {
            let text = a.text.clone().unwrap_or_default();
            let adopted = !text.is_empty() && claim_text(id) == text;
            out.push(json!({
                "kind": "amendNS", "project": "", "subject": id,
                "detail": text, "author": a.author, "adopted": adopted,
            }));
        }
        for (id, who) in &self.retracted_ns {
            out.push(json!({
                "kind": "retractNS", "project": "", "subject": id, "detail": "",
                "author": who, "adopted": false,
            }));
        }
        for a in &self.asserted {
            let id = a.get("requirement_id").and_then(Value::as_str).unwrap_or("");
            out.push(json!({
                "kind": "assertNS",
                "project": a.get("project").cloned().unwrap_or(json!("")),
                "subject": id,
                "detail": a.get("predicate").cloned().unwrap_or(json!("")),
                "author": a.get("author").cloned().unwrap_or(json!("")),
                "adopted": claim_exists(id),
            }));
        }
        out.sort_by(|a, b| {
            let key = |v: &Value| {
                format!(
                    "{}{}",
                    v.get("kind").and_then(Value::as_str).unwrap_or(""),
                    v.get("subject").and_then(Value::as_str).unwrap_or("")
                )
            };
            key(a).cmp(&key(b))
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_line(ops: Value) -> String {
        let canonical = serde_json::to_string(&json!({
            "parent": "p0", "surface": "Meridian", "ops": ops
        }))
        .unwrap();
        serde_json::to_string(&json!({
            "parent": "p0", "author": "u-1", "author_email": "a@b.c",
            "surface": "Meridian", "canonical": canonical,
        }))
        .unwrap()
    }

    /// ⛔ `name` must be unique per test. This helper keyed the directory on
    /// `lines.len()`, so two tests with one log line each wrote the SAME file and
    /// raced — `#[test]`s share one process. The failure looked like the
    /// project-scoping logic was broken.
    fn pending_from(name: &str, lines: &[String]) -> Pending {
        let dir = std::env::temp_dir().join(format!("spec-overlay-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log.jsonl");
        std::fs::write(&path, lines.join("\n")).unwrap();
        Pending::read(Some(&path))
    }

    /// ⛔ The SHARED cases — `conformance/overlay_cases.json` — executed here so
    /// this overlay and the console's TypeScript one cannot drift on the one rule
    /// most likely to be lost in a port: **pending means DIFFERS FROM THE CORPUS,
    /// never "is in the log"**. The log is append-only, so badging on presence
    /// would leave every adopted decision reading "not yet adopted" forever.
    ///
    /// Same `option_env!` guard as the evaluation suite, for the same reason, and
    /// the hand-written cases below stay for the same reason: they are what runs
    /// under Bazel, where the fixtures are not staged.
    #[test]
    fn the_shared_conformance_cases_all_hold() {
        let Some(dir) = option_env!("CARGO_MANIFEST_DIR") else {
            return;
        };
        let path = std::path::PathBuf::from(dir).join("../../conformance/overlay_cases.json");
        if !path.is_file() {
            return;
        }
        let raw = std::fs::read_to_string(&path).expect("read overlay_cases.json");
        let doc: Value = serde_json::from_str(&raw).expect("parse overlay_cases.json");
        let cases = doc["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 8, "suspiciously few cases: {}", cases.len());

        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");

            // A `malformed` entry goes to the log verbatim: one bad record must
            // not hide the good ones after it.
            let mut lines: Vec<String> = Vec::new();
            for entry in c["log"].as_array().expect("log array") {
                match entry.get("malformed").and_then(Value::as_str) {
                    Some(raw) => lines.push(raw.to_string()),
                    None => lines.push(log_line(entry["ops"].clone())),
                }
            }
            let p = pending_from(name, &lines);

            if let Some(n) = c["expect"].get("records").and_then(Value::as_u64) {
                assert_eq!(p.records as u64, n, "{name}: records");
            }

            let corpus = |k: &str| -> Vec<Value> {
                match c["corpus"].get(k).and_then(Value::as_array) {
                    Some(a) => a.clone(),
                    None => Vec::new(),
                }
            };

            let rows: Vec<Value> = match c["apply"].as_str() {
                Some("terms") => {
                    let mut r = corpus("terms");
                    p.apply_terms(&mut r);
                    r
                }
                Some("requirements") => {
                    let mut r = corpus("requirements");
                    p.apply_requirements(&mut r);
                    r
                }
                Some("proposals") => p.to_rows(&corpus("terms"), &corpus("requirements")),
                other => panic!("{name}: `apply` is {other:?}"),
            };

            if let Some(n) = c["expect"].get("row_count").and_then(Value::as_u64) {
                assert_eq!(rows.len() as u64, n, "{name}: row_count, got {rows:?}");
            }

            for want in c["expect"]["rows"].as_array().expect("expect.rows") {
                let sel = want["where"].as_object().expect("where object");
                let row = rows
                    .iter()
                    .find(|r| sel.iter().all(|(k, v)| r.get(k.as_str()) == Some(v)))
                    .unwrap_or_else(|| panic!("{name}: no row matching {sel:?} in {rows:?}"));
                if let Some(fields) = want.get("fields").and_then(Value::as_object) {
                    for (k, v) in fields {
                        assert_eq!(row.get(k.as_str()), Some(v), "{name}: field `{k}` in {row:?}");
                    }
                }
                // Absence, not `== false`: the overlay inserts no key at all when
                // a proposal matches the corpus, and that is the assertion.
                if let Some(absent) = want.get("absent").and_then(Value::as_array) {
                    for k in absent {
                        let k = k.as_str().unwrap_or("");
                        assert!(
                            row.get(k).is_none(),
                            "{name}: `{k}` must be absent — it matches the corpus, so it is not pending: {row:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_bound_term_stops_reading_as_open() {
        let p = pending_from("bind", &[log_line(json!([
            { "op": "bindTerm", "term": "deploy:*", "definition": "team_memberships.role='deployer'", "project": "studio" }
        ]))]);
        let mut rows = vec![json!({ "project": "studio", "surface": "deploy:*", "open": true })];
        p.apply_terms(&mut rows);
        assert_eq!(rows[0]["open"], json!(false));
        assert_eq!(rows[0]["pending"], json!(true), "and it must say it is only PROPOSED");
        assert_eq!(rows[0]["bound_to"], json!("team_memberships.role='deployer'"));
    }

    /// ⛔ A term bound in one project must not silently bind in another. `public`
    /// is a term in more than one corpus and they need not mean the same thing.
    #[test]
    fn a_binding_does_not_leak_across_projects() {
        let p = pending_from("scope", &[log_line(json!([
            { "op": "bindTerm", "term": "public", "definition": "x", "project": "studio" }
        ]))]);
        let mut rows = vec![
            json!({ "project": "studio", "surface": "public", "open": true }),
            json!({ "project": "ampere", "surface": "public", "open": true }),
        ];
        p.apply_terms(&mut rows);
        assert_eq!(rows[0]["open"], json!(false));
        assert_eq!(rows[1]["open"], json!(true), "the other project must be untouched");
    }

    #[test]
    fn the_last_write_wins_and_amendments_reach_the_row() {
        let p = pending_from("amend", &[
            log_line(json!([{ "op": "amendNS", "subject": "auth-24", "text": "first" }])),
            log_line(json!([{ "op": "amendNS", "subject": "auth-24", "text": "second" }])),
        ]);
        let mut rows = vec![json!({ "requirement_id": "auth-24", "predicate": "original" })];
        p.apply_requirements(&mut rows);
        assert_eq!(rows[0]["predicate"], json!("second"));
        assert_eq!(rows[0]["pending"], json!(true));
    }

    /// An assertNS over an id the corpus already has must not shadow it.
    #[test]
    fn an_asserted_claim_never_duplicates_an_existing_id() {
        let p = pending_from("assert", &[log_line(json!([
            { "op": "assertNS", "subject": "auth-24", "text": "shadow", "discipline": "d", "rung": "R0" },
            { "op": "assertNS", "subject": "auth-99", "text": "brand new", "discipline": "d", "rung": "R0" }
        ]))]);
        let mut rows = vec![json!({ "requirement_id": "auth-24", "predicate": "original" })];
        p.apply_requirements(&mut rows);
        assert_eq!(rows.len(), 2, "one new row, and no shadow of auth-24");
        assert_eq!(rows[0]["predicate"], json!("original"));
        assert_eq!(rows[1]["requirement_id"], json!("auth-99"));
    }

    /// ⛔ Once a proposal is promoted into the corpus it must stop reading as
    /// pending. The log keeps it forever, so marking on presence alone would
    /// leave every adopted decision badged "not yet adopted" permanently.
    #[test]
    fn an_adopted_binding_is_no_longer_pending() {
        let p = pending_from("adopted", &[log_line(json!([
            { "op": "bindTerm", "term": "deploy:*", "definition": "role='deployer'", "project": "studio" }
        ]))]);
        // The corpus already carries exactly this binding.
        let mut rows = vec![json!({
            "project": "studio", "surface": "deploy:*",
            "open": false, "bound_to": "role='deployer'"
        })];
        p.apply_terms(&mut rows);
        assert_eq!(rows[0]["bound_to"], json!("role='deployer'"));
        assert!(rows[0].get("pending").is_none(), "adopted, so not pending: {:?}", rows[0]);
    }

    /// One malformed line must not blind the reader to the records after it.
    #[test]
    fn an_adopted_proposal_is_not_reported_as_waiting() {
        let p = pending_from("rows", &[log_line(json!([
            { "op": "bindTerm", "term": "deploy:*", "definition": "role='deployer'", "project": "studio" },
            { "op": "bindTerm", "term": "public",   "definition": "sponsors.visibility='public'", "project": "studio" }
        ]))]);
        // The corpus carries the first binding and not the second.
        let terms = vec![
            json!({ "surface": "deploy:*", "bound_to": "role='deployer'" }),
            json!({ "surface": "public", "bound_to": "" }),
        ];
        let rows = p.to_rows(&terms, &[]);
        let adopted = |s: &str| {
            rows.iter()
                .find(|r| r["subject"] == json!(s))
                .and_then(|r| r["adopted"].as_bool())
                .unwrap()
        };
        assert!(adopted("deploy:*"), "already in the corpus");
        assert!(!adopted("public"), "not in the corpus, so still waiting");
    }

    #[test]
    fn a_corrupt_line_is_skipped_not_fatal() {
        let good = log_line(json!([{ "op": "retractTerm", "term": "or", "reason": "not a term" }]));
        let p = pending_from("corrupt", &["{not json".to_string(), good]);
        assert_eq!(p.records, 1);
        let mut rows = vec![json!({ "project": "studio", "surface": "or", "open": true })];
        p.apply_terms(&mut rows);
        assert_eq!(rows[0]["retracted"], json!(true));
    }
}
