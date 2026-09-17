//! The loopback hop to the gate sidecar, and the JSON→proto mapping.
//!
//! `//java:gate_binary` holds the corpus warm and answers `/healthz`, `/gates` and
//! `/preflight` on `127.0.0.1` (RFC-006 §3). This is the client for that hop and
//! nothing else: no auth, no retries, no pooling policy — it is two containers in
//! one pod sharing a network namespace.
//!
//! ⚠ HTTP on this hop is deliberate, and `GateServer`'s own javadoc has the
//! argument: gRPC's value is on the internet-facing hop, where the console needs a
//! typed contract across a network it does not control. `derivation.proto` stays
//! the schema of record and these payloads are its JSON projection — same field
//! names — which is what makes this module a mapping and not a translation.
//!
//! ⛔ THE MAPPING IS WHERE THE THREE-VALUED STATUS CAN DIE. `GATE_STATUS_PASSED`
//! and `GATE_STATUS_EXAMINED_NOTHING` exist as separate values precisely because
//! collapsing them reports a gate that could not have failed as one that did not.
//! A `match` arm that falls through to `Passed`, or a `population_source` string
//! that does not match and silently becomes `UNSPECIFIED`, undoes the entire point
//! of the enum — so every wire string is matched exhaustively and the tests below
//! pin each one.

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;

use crate::derivation_proto::{
    GateDelta, GateReport, GateResult, GateStatus, PopulationSource, PreflightResponse,
};

/// Where the gate sidecar listens. The chart sets this whenever `gate.enabled`,
/// so an unset value means the sidecar is not deployed rather than misconfigured —
/// a distinction the service surfaces instead of flattening into "unavailable".
pub const GATE_ADDR_ENV: &str = "SPEC_GATE_ADDR";

/// Which corpus the sidecar's image bakes, if anyone has said. Optional, and
/// deliberately without a default: a default here would be this process asserting
/// what some other image contains, which is the kind of claim that reads as
/// verified and is not. See [`GateClient::serves_project`].
pub const GATE_PROJECT_ENV: &str = "SPEC_GATE_PROJECT";

#[derive(Debug)]
pub enum GateError {
    /// The sidecar is not configured at all — `$SPEC_GATE_ADDR` is unset.
    NotConfigured,
    /// Configured, and the hop failed.
    Unreachable { addr: String, why: String },
    /// It answered, with a status that is not 200.
    Refused { code: u16, body: String },
    /// It answered 200 with something this mapping cannot read.
    Malformed(String),
}

impl std::fmt::Display for GateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(
                f,
                "the gate plane is not deployed: ${GATE_ADDR_ENV} is unset, which is what \
                 the chart does when gate.enabled is false"
            ),
            Self::Unreachable { addr, why } => {
                write!(f, "gate sidecar unreachable at {addr}: {why}")
            }
            Self::Refused { code, body } => write!(f, "gate sidecar answered {code}: {body}"),
            Self::Malformed(why) => write!(f, "gate sidecar returned unreadable JSON: {why}"),
        }
    }
}

/// A client for the sidecar's loopback JSON surface.
#[derive(Clone)]
pub struct GateClient {
    addr: Option<String>,
    project: Option<String>,
    http: Client<HttpConnector, Full<Bytes>>,
}

impl GateClient {
    pub fn from_env() -> Self {
        Self {
            addr: non_empty(std::env::var(GATE_ADDR_ENV).ok()),
            project: non_empty(std::env::var(GATE_PROJECT_ENV).ok()),
            http: Client::builder(TokioExecutor::new()).build_http(),
        }
    }

    /// The configured address, if the sidecar is deployed at all.
    pub fn addr(&self) -> Option<&str> {
        self.addr.as_deref()
    }

    /// The project whose corpus the sidecar bakes, if anyone has said so.
    ///
    /// ⛔ `None` is not "any project". The gate plane holds exactly ONE corpus,
    /// parsed at startup from what its image baked, and this process cannot see
    /// which. So a request naming a project is refused unless it matches a name
    /// somebody configured — answering over whichever corpus happens to be loaded
    /// would attribute one corpus's verdict to another, and the caller would have
    /// no way to tell.
    pub fn serves_project(&self) -> Option<&str> {
        self.project.as_deref()
    }

    /// The whole suite, as it stands.
    pub async fn gates(&self) -> Result<GateReport, GateError> {
        let body = self.get("/gates").await?;
        report_from_json(&parse(&body)?)
    }

    /// The suite over corpus + additions, and the difference.
    ///
    /// ⛔ ADDITIONS ONLY. `/preflight` has no removal channel — see
    /// `GateServer`'s javadoc, which checks the claim rather than assuming it
    /// (`tools/proposals/materialize.py` contains no `.remove(`: all 17
    /// constructors append, `retractTerm` included). The caller-facing refusal for
    /// `removals_turtle` lives in `derivation.rs`, where the request is seen.
    pub async fn preflight(&self, additions_turtle: &str) -> Result<PreflightResponse, GateError> {
        let body = self.post("/preflight", additions_turtle).await?;
        preflight_from_json(&parse(&body)?)
    }

    async fn get(&self, path: &str) -> Result<String, GateError> {
        self.send("GET", path, String::new()).await
    }

    async fn post(&self, path: &str, body: &str) -> Result<String, GateError> {
        self.send("POST", path, body.to_string()).await
    }

    async fn send(&self, method: &str, path: &str, body: String) -> Result<String, GateError> {
        let addr = self.addr.as_deref().ok_or(GateError::NotConfigured)?;
        let uri = format!("{addr}{path}");
        let req = hyper::Request::builder()
            .method(method)
            .uri(&uri)
            .header("content-type", "text/turtle")
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| GateError::Unreachable {
                addr: uri.clone(),
                why: e.to_string(),
            })?;
        let resp = self
            .http
            .request(req)
            .await
            .map_err(|e| GateError::Unreachable {
                addr: uri.clone(),
                why: e.to_string(),
            })?;
        let code = resp.status().as_u16();
        let bytes = resp
            .into_body()
            .collect()
            .await
            .map_err(|e| GateError::Unreachable {
                addr: uri,
                why: e.to_string(),
            })?
            .to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if code != 200 {
            return Err(GateError::Refused { code, body: text });
        }
        Ok(text)
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn parse(body: &str) -> Result<serde_json::Value, GateError> {
    serde_json::from_str(body).map_err(|e| GateError::Malformed(e.to_string()))
}

/// `GateCli.toJson`'s object → `GateReport`.
///
/// ⛔ `clean`, `failed` and `examined_nothing` are READ, never recomputed here.
/// The gate engine is the one that decides what clean means (`failed == 0 &&
/// examined_nothing == 0`, which is emphatically not `failed == 0`), and a second
/// implementation of that rule in this process is a second place for it to drift.
/// The one case where this module must do its own counting is a filtered subset,
/// and `crate::derivation` does it there with the same rule, loudly.
pub fn report_from_json(v: &serde_json::Value) -> Result<GateReport, GateError> {
    let gates = v
        .get("gates")
        .and_then(|g| g.as_array())
        .ok_or_else(|| GateError::Malformed("no `gates` array".into()))?
        .iter()
        .map(result_from_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(GateReport {
        gates,
        // ⚠ EMPTY, ALWAYS, TODAY. The wire payload has no corpus version — the
        // sidecar parses whatever its image baked and never says which. Filling
        // this with the image tag or a git sha would be this process inventing a
        // provenance claim the engine never made, and `GateReport.corpus_version`
        // is exactly the field a reader would trust. It stays empty until the
        // gate plane reports one.
        corpus_version: String::new(),
        failed: int(v, "failed")?,
        examined_nothing: int(v, "examined_nothing")?,
        clean: v
            .get("clean")
            .and_then(|c| c.as_bool())
            .ok_or_else(|| GateError::Malformed("no `clean` boolean".into()))?,
    })
}

fn result_from_json(v: &serde_json::Value) -> Result<GateResult, GateError> {
    Ok(GateResult {
        name: str_at(v, "name")?.to_string(),
        status: status_from_wire(str_at(v, "status")?) as i32,
        rows: int(v, "rows")?,
        examined: int(v, "examined")?,
        population_source: population_from_wire(str_at(v, "population_source")?) as i32,
        note: str_at(v, "note").unwrap_or_default().to_string(),
        first_row: str_at(v, "first_row").unwrap_or_default().to_string(),
    })
}

fn preflight_from_json(v: &serde_json::Value) -> Result<PreflightResponse, GateError> {
    let baseline = report_from_json(
        v.get("baseline")
            .ok_or_else(|| GateError::Malformed("no `baseline`".into()))?,
    )?;
    let proposed = report_from_json(
        v.get("proposed")
            .ok_or_else(|| GateError::Malformed("no `proposed`".into()))?,
    )?;
    let delta = v
        .get("delta")
        .and_then(|d| d.as_array())
        .ok_or_else(|| GateError::Malformed("no `delta` array".into()))?
        .iter()
        .map(|d| {
            Ok(GateDelta {
                name: str_at(d, "name")?.to_string(),
                was: status_from_wire(str_at(d, "was")?) as i32,
                now: status_from_wire(str_at(d, "now")?) as i32,
                examined_was: int(d, "examined_was")?,
                examined_now: int(d, "examined_now")?,
                rows_was: int(d, "rows_was")?,
                rows_now: int(d, "rows_now")?,
            })
        })
        .collect::<Result<Vec<_>, GateError>>()?;
    Ok(PreflightResponse {
        // prost renders a message-typed field as `Option`, so "absent" and
        // "present but empty" stay distinguishable on the wire. Both are always
        // present here: a preflight without a baseline is not a comparison.
        baseline: Some(baseline),
        proposed: Some(proposed),
        delta,
        gates_this_proposal_breaks: int(v, "gates_this_proposal_breaks")?,
        admissible: v
            .get("admissible")
            .and_then(|a| a.as_bool())
            .ok_or_else(|| GateError::Malformed("no `admissible` boolean".into()))?,
    })
}

/// The wire spelling is `Status.toString()` — SCREAMING_SNAKE, no prefix.
///
/// ⛔ An unrecognised value becomes `UNSPECIFIED`, never `PASSED`. A gate whose
/// verdict this process cannot read has not passed, and the one wrong default here
/// would be the flattering one.
fn status_from_wire(s: &str) -> GateStatus {
    match s {
        "PASSED" => GateStatus::Passed,
        "FAILED" => GateStatus::Failed,
        "EXAMINED_NOTHING" => GateStatus::ExaminedNothing,
        _ => GateStatus::Unspecified,
    }
}

/// ⛔ NOTE `"none"`. The engine's UNKNOWN spelling is `none` (GateCli's `String
/// source` starts there and is overwritten only when a population is found), so a
/// mapping that matched `"unknown"` would leave every unknown population as
/// `UNSPECIFIED` — and `examined: -1` would then be read as a real count of -1 by
/// anything that only checks the enum. The three lowercase spellings are the whole
/// vocabulary the engine emits.
fn population_from_wire(s: &str) -> PopulationSource {
    match s {
        "authored" => PopulationSource::Authored,
        "derived" => PopulationSource::Derived,
        "none" => PopulationSource::Unknown,
        _ => PopulationSource::Unspecified,
    }
}

fn str_at<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, GateError> {
    v.get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| GateError::Malformed(format!("no `{key}` string")))
}

fn int(v: &serde_json::Value, key: &str) -> Result<i64, GateError> {
    v.get(key)
        .and_then(|x| x.as_i64())
        .ok_or_else(|| GateError::Malformed(format!("no `{key}` integer")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A report shaped exactly like `GateCli.toJson` — including the authoring
    /// suite's real shape, where three of four gates examined nothing.
    fn suite_json() -> serde_json::Value {
        serde_json::json!({
            "gates": [
                {"name": "ladder_integrity", "status": "PASSED", "rows": 0, "examined": 40,
                 "population_source": "authored", "note": "", "first_row": ""},
                {"name": "envelope_unrecorded", "status": "EXAMINED_NOTHING", "rows": 0,
                 "examined": 0, "population_source": "authored", "note": "", "first_row": ""},
                {"name": "vacuous_invariant", "status": "EXAMINED_NOTHING", "rows": 0,
                 "examined": 0, "population_source": "derived", "note": "", "first_row": ""},
                {"name": "conflict_hygiene_strict", "status": "FAILED", "rows": 3,
                 "examined": -1, "population_source": "none", "note": "", "first_row": "x"}
            ],
            "failed": 1,
            "examined_nothing": 2,
            "clean": false
        })
    }

    #[test]
    fn maps_every_status_the_engine_emits() {
        let r = report_from_json(&suite_json()).expect("maps");
        let got: Vec<i32> = r.gates.iter().map(|g| g.status).collect();
        assert_eq!(
            got,
            vec![
                GateStatus::Passed as i32,
                GateStatus::ExaminedNothing as i32,
                GateStatus::ExaminedNothing as i32,
                GateStatus::Failed as i32,
            ]
        );
    }

    /// The whole reason the enum is three-valued: a clean gate over an empty
    /// candidate set must not arrive as PASSED.
    #[test]
    fn examined_nothing_does_not_collapse_into_passed() {
        assert_ne!(
            status_from_wire("EXAMINED_NOTHING"),
            status_from_wire("PASSED")
        );
        assert_eq!(status_from_wire("EXAMINED_NOTHING"), GateStatus::ExaminedNothing);
    }

    /// An unreadable verdict is UNSPECIFIED, not PASSED. If this ever flips, a
    /// version skew between the engine and this mapping turns every gate green.
    #[test]
    fn unknown_status_is_never_passed() {
        assert_eq!(status_from_wire("SOMETHING_NEW"), GateStatus::Unspecified);
        assert_eq!(status_from_wire(""), GateStatus::Unspecified);
    }

    /// `none`, not `unknown` — the spelling the engine actually emits.
    #[test]
    fn population_none_maps_to_unknown() {
        assert_eq!(population_from_wire("none"), PopulationSource::Unknown);
        assert_eq!(population_from_wire("authored"), PopulationSource::Authored);
        assert_eq!(population_from_wire("derived"), PopulationSource::Derived);
        // The trap this test exists for: the proto's own spelling is not the
        // wire's, and matching on it would silently unspecify every unknown.
        assert_eq!(population_from_wire("unknown"), PopulationSource::Unspecified);
    }

    /// `examined: -1` is UNKNOWN and must survive as -1 — a gate whose blindness
    /// nobody could determine must not arrive as one that examined zero.
    #[test]
    fn unknown_population_keeps_minus_one() {
        let r = report_from_json(&suite_json()).expect("maps");
        let g = &r.gates[3];
        assert_eq!(g.examined, -1);
        assert_eq!(g.population_source, PopulationSource::Unknown as i32);
    }

    /// `clean` is the engine's, carried through. A suite with no failures and two
    /// blind gates is NOT clean, and this asserts the value came from the wire
    /// rather than from a local `failed == 0`.
    #[test]
    fn clean_comes_from_the_engine_not_from_failed_zero() {
        let mut v = suite_json();
        v["failed"] = serde_json::json!(0);
        v["gates"][3]["status"] = serde_json::json!("PASSED");
        v["gates"][3]["rows"] = serde_json::json!(0);
        // The engine still says false, because two gates examined nothing.
        let r = report_from_json(&v).expect("maps");
        assert_eq!(r.failed, 0);
        assert_eq!(r.examined_nothing, 2);
        assert!(!r.clean, "clean must be the engine's verdict, not failed == 0");
    }

    #[test]
    fn corpus_version_is_empty_rather_than_invented() {
        let r = report_from_json(&suite_json()).expect("maps");
        assert_eq!(r.corpus_version, "");
    }

    #[test]
    fn malformed_json_is_an_error_not_an_empty_report() {
        let missing_clean = serde_json::json!({"gates": [], "failed": 0, "examined_nothing": 0});
        assert!(report_from_json(&missing_clean).is_err());
        let missing_gates = serde_json::json!({"failed": 0, "examined_nothing": 0, "clean": true});
        assert!(report_from_json(&missing_gates).is_err());
    }

    #[test]
    fn maps_a_preflight_delta() {
        let v = serde_json::json!({
            "baseline": suite_json(),
            "proposed": suite_json(),
            "delta": [
                {"name": "envelope_unrecorded", "was": "EXAMINED_NOTHING", "now": "PASSED",
                 "examined_was": 0, "examined_now": 40, "rows_was": 0, "rows_now": 0}
            ],
            "gates_this_proposal_breaks": 0,
            "admissible": true
        });
        let p = preflight_from_json(&v).expect("maps");
        assert_eq!(p.delta.len(), 1);
        let d = &p.delta[0];
        assert_eq!(d.was, GateStatus::ExaminedNothing as i32);
        assert_eq!(d.now, GateStatus::Passed as i32);
        // The most valuable move available here — a proposal that makes a blind
        // gate examine something — and a status-only diff would render it as no
        // change at all.
        assert_eq!(d.examined_was, 0);
        assert_eq!(d.examined_now, 40);
        assert!(p.admissible);
    }

    #[test]
    fn an_unset_address_is_not_configured_rather_than_unreachable() {
        let c = GateClient {
            addr: None,
            project: None,
            http: Client::builder(TokioExecutor::new()).build_http(),
        };
        assert!(c.addr().is_none());
        assert!(matches!(
            futures_lite_block_on(c.gates()),
            Err(GateError::NotConfigured)
        ));
    }

    /// A one-poll executor: the NotConfigured path returns before any await point
    /// that needs a reactor, so this avoids pulling a test-only runtime in.
    fn futures_lite_block_on<T>(fut: impl std::future::Future<Output = T>) -> T {
        use std::task::{Context, Poll, Waker};
        let mut fut = Box::pin(fut);
        let mut cx = Context::from_waker(Waker::noop());
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("expected the unconfigured path to resolve immediately"),
        }
    }
}
