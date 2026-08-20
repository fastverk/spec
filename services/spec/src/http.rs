//! http — the spec plugin's web plane.
//!
//! The fastverk-web shell is a neutral host: it discovers plugin backends and
//! forwards `/api/gw/spec/<rest>` here. This module is the HTTP/JSON surface it
//! reaches — the same data the canonical gRPC `spec.v1.SpecIndex` service would
//! serve, shaped for the browser via `crate::json`.
//!
//! Standalone plugins can't link botnoc's `fastverk-plugin-server` crate across a
//! crate_universe boundary, so — like the compliance plugin — this replicates the
//! small shared facade inline: an open `/healthz`, plus `/describe`,
//! `/panels.binpb`, and the data routes behind the shared gateway-token guard.
//! (De-dup follow-up: consume the published `fastverk-plugin-server` crate once it
//! lands.)
//!
//! Surface (all under the shell's `/api/gw/spec/` prefix):
//!   GET  /healthz        liveness (open)
//!   GET  /describe       DescribeResponse — the plugin manifest + web_routes
//!   GET  /panels.binpb   the meridian PanelBundle this plugin ships
//!   GET  /specs          SpecIndex.ListSpecs         (?repos=&langs=&kinds=)
//!   GET  /contracts      SpecIndex.ListContracts     (?repos=&only_uncited=)
//!   GET  /status         SpecIndex.ListModuleStatus  (?repos=)
//!   GET  /spec           SpecIndex.GetSpec           (?repo=&path=)
//!   GET  /contract       SpecIndex.GetContract       (?repo=&id=)
//!
//! The RFC-002 authoring plane (`spec.v1.Authoring`) — precomputed reads, see
//! `crate::readmodel`:
//!   GET  /conflicts      Authoring.ListConflicts
//!   GET  /envelopes      Authoring.ListEnvelopes        (the empty feasible envelopes)
//!   GET  /frontier       Authoring.ListStalls
//!   GET  /disciplines    Authoring.ListDisciplines
//!   GET  /claims         Authoring.ListClaims
//!   GET  /witness        Authoring.GetConflictWitness
//!   GET  /readmodel      per-route availability + row counts (operator view)
//!
//! …and its write side, which QUEUES rather than admits — see `crate::proposal` for
//! why that distinction is load-bearing and not a limitation to be worked around:
//!   POST /proposal                  Authoring.SubmitProposal
//!   POST /proposal/verdict-preview  Authoring.PreviewProposal

use std::sync::Arc;

use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::json as spec_json;
use crate::evaluation::{self, Evaluated};
use crate::overlay::Pending;
use crate::proposal::{self, Principal, ProposalLog};
use crate::proto::SpecLang;
use crate::readmodel::ReadModel;
use crate::routes::describe_web_routes;
use crate::{SpecBackend, AUTHORING_SERVICE};

/// Shared state for the facade: the estate indexer, the authoring read model, the
/// proposal log, and the optional panel bytes.
#[derive(Clone)]
pub struct HttpState {
    pub backend: Arc<SpecBackend>,
    pub readmodel: Arc<ReadModel>,
    pub log: Arc<ProposalLog>,
    /// Measurements, not judgements — see `crate::evaluation`.
    pub evaluations: Arc<ProposalLog>,
    pub panels: Option<Arc<Vec<u8>>>,
}

/// The spec PluginManifest as a DescribeResponse — proto3-JSON shape (snake_case)
/// so the shell composes this plugin's section without a proto dependency.
fn describe_json() -> Value {
    json!({
        "manifest": {
            "id": "spec",
            "display_name": "Specs",
            "version": env!("CARGO_PKG_VERSION"),
            "services": [{ "name": "spec.v1.SpecIndex" }, { "name": AUTHORING_SERVICE }],
            "runtime": "RUNTIME_SIDECAR",
            "lifecycle": "LIFECYCLE_ON_DEMAND",
            "privilege": "PRIVILEGE_USER",
            "panels": [{ "bundle_path": "panels.binpb", "adhoc_handler_ids": [] }],
            "server_services": [{ "name": "spec.v1.SpecIndex" }, { "name": AUTHORING_SERVICE }],
            "web_routes": describe_web_routes(),
        },
        "healthy": true,
    })
}

/// Build the facade router. Mounted at the root of the plugin's own service (the
/// shell prefixes `/api/gw/spec`). `/healthz` is open; everything else is behind
/// the gateway-token guard when `$FASTVERK_PLUGIN_TOKEN` is set.
pub fn router(state: HttpState, gateway_token: Option<String>) -> Router {
    // The MCP tool surface (POST /mcp) — the same index, exposed as tools for the
    // console chat host. Gated by the same gateway token as the data routes.
    let mcp = crate::mcp::router(state.backend.clone(), state.readmodel.clone());
    let guarded = Router::new()
        .route("/describe", get(describe))
        .route("/panels.binpb", get(panels))
        .route("/specs", get(list_specs))
        .route("/contracts", get(list_contracts))
        .route("/status", get(list_module_status))
        .route("/spec", get(get_spec))
        .route("/contract", get(get_contract))
        // ── the RFC-002 authoring plane ───────────────────────────────────────
        .route("/conflicts", get(list_conflicts))
        .route("/envelopes", get(list_envelopes))
        .route("/frontier", get(list_stalls))
        .route("/disciplines", get(list_disciplines))
        .route("/claims", get(list_claims))
        .route("/witness", get(get_conflict_witness))
        .route("/requirements", get(list_requirements))
        .route("/terms", get(list_terms))
        .route("/proposals", get(list_proposals))
        .route("/evaluations", get(list_evaluations))
        .route("/evaluation", post(submit_evaluation))
        .route("/readmodel", get(readmodel_status))
        .route("/proposal", post(submit_proposal))
        .route("/proposal/verdict-preview", post(preview_proposal))
        .route("/proposal/op", post(submit_op))
        .with_state(state)
        .merge(mcp);
    let guarded = match gateway_token.filter(|t| !t.is_empty()) {
        Some(token) => guarded.layer(from_fn_with_state(Arc::new(token), require_gateway_token)),
        None => guarded,
    };
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(guarded)
}

async fn describe() -> Json<Value> {
    Json(describe_json())
}

async fn panels(State(s): State<HttpState>) -> Response {
    match s.panels {
        Some(bytes) => (
            [(header::CONTENT_TYPE, "application/octet-stream")],
            (*bytes).clone(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "no panel bundle").into_response(),
    }
}

// ── data routes ───────────────────────────────────────────────────────────────

type ApiResult = (StatusCode, Json<Value>);

#[derive(Deserialize)]
struct SpecsQuery {
    repos: Option<String>,
    langs: Option<String>,
    kinds: Option<String>,
}

async fn list_specs(State(s): State<HttpState>, Query(q): Query<SpecsQuery>) -> ApiResult {
    let backend = s.backend.clone();
    let repos = split_csv(q.repos);
    let langs = parse_langs(q.langs);
    let kinds = split_csv(q.kinds);
    run(move || {
        let (specs, unreachable) = backend.list_specs(&repos, &langs, &kinds);
        spec_json::list_specs_response(specs, unreachable)
    })
    .await
}

#[derive(Deserialize)]
struct ContractsQuery {
    repos: Option<String>,
    only_uncited: Option<bool>,
}

async fn list_contracts(State(s): State<HttpState>, Query(q): Query<ContractsQuery>) -> ApiResult {
    let backend = s.backend.clone();
    let repos = split_csv(q.repos);
    let only_uncited = q.only_uncited.unwrap_or(false);
    run(move || {
        let (contracts, unreachable) = backend.list_contracts(&repos, only_uncited);
        spec_json::list_contracts_response(contracts, unreachable)
    })
    .await
}

#[derive(Deserialize)]
struct StatusQuery {
    repos: Option<String>,
}

async fn list_module_status(State(s): State<HttpState>, Query(q): Query<StatusQuery>) -> ApiResult {
    let backend = s.backend.clone();
    let repos = split_csv(q.repos);
    run(move || {
        let (modules, unreachable) = backend.list_module_status(&repos);
        spec_json::list_module_status_response(modules, unreachable)
    })
    .await
}

#[derive(Deserialize)]
struct SpecQuery {
    repo: String,
    path: String,
}

async fn get_spec(State(s): State<HttpState>, Query(q): Query<SpecQuery>) -> ApiResult {
    let backend = s.backend.clone();
    run(move || match backend.get_spec(&q.repo, &q.path) {
        Some((spec, source, lines)) => spec_json::get_spec_response(spec, source, lines),
        None => json!({ "error": "not_found" }),
    })
    .await
}

#[derive(Deserialize)]
struct ContractQuery {
    repo: String,
    id: String,
}

async fn get_contract(State(s): State<HttpState>, Query(q): Query<ContractQuery>) -> ApiResult {
    let backend = s.backend.clone();
    run(move || match backend.get_contract(&q.repo, &q.id) {
        Some((c, src, cites)) => spec_json::get_contract_response(c, src, cites),
        None => json!({ "error": "not_found" }),
    })
    .await
}

// ── the authoring read model ──────────────────────────────────────────────────
//
// Six routes, one shape. Each reads its precomputed payload (a file, cached behind
// a short TTL) and returns it verbatim; `crate::readmodel` owns the degradation
// when a payload is missing, so none of these can fail.
//
// Written as six named handlers rather than one parameterised route because the
// route table is the contract: `/envelopes` is greppable, and a mistyped path in a
// panel descriptor should 404 rather than reach a handler that shrugs.

macro_rules! readmodel_route {
    ($name:ident, $route:literal) => {
        async fn $name(State(s): State<HttpState>) -> ApiResult {
            let rm = s.readmodel.clone();
            run(move || rm.route($route)).await
        }
    };
}

readmodel_route!(list_conflicts, "conflicts");
readmodel_route!(list_envelopes, "envelopes");
readmodel_route!(list_stalls, "frontier");
readmodel_route!(list_disciplines, "disciplines");
readmodel_route!(list_claims, "claims");
/// `requirements` and `terms` are served THROUGH the pending overlay; the other
/// routes are not, because no op touches them yet. Pending rows carry
/// `pending: true` and are rendered as proposed rather than as fact — see
/// `crate::overlay` for why that distinction is load-bearing.
macro_rules! overlaid_route {
    ($name:ident, $route:literal, $apply:ident) => {
        async fn $name(State(s): State<HttpState>) -> ApiResult {
            let rm = s.readmodel.clone();
            let log = s.log.clone();
            run(move || {
                let mut payload = rm.route($route);
                let pending = Pending::read(log.path());
                if pending.is_empty() {
                    return payload;
                }
                if let Some(rows) = payload.get_mut($route).and_then(|v| v.as_array_mut()) {
                    pending.$apply(rows);
                }
                payload
            })
            .await
        }
    };
}

async fn list_requirements(State(s): State<HttpState>) -> ApiResult {
    let rm = s.readmodel.clone();
    let log = s.log.clone();
    let evals = s.evaluations.clone();
    run(move || {
        let mut payload = rm.route("requirements");
        let pending = Pending::read(log.path());
        let measured = Evaluated::read(evals.path());
        if pending.is_empty() && measured.is_empty() {
            return payload;
        }
        if let Some(rows) = payload.get_mut("requirements").and_then(|v| v.as_array_mut()) {
            pending.apply_requirements(rows);
            measured.apply(rows);
        }
        payload
    })
    .await
}
overlaid_route!(list_terms, "terms", apply_terms);

/// `GET /evaluations` — every measurement, latest per (claim, implementation).
async fn list_evaluations(State(s): State<HttpState>) -> ApiResult {
    let evals = s.evaluations.clone();
    run(move || {
        let measured = Evaluated::read(evals.path());
        json!({
            "evaluations": measured.to_rows(),
            "records": measured.records,
            "write_enabled": evals.enabled(),
        })
    })
    .await
}

/// `POST /evaluation` — record what a check examined.
///
/// ⛔ Refuses a pass over an empty population BEFORE recording it. The corpus
/// gate catches that defect too, but appending it to an append-only log first
/// and relying on a later gate to notice means knowingly writing something
/// permanent and wrong.
async fn submit_evaluation(
    State(s): State<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    let Some(who) = principal(&headers) else {
        return no_principal();
    };
    if !s.evaluations.enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "E_WRITE_DISABLED",
                "message": "$SPEC_EVALUATION_LOG is unset; this instance records no measurements",
            })),
        );
    }
    let ev = match evaluation::check(&body, &who.email) {
        Ok(e) => e,
        Err(why) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "error": "E_VACUOUS_OR_MALFORMED", "message": why })),
            )
        }
    };
    match s.evaluations.append(&ev.record()) {
        Ok(offset) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "recorded": true,
                "log_offset": offset,
                "claim": ev.claim,
                "outcome": ev.outcome,
                "population": ev.population,
            })),
        ),
        Err(why) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "E_LOG_APPEND", "message": why })),
        ),
    }
}

/// `GET /proposals` — everything written but not yet adopted into the corpus.
async fn list_proposals(State(s): State<HttpState>) -> ApiResult {
    let log = s.log.clone();
    let rm = s.readmodel.clone();
    run(move || {
        let pending = Pending::read(log.path());
        // The RAW corpus payloads, not the overlaid ones — adoption is measured
        // against what the corpus says, and overlaying first would make every
        // proposal look adopted the moment it was written.
        let terms = rm.route("terms");
        let reqs = rm.route("requirements");
        let empty = vec![];
        let tr = terms.get("terms").and_then(Value::as_array).unwrap_or(&empty);
        let rr = reqs.get("requirements").and_then(Value::as_array).unwrap_or(&empty);
        json!({
            "proposals": pending.to_rows(tr, rr),
            "records": pending.records,
            // ⚠ FALSE here, always, and not because the log is unset: this
            // plugin no longer appends. It still READS the log — that is what
            // `records` above counts — so "can I see proposals" and "can I make
            // one" are now different questions and answered separately.
            "write_enabled": false,
            "write_at": "the console: POST /api/proposal",
            "log_readable": log.enabled(),
            // Named so the UI can say what adopting them requires rather than
            // implying they are already in force.
            "adopt_with": "tools/proposals/materialize.py",
        })
    })
    .await
}
readmodel_route!(get_conflict_witness, "witness");

/// Per-route availability + row counts. The operator's answer to "is the read model
/// deployed, and does it have anything in it" — distinguishable from "the corpus is
/// clean", which looks identical from a panel.
async fn readmodel_status(State(s): State<HttpState>) -> ApiResult {
    let rm = s.readmodel.clone();
    let readable = s.log.enabled();
    run(move || {
        let mut v = rm.status();
        // Retired, not merely unconfigured. An operator reading `false` here
        // should not go looking for the environment variable that would turn it
        // back on — there isn't one.
        v["write_path_enabled"] = json!(false);
        v["write_path_retired"] = json!(true);
        v["proposal_log_readable"] = json!(readable);
        v
    })
    .await
}

// ── the authoring write path ──────────────────────────────────────────────────

/// The caller, from the gateway-injected identity headers. `None` when the plugin
/// is reached without the console in front of it (a direct curl with the plugin
/// bearer): the read routes stay open in that case, but a write with no principal
/// has no author to record, so it is refused rather than attributed to nobody.
fn principal(headers: &HeaderMap) -> Option<Principal> {
    let get = |k: &str| headers.get(k).and_then(|v| v.to_str().ok());
    Principal::from_headers(get("x-fastverk-user-sub"), get("x-fastverk-user-email"))
}

fn no_principal() -> ApiResult {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "error": "E_NO_PRINCIPAL",
            "message": "no X-Fastverk-User-Sub header — a proposal must have an author",
        })),
    )
}

/// Where the write path went, and what to use instead.
///
/// ⛔ **410 Gone, not 404 and not 501.** The distinction is the whole message: the
/// route existed, it worked, and it has been deliberately removed. A 404 would
/// read as a deployment fault and send someone looking for a bug; a 501 would say
/// this build cannot do it, which is a claim about capability rather than about a
/// decision.
///
/// The decision: **one door.** Two doors that both append are two places the op
/// vocabulary, the canonical bytes and — since the door started computing one —
/// the content ADDRESS can disagree. They did. `from_flat` here coerced a form's
/// `bound_value` string to an f64 and the console's `fromFlat` left it a string,
/// so the same submission had two different canonical bodies and would now have
/// two different permanent names. RFC-002 §9.1's equal-citizen gate is not
/// satisfiable with two implementations of the pre-image.
///
/// What is left here is the READ side of the same log — the pending overlay, which
/// several routes above serve through — and `verdict-preview`, which writes
/// nothing and now returns the address the console would give the proposal.
const WRITE_RETIRED: &str = concat!(
    "this plugin's write path is retired: a proposal is admitted by the console, ",
    "which is the one door that computes the content address (RFC-002 §4.1, §9.1). ",
    "This route appended to $SPEC_PROPOSAL_LOG and minted no address."
);

fn write_retired(use_instead: &str) -> ApiResult {
    (
        StatusCode::GONE,
        Json(json!({
            "error": "E_WRITE_PATH_RETIRED",
            "message": WRITE_RETIRED,
            "use_instead": use_instead,
            // The one thing this plugin still offers on the write side, so a
            // caller has somewhere to go that is not "read the RFC".
            "preview_here": "POST /proposal/verdict-preview",
        })),
    )
}

/// `POST /proposal` — **410 Gone**. See `write_retired`.
async fn submit_proposal() -> ApiResult {
    write_retired("POST /api/proposal on the console")
}

/// `POST /proposal/op` — **410 Gone**. See `write_retired`.
///
/// The flat one-op lift that made a declarative meridian `FormPanel` able to write
/// with no browser code now lives in `console/lib/proposal.ts::fromFlat`, behind
/// `POST /api/proposal/op`. The affordance is unchanged; the door moved.
async fn submit_op() -> ApiResult {
    write_retired("POST /api/proposal/op on the console")
}

/// `POST /proposal/verdict-preview` — the structural check with nothing written.
///
/// Answers "is this well-formed, what does it touch, and what is currently
/// infeasible". It does **not** answer "will admitting this create an unrecorded
/// empty envelope": that is a `GROUP BY … HAVING` over the post-admission graph, and
/// the gates that decide it run in the build. `limits` says so in the body, because
/// a route named `verdict-preview` that quietly under-delivers is worse than one
/// that states its scope.
async fn preview_proposal(
    State(s): State<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    let Some(who) = principal(&headers) else {
        return no_principal();
    };
    let checked = match proposal::check(&body, who) {
        Ok(c) => c,
        Err(why) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "E_MALFORMED_PROPOSAL", "message": why })),
            )
        }
    };
    let rm = s.readmodel.clone();
    let known = tokio::task::spawn_blocking(move || rm.route("envelopes"))
        .await
        .ok()
        .and_then(|v| v.get("envelopes").cloned())
        .unwrap_or_else(|| json!([]));
    (
        StatusCode::OK,
        Json(json!({
            "well_formed": checked.rejected() == 0,
            // What the door WOULD answer: typing and capability, decidable from
            // the proposal alone. Not the gate set — see `limits`.
            "verdict": checked.verdict(),
            "admissible_ops": checked.admissible(),
            "queued_ops": checked.queued(),
            "rejected_ops": checked.rejected(),
            "ops": checked.report(),
            "canonical": checked.canonical,
            // ⛔ The NAME this proposal will have, before it is submitted.
            // RFC-002 §9 step 6: "confirm:true is the only mutating call and
            // carries a pid whose content hash the user already saw." This is
            // where the user sees it. Null only when an op carries a value with
            // no reproducible rendering, which is a rejection.
            "address": checked.address,
            "address_pre_image": checked.pre_image,
            // Context, not consequence: the infeasibilities that already exist as of
            // the last emit. If an op you are about to submit lands on one of these
            // quantities, that is worth seeing before you submit it.
            "known_empty_envelopes": known,
            "limits": [
                "structural only — op vocabulary, required fields, enumerated values, capability",
                "does NOT evaluate the coherence gates; the empty-envelope check is a build-time SPARQL aggregate",
                "does NOT verify `parent` names a real bitemporal read point",
                "the address is real and is the one the console will record; the VERDICT here is provisional — capability is read from the headers this request carried",
                "writes nothing: this plugin's write path is retired (410), and the console is the door",
            ],
        })),
    )
}

/// Run a blocking index query off the async runtime and shape the result.
async fn run<F>(f: F) -> ApiResult
where
    F: FnOnce() -> Value + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("index task failed: {e}") })),
        ),
    }
}

fn split_csv(s: Option<String>) -> Vec<String> {
    s.map(|s| {
        s.split(',')
            .filter(|x| !x.is_empty())
            .map(String::from)
            .collect()
    })
    .unwrap_or_default()
}

/// Parse a CSV of language names (or numbers) to proto enum i32s. Unknown values
/// are dropped. v1's panels don't pass this; it's here for the API contract.
fn parse_langs(s: Option<String>) -> Vec<i32> {
    split_csv(s)
        .into_iter()
        .filter_map(|t| match t.to_ascii_uppercase().as_str() {
            "LEAN" | "SPEC_LANG_LEAN" => Some(SpecLang::Lean as i32),
            "TLA" => Some(SpecLang::Tla as i32),
            "ALLOY" => Some(SpecLang::Alloy as i32),
            "DAFNY" => Some(SpecLang::Dafny as i32),
            "SMT" => Some(SpecLang::Smt as i32),
            "COQ" => Some(SpecLang::Coq as i32),
            other => other.parse::<i32>().ok(),
        })
        .collect()
}

/// Reject any request whose bearer token doesn't match the shared gateway token
/// (the secret the shell's gateway injects). Mirrors fastverk-plugin-server.
async fn require_gateway_token(
    State(expected): State<Arc<String>>,
    req: Request,
    next: Next,
) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    match presented {
        Some(t) if t == expected.as_str() => next.run(req).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "E_GATEWAY_AUTH", "message": "missing or invalid gateway token" })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use std::io::{Read, Write};

    use tokio::net::TcpListener;

    /// Boot the real router on an ephemeral port and return its address.
    ///
    /// A raw-socket client rather than `tower::ServiceExt::oneshot` because `tower`
    /// is not a dependency of this crate and adding one means re-pinning the
    /// plugin's crate universe. `tokio` is already here, hyper speaks HTTP/1.1, and
    /// a hand-written request line is a complete client for this purpose — the point
    /// is to exercise the ROUTE TABLE and the handler signatures, which is exactly
    /// what nothing else in this repo does.
    async fn serve(readmodel_dir: &str, log: Option<&str>) -> String {
        let backend = Arc::new(crate::SpecBackend::from_env());
        // Constructed directly, never through the env: these tests run in parallel
        // threads of one process, so `set_var` here would race every other test.
        let readmodel = Arc::new(ReadModel::new(
            std::path::PathBuf::from(readmodel_dir),
            std::time::Duration::from_secs(30),
        ));
        let log = Arc::new(ProposalLog::new(log.map(std::path::PathBuf::from)));
        // Disabled here on purpose: the tests that care construct their own.
        let evaluations = Arc::new(ProposalLog::new(None));
        let app = router(
            HttpState {
                backend,
                readmodel,
                log,
                evaluations,
                panels: None,
            },
            None,
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        addr
    }

    /// `(status, body)` for one request. `body` is `None` for a GET.
    ///
    /// A BLOCKING `std::net::TcpStream` on the blocking pool, not
    /// `tokio::io::AsyncReadExt`: that trait lives behind tokio's `io-util` feature,
    /// which this crate does not enable, and turning it on would mean re-resolving
    /// the plugin's crate universe for the sake of a test client. The runtime stays
    /// free to drive the server because the client runs on `spawn_blocking`.
    async fn request(
        addr: &str,
        method: &str,
        path: &str,
        body: Option<(&str, &str)>,
    ) -> (u16, String) {
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n");
        if let Some((hdr, payload)) = body {
            req += "content-type: application/json\r\n";
            req += &format!("content-length: {}\r\n", payload.len());
            req += hdr;
            req += "\r\n";
            req += payload;
        } else {
            req += "\r\n";
        }
        let addr = addr.to_string();
        tokio::task::spawn_blocking(move || {
            let mut s = std::net::TcpStream::connect(&addr).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut raw = String::new();
            s.read_to_string(&mut raw).unwrap();
            let status: u16 = raw
                .split_whitespace()
                .nth(1)
                .and_then(|c| c.parse().ok())
                .unwrap_or(0);
            let body = raw
                .split_once("\r\n\r\n")
                .map(|(_, b)| b)
                .unwrap_or("")
                .to_string();
            (status, body)
        })
        .await
        .unwrap()
    }

    fn readmodel_fixture() -> String {
        // The repo's own committed payloads when reachable (cargo), else a directory
        // that does not exist — which is itself the interesting case, since every
        // read route must still answer 200 with zero rows.
        option_env!("CARGO_MANIFEST_DIR")
            .map(|d| format!("{d}/readmodel"))
            .filter(|d| std::path::Path::new(d).is_dir())
            .unwrap_or_else(|| "/nonexistent/readmodel".to_string())
    }

    #[tokio::test]
    async fn every_declared_get_route_answers_200_with_its_rows_field() {
        let addr = serve(&readmodel_fixture(), None).await;
        for r in describe_web_routes() {
            if r["http_method"] != "GET" {
                continue;
            }
            let path = r["path"].as_str().unwrap();
            // The two index routes that take required query params are not part of
            // this assertion; everything else must answer without arguments.
            if matches!(path, "spec" | "contract") {
                continue;
            }
            let (status, body) = request(&addr, "GET", &format!("/{path}"), None).await;
            assert_eq!(status, 200, "GET /{path} -> {status}: {body}");
            if let Some(field) = crate::readmodel::rows_field(path) {
                let v: Value = serde_json::from_str(&body).expect(&body);
                assert!(
                    v.get(field).and_then(Value::as_array).is_some(),
                    "GET /{path} has no `{field}` array: {body}"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_missing_read_model_still_answers_200_with_zero_rows() {
        let addr = serve("/nonexistent/readmodel", None).await;
        let (status, body) = request(&addr, "GET", "/envelopes", None).await;
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["envelopes"].as_array().map(Vec::len), Some(0));
        assert_eq!(v["unreachable_repos"].as_array().map(Vec::len), Some(1));
    }

    #[tokio::test]
    async fn preview_reports_the_op_split_and_states_its_limits() {
        let addr = serve(&readmodel_fixture(), None).await;
        let payload = concat!(
            r#"{"parent":"p","surface":"Meridian","ops":["#,
            r#"{"op":"narrowGuard","subject":"s","guard":"ambient_c >= 40"},"#,
            r#"{"op":"declarePrecedence","higher":"a","lower":"b","rationale":"r"}"#,
            r#"]}"#
        );
        let hdr = "x-fastverk-user-sub: u-1\r\nx-fastverk-user-email: a@b.c\r\n";
        let (status, body) = request(&addr, "POST", "/proposal/verdict-preview", Some((hdr, payload))).await;
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).expect(&body);
        assert_eq!(v["well_formed"], json!(true));
        assert_eq!(v["admissible_ops"], json!(1));
        assert_eq!(v["queued_ops"], json!(1), "declarePrecedence must queue: {body}");
        // The route must say what it does NOT check. A verdict-preview that quietly
        // under-delivers is worse than one that states its scope.
        assert!(v["limits"].as_array().is_some_and(|a| a.len() >= 4), "{body}");
    }

    #[tokio::test]
    async fn both_write_routes_are_gone_and_say_where_the_door_is() {
        // ⛔ The log is CONFIGURED and still nothing is written. The refusal is a
        // decision about which door admits proposals, not a missing environment
        // variable — an operator who set $SPEC_PROPOSAL_LOG and got a 503 would
        // reasonably conclude the write path exists and is misconfigured.
        let dir = std::env::temp_dir().join(format!("spec-gone-{}", std::process::id()));
        let log = dir.join("proposals.jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        let addr = serve(&readmodel_fixture(), Some(log.to_str().unwrap())).await;
        let hdr = "x-fastverk-user-sub: u-1\r\n";

        let nested = r#"{"parent":"p","ops":[{"op":"retractNS","subject":"s","reason":"r"}]}"#;
        let flat = r#"{"parent":"p","op":"retractNS","subject":"s","reason":"r"}"#;
        for (route, payload) in [("/proposal", nested), ("/proposal/op", flat)] {
            let (status, body) = request(&addr, "POST", route, Some((hdr, payload))).await;
            assert_eq!(status, 410, "{route}: {body}");
            let v: Value = serde_json::from_str(&body).expect(&body);
            assert_eq!(v["error"], json!("E_WRITE_PATH_RETIRED"), "{body}");
            // A refusal that does not say where to go instead is a dead end.
            assert!(
                v["use_instead"].as_str().is_some_and(|u| u.contains("console")),
                "{body}"
            );
        }
        assert!(!log.exists(), "a retired write path must not touch the log");

        // ⚠ And with NO principal, still 410 — not 401. The route is gone for
        // everyone; answering 401 first would suggest that credentials are what
        // stands between the caller and a write.
        let (status, body) = request(&addr, "POST", "/proposal", Some(("", nested))).await;
        assert_eq!(status, 410, "{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_preview_names_the_proposal_before_it_is_submitted() {
        let addr = serve(&readmodel_fixture(), None).await;
        let ops = r#"[{"op":"retractNS","subject":"s","reason":"r"}]"#;
        let hdr = "x-fastverk-user-sub: u-1\r\nx-fastverk-user-email: a@b.c\r\n";

        let preview = |surface: &'static str, intent: &'static str| {
            let payload = format!(
                r#"{{"parent":"p","surface":"{surface}","ops":{ops},"intent":"{intent}"}}"#
            );
            let addr = addr.clone();
            async move {
                let (status, body) =
                    request(&addr, "POST", "/proposal/verdict-preview", Some((hdr, &payload))).await;
                assert_eq!(status, 200, "{body}");
                serde_json::from_str::<Value>(&body).expect(&body)
            }
        };

        let click = preview("Meridian", "clicked it").await;
        let chat = preview("Chat", "asked for it in words").await;

        assert_eq!(click["verdict"], json!("Admitted"));
        let address = click["address"].as_str().expect("an address");
        assert!(address.starts_with("sha256:") && address.len() == 71, "{address}");
        // RFC-002 §9 step 6: the hash the user sees before confirming. It is the
        // real one — this is the same function the console records with.
        assert_eq!(
            address,
            crate::proposal::content_address(
                "u-1",
                serde_json::from_str::<Value>(ops).unwrap().as_array().unwrap(),
                "p"
            )
        );

        // ⛔ §9.1 across two surfaces and two intent records: ONE name…
        assert_eq!(chat["address"], click["address"]);
        assert_eq!(chat["address_pre_image"], click["address_pre_image"]);
        // …and two records. Provenance is kept; it just does not get a vote.
        assert_ne!(chat["canonical"], click["canonical"]);
    }

    #[tokio::test]
    async fn a_malformed_op_previews_as_rejected_and_unnamed_where_it_must_be() {
        let addr = serve(&readmodel_fixture(), None).await;
        let hdr = "x-fastverk-user-sub: u-1\r\n";

        // Ill-formed, but nameable: the bytes canonicalize, so the author gets
        // both the reason and the address to quote.
        let payload = r#"{"parent":"p","ops":[{"op":"promote","subject":"s","rung":"R9","evidence":"e"}]}"#;
        let (status, body) = request(&addr, "POST", "/proposal/verdict-preview", Some((hdr, payload))).await;
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).expect(&body);
        assert_eq!(v["verdict"], json!("Rejected"), "{body}");
        assert_eq!(v["well_formed"], json!(false));
        assert!(v["address"].is_string(), "{body}");

        // Not nameable: a number with no reproducible rendering has no pre-image,
        // so there is nothing to hash and the answer is null rather than a
        // plausible-looking digest.
        let payload = concat!(
            r#"{"parent":"p","ops":[{"op":"assertNS","subject":"s","text":"t","#,
            r#""discipline":"d","rung":"R0","bound_value":1.5}]}"#
        );
        let (status, body) = request(&addr, "POST", "/proposal/verdict-preview", Some((hdr, payload))).await;
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).expect(&body);
        assert_eq!(v["verdict"], json!("Rejected"), "{body}");
        assert_eq!(v["address"], Value::Null, "{body}");
        assert!(body.contains("safe integer"), "{body}");
    }

    #[tokio::test]
    async fn describe_carries_the_authoring_service_and_its_routes() {
        let addr = serve(&readmodel_fixture(), None).await;
        let (status, body) = request(&addr, "GET", "/describe", None).await;
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).expect(&body);
        let routes = v["manifest"]["web_routes"].as_array().expect(&body);
        assert_eq!(routes.len(), describe_web_routes().len());
        let names: Vec<&str> = v["manifest"]["services"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&AUTHORING_SERVICE), "{body}");
    }
}
