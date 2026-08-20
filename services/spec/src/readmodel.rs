//! readmodel — the RFC-002 authoring read model, served from precomputed JSON.
//!
//! **The architectural decision this file encodes: the build computes, the plugin
//! serves.** The authoring read model (conflicts, empty envelopes, the frontier,
//! per-discipline coverage, claims, conflict witnesses) is the answer to six SPARQL
//! queries over an `au:`-carrying corpus. The alternative — a SPARQL engine inside
//! this plugin — means a new crate, a second RDF implementation, and a second thing
//! to keep in agreement with the Jena gates that are the source of truth. So the
//! queries run in the build (`tools/readmodel/emit_readmodel.py`), the results are
//! committed as one JSON file per route, and this module serves files.
//!
//! Same freshness model as the spec index next door: bounded by the git-sync
//! period, memoized behind a short TTL. The read model is as fresh as the last
//! emit, not live. For a corpus whose claims change at review cadence rather than
//! per-request that is the right side of the trade; if it ever isn't, the fix is a
//! rebuild trigger, not a query engine in the BFF.
//!
//! Envelope shape is identical to `crate::json`'s list responses —
//! `{"<rows_field>": [...], "unreachable_repos": [...]}` — so the meridian `table`
//! descriptors in `ui/panels.textproto` bind to it with no new renderer support.
//! A missing or malformed payload degrades to zero rows plus a note in
//! `unreachable_repos`, which is the wire form this plugin already uses for a
//! partial result: the panel shows its placeholder instead of an error.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Cap on one payload, so a pathological emit can't exhaust memory. The AMPERE
/// corpus emits ~90 KiB across all six routes; 32 MiB is four orders of magnitude
/// of headroom and still a bound.
const MAX_PAYLOAD_BYTES: u64 = 32 * 1024 * 1024;

/// The read-model routes: `(route, rows_field)`.
///
/// Kept in lockstep with three other places, all of which are generated from or
/// checked against this list:
///   * `readmodel/<route>.json`         — emitted by tools/readmodel/emit_readmodel.py
///   * `describe_json()`'s `web_routes` — how the shell resolves populate → REST
///   * `ui/panels.textproto`            — each panel's `rows_field`
///
/// Two checks keep them honest: `routes_match_describe` (below) asserts at
/// startup that this table and the `/describe` manifest agree, and
/// `tools/readmodel/check_wiring.py` asserts the same across all six descriptions
/// statically, with no toolchain beyond python3.
pub const ROUTES: &[(&str, &str)] = &[
    ("conflicts", "conflicts"),
    ("envelopes", "envelopes"),
    ("frontier", "stalls"),
    ("disciplines", "disciplines"),
    ("claims", "claims"),
    ("witness", "parties"),
    ("requirements", "requirements"),
    ("terms", "terms"),
    // Derived by //rdf/fanout + //tools/fanout:derive rather than by
    // emit_readmodel.py — the same "the build computes" rule, one engine
    // further along: this payload's queries run under ARQ, the engine of
    // record, instead of rdflib.
    ("workorders", "orders"),
];

/// The `rows_field` for a route name, or `None` if the route isn't one of ours.
pub fn rows_field(route: &str) -> Option<&'static str> {
    ROUTES.iter().find(|(r, _)| *r == route).map(|(_, f)| *f)
}

struct Cached {
    read: Instant,
    payload: Value,
}

/// Serves the emitted read-model payloads out of one directory.
pub struct ReadModel {
    dir: PathBuf,
    ttl: Duration,
    cache: Mutex<HashMap<String, Cached>>,
}

impl ReadModel {
    /// Directly, with no environment lookup. `from_env` is the thin wrapper.
    ///
    /// Separated so a caller — notably a test — can construct one without mutating
    /// process-global env vars. Rust runs `#[test]`s in parallel threads of ONE
    /// process, so `set_var` in a test is a data race against every other test that
    /// reads the same key; that is how this module's HTTP tests first failed.
    pub fn new(dir: PathBuf, ttl: Duration) -> Self {
        Self {
            dir,
            ttl,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Build from env:
    ///   SPEC_READMODEL_DIR       directory of emitted payloads. Default:
    ///                            `<SPEC_SOURCE_ROOT>/spec/services/spec/readmodel`
    ///                            — i.e. the committed copy in the git-synced tree,
    ///                            the same tree the spec index already scans.
    ///   SPEC_READMODEL_TTL_SECS  payload cache TTL (default 30, matching the index).
    pub fn from_env(source_root: &Path) -> Self {
        let dir = std::env::var("SPEC_READMODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| source_root.join("spec/services/spec/readmodel"));
        let ttl = std::env::var("SPEC_READMODEL_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);
        Self::new(dir, Duration::from_secs(ttl))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The response for one route: the emitted payload, or the empty-plus-note
    /// degradation. Never fails — an absent read model must not take the plugin's
    /// other three tables down with it.
    pub fn route(&self, route: &str) -> Value {
        let field = match rows_field(route) {
            Some(f) => f,
            // Unreachable through the router (every route is registered from
            // ROUTES), but a caller could pass anything.
            None => return json!({ "error": "unknown_route", "route": route }),
        };
        {
            let guard = self.cache.lock().unwrap();
            if let Some(c) = guard.get(route) {
                if c.read.elapsed() < self.ttl {
                    return c.payload.clone();
                }
            }
        }
        let payload = match self.load(route, field) {
            Ok(v) => v,
            Err(why) => {
                tracing::warn!(route, %why, dir = %self.dir.display(), "read model unavailable");
                return degraded(field, &why);
            }
        };
        let mut guard = self.cache.lock().unwrap();
        guard.insert(
            route.to_string(),
            Cached {
                read: Instant::now(),
                payload: payload.clone(),
            },
        );
        payload
    }

    /// Read and validate one payload file. The validation is what makes a truncated
    /// or half-written emit degrade to a placeholder rather than render a panel of
    /// garbage: the file must be a JSON object carrying `rows_field` as an array.
    fn load(&self, route: &str, field: &str) -> Result<Value, String> {
        let path = self.dir.join(format!("{route}.json"));
        let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if meta.len() > MAX_PAYLOAD_BYTES {
            return Err(format!(
                "{}: {} bytes exceeds the {MAX_PAYLOAD_BYTES}-byte payload cap",
                path.display(),
                meta.len()
            ));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        match value.get(field) {
            Some(Value::Array(_)) => Ok(value),
            _ => Err(format!(
                "{}: payload has no `{field}` array",
                path.display()
            )),
        }
    }

    /// Every route's row count, for `GET /readmodel` — the operator's answer to "is
    /// the read model deployed, and does it have anything in it". Worth having as a
    /// route because "the corpus is clean" and "the payload never shipped" render
    /// identically in a panel: both are an empty table.
    pub fn status(&self) -> Value {
        let routes: Vec<Value> = ROUTES
            .iter()
            .map(|(route, field)| {
                let payload = self.route(route);
                let rows = payload.get(field).and_then(Value::as_array).map_or(0, Vec::len);
                let note = payload
                    .get("unreachable_repos")
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(Value::as_str)
                    .unwrap_or("");
                json!({
                    "route": route,
                    "rows_field": field,
                    "rows": rows,
                    "available": note.is_empty(),
                    "note": note,
                })
            })
            .collect();
        json!({ "dir": self.dir.display().to_string(), "routes": routes })
    }
}

/// The empty-plus-note degradation. `unreachable_repos` is this plugin's existing
/// partial-result channel; reusing it means the shell's own handling applies with
/// no new client contract.
fn degraded(field: &str, why: &str) -> Value {
    json!({
        field: Vec::<Value>::new(),
        "unreachable_repos": [format!("read model unavailable — {why}")],
    })
}

/// Whether `ROUTES` and a `web_routes` manifest fragment describe the same six
/// routes. Called once at startup so a drifted `describe_json()` is a log line at
/// boot rather than a panel that renders "no gateway route for
/// spec.v1.Authoring/ListEnvelopes" in someone's browser.
///
/// Compares the authoring **GET** routes only: the write path
/// (`POST /proposal`, `POST /proposal/verdict-preview`) is on the same service but
/// is not part of the read model, and counting it here is how this check first went
/// wrong — it reported "8 declared, 6 served" on a correctly-wired plugin.
/// GET authoring routes that are NOT backed by an emitted payload.
///
/// ⚠ Named rather than filtered out silently. `proposals` is served from the
/// append-only proposal log, so it has no `proposals.json` and must not be added
/// to `ROUTES` — doing so would make it try to load a file that will never exist
/// and degrade every request. It is still asserted to be DECLARED below, so a
/// log-backed route cannot quietly go missing from /describe either.
pub const LOG_BACKED_ROUTES: &[&str] = &["proposals", "evaluations"];

/// Routes whose payload is derived by the BUILD rather than emitted by
/// `tools/readmodel/emit_readmodel.py` — the fanout derivation runs under ARQ
/// (`//rdf/fanout` + `//tools/fanout:derive`), the engine of record, and the
/// emitter is rdflib, the one RFC-005 says to retire rather than reconcile.
///
/// Declared here rather than repeated in `check_wiring.py` for the same reason
/// `LOG_BACKED_ROUTES` is: an exception with two definitions drifts, and the
/// whole point of this module's tables is that they cannot.
///
/// ⚠ These routes ARE served from `$SPEC_READMODEL_DIR` like any other payload.
/// What differs is who wrote the file, so the wiring check must not expect the
/// emitter to know about them — it must still expect the router to serve them.
pub const DERIVED_ROUTES: &[&str] = &["workorders"];

pub fn routes_match_describe(web_routes: &[Value]) -> Result<(), String> {
    let all: Vec<&str> = web_routes
        .iter()
        .filter(|r| r.get("service").and_then(Value::as_str) == Some(super::AUTHORING_SERVICE))
        .filter(|r| r.get("http_method").and_then(Value::as_str) == Some("GET"))
        .filter_map(|r| r.get("path").and_then(Value::as_str))
        .collect();
    for route in LOG_BACKED_ROUTES {
        if !all.contains(route) {
            return Err(format!("log-backed route `{route}` is served but not declared"));
        }
    }
    let declared: Vec<&str> = all
        .into_iter()
        .filter(|r| !LOG_BACKED_ROUTES.contains(r))
        .collect();
    let expected: Vec<&str> = ROUTES.iter().map(|(r, _)| *r).collect();
    if declared.len() != expected.len() {
        return Err(format!(
            "{} authoring web_routes declared, {} routes served",
            declared.len(),
            expected.len()
        ));
    }
    for route in &expected {
        if !declared.contains(route) {
            return Err(format!("route `{route}` is served but not declared"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_field_is_defined_for_every_route() {
        for (route, field) in ROUTES {
            assert_eq!(rows_field(route), Some(*field));
        }
        assert_eq!(rows_field("nope"), None);
    }

    #[test]
    fn a_missing_payload_degrades_to_zero_rows_not_an_error() {
        let rm = ReadModel::new(PathBuf::from("/nonexistent/readmodel"), Duration::from_secs(30));
        let v = rm.route("envelopes");
        assert_eq!(v["envelopes"].as_array().map(Vec::len), Some(0));
        assert_eq!(v["unreachable_repos"].as_array().map(Vec::len), Some(1));
        assert!(v.get("error").is_none());
    }

    #[test]
    fn the_committed_payloads_carry_their_rows_field() {
        // The repo's own emitted read model, resolved relative to the crate dir
        // (services/spec). `option_env!` + the exists() guard because the payloads
        // are source files, not runfiles: under `cargo test` they are right there,
        // under a bazel rust_test they are not staged, and this assertion is worth
        // having in the former without inventing a data dep for the latter.
        let dir = match option_env!("CARGO_MANIFEST_DIR") {
            Some(d) => PathBuf::from(d).join("readmodel"),
            None => return,
        };
        if !dir.is_dir() {
            return;
        }
        let rm = ReadModel::new(dir, Duration::from_secs(30));
        for (route, field) in ROUTES {
            let v = rm.route(route);
            assert!(
                v.get(field).and_then(Value::as_array).is_some(),
                "route `{route}` served no `{field}` array: {v}"
            );
            assert_eq!(
                v["unreachable_repos"].as_array().map(Vec::len),
                Some(0),
                "route `{route}` degraded: {v}"
            );
        }
    }

    #[test]
    fn served_routes_and_declared_routes_agree() {
        let declared = crate::routes::describe_web_routes();
        routes_match_describe(&declared).expect("describe_json and ROUTES agree");
    }
}
