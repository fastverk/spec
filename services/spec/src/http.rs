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
use crate::workorder::{self, Running};
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
    /// Dispatches: neither judgement nor measurement, but an authorization to
    /// write. A THIRD log, for the reason `main.rs` gives for the second —
    /// replaying "who decided this", "what did it measure" and "who was
    /// allowed to write where" from one file would make them one question.
    pub dispatches: Arc<ProposalLog>,
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
        .route("/workorders", get(list_work_orders))
        .route("/workorder/dispatch", post(dispatch_work_order))
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

/// `GET /workorders` — the derived orders, with the dispatch gate's answer.
///
/// The payload's `state` was computed at derivation from `conflict_holds`
/// alone, because the build cannot see the dispatch log. RUNNING is overlaid
/// here — the same shape as `Evaluated::apply` next door, corpus first, log on
/// top.
async fn list_work_orders(State(s): State<HttpState>) -> ApiResult {
    let rm = s.readmodel.clone();
    let dispatches = s.dispatches.clone();
    run(move || {
        let mut payload = rm.route("workorders");
        let running = Running::read(dispatches.path());
        if let Some(rows) = payload.get_mut("orders").and_then(Value::as_array_mut) {
            for row in rows.iter_mut() {
                let Some(id) = row.get("order_id").and_then(Value::as_str).map(str::to_string)
                else {
                    continue;
                };
                if running.is_running(&id) {
                    let agents = running.agents(&id);
                    row["state_code"] = json!(workorder::STATE_RUNNING);
                    row["state"] = json!(format!("RUNNING · {agents} agents"));
                    row["agents"] = json!(agents);
                }
            }
        }
        payload["dispatch_enabled"] = json!(dispatches.enabled());
        payload
    })
    .await
}

/// `POST /workorder/dispatch` — authorize agents to build against one order.
///
/// ⛔ Refuses before appending, and the refusals are not overridable here:
/// a held order dispatches when its conflict is adjudicated, which is a
/// different act with its own record. See `crate::workorder`.
async fn dispatch_work_order(
    State(s): State<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    let Some(who) = principal(&headers) else {
        return no_principal();
    };
    // An agent may not dispatch. `proposal::check_op` restricts an agent to
    // assertNS at R0; dispatch authorizes writes to a path set, so an agent
    // that could dispatch could widen its own scope by choosing a better
    // order — the containment RFC-002 §10 mechanism 4 describes.
    if who.agent {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "E_AGENT_MAY_NOT_DISPATCH",
                "message": "an agent principal may not dispatch work orders — dispatch \
                            authorizes writes to a path set, and an agent that could choose \
                            its own order could widen its own scope",
            })),
        );
    }
    if !s.dispatches.enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "E_WRITE_DISABLED",
                "message": "$SPEC_DISPATCH_LOG is unset; this instance authorizes no dispatches",
            })),
        );
    }
    let order_id = body
        .get("order_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if order_id.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": "E_MALFORMED",
                "message": "`order_id` is required — a dispatch names one order",
            })),
        );
    }
    let agents = body.get("agents").and_then(Value::as_i64).unwrap_or(0);

    let payload = s.readmodel.route("workorders");
    let orders = workorder::orders(&payload);
    let running = Running::read(s.dispatches.path());
    let verdict = workorder::check(&order_id, &orders, &running);
    if !verdict.is_dispatched() {
        // 409: the request is well-formed and the state refuses it. Not 422 —
        // nothing about the body is wrong, and a caller retrying after the
        // conflict is adjudicated will succeed with the same bytes.
        return (StatusCode::CONFLICT, Json(verdict.to_json()));
    }
    let order = &orders[&order_id];
    let as_of = payload
        .get("orders")
        .and_then(Value::as_array)
        .and_then(|rows| rows.iter().find(|r| r["order_id"] == order_id.as_str()))
        .and_then(|r| r.pointer("/order/as_of"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let rec = workorder::record(order, &as_of, &who.email, agents);
    match s.dispatches.append(&rec) {
        Ok(offset) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "verdict": workorder::DISPATCHED,
                "order_id": order_id,
                "as_of": as_of,
                "agents": agents,
                "log_offset": offset,
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
            "write_enabled": log.enabled(),
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
    let enabled = s.log.enabled();
    run(move || {
        let mut v = rm.status();
        v["write_path_enabled"] = json!(enabled);
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

/// `POST /proposal` — check every op and append the proposal to the log.
///
/// The response deliberately does **not** contain an admission verdict or a content
/// address. It contains the per-op structural report, the canonical bytes the
/// address will be taken over, and the log offset. See `crate::proposal`.
async fn submit_proposal(
    State(s): State<HttpState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    submit(&s, &headers, body)
}

/// `POST /proposal/op` — the same thing, from a **flat** body carrying exactly one
/// op, which is the only shape a declarative meridian `FormPanel` can submit.
///
/// This route is what makes a write affordance expressible with no browser code:
/// the shell's `renderFormPanelInto` builds `{request_field: value}` from the
/// descriptor's bindings and POSTs it, so `{parent, op: "assertNS", subject, …}`
/// arrives here and `proposal::from_flat` lifts it to a one-op proposal. Every value
/// is a string (it came from an `<input>`), and `from_flat` re-types only the fields
/// it declares — see the coercion tables there.
///
/// Multi-op proposals with per-op accept/reject triage still need a richer surface.
/// One-op proposals are most of them.
async fn submit_op(
    State(s): State<HttpState>,
    headers: HeaderMap,
    Json(flat): Json<Value>,
) -> ApiResult {
    match proposal::from_flat(&flat) {
        Ok(body) => submit(&s, &headers, body),
        Err(why) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "E_MALFORMED_FORM", "message": why })),
        ),
    }
}

/// Shared by both write routes: authenticate, check, append.
///
/// One function, deliberately — RFC-002 §4 wants exactly one callsite that applies
/// ops. The plugin cannot enforce that for the real door, but it can at least ensure
/// its own two entry points cannot diverge in what they validate.
fn submit(s: &HttpState, headers: &HeaderMap, body: Value) -> ApiResult {
    let Some(who) = principal(headers) else {
        return no_principal();
    };
    if !s.log.enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "E_WRITE_DISABLED",
                "message": "$SPEC_PROPOSAL_LOG is unset; this instance is read-only",
            })),
        );
    }
    let checked = match proposal::check(&body, who) {
        Ok(c) => c,
        Err(why) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "E_MALFORMED_PROPOSAL", "message": why })),
            )
        }
    };
    // A proposal with any rejected op is not appended at all. Partial admission is
    // normal (§5) and applies to the OK/QUEUED split; an op that is not even
    // well-formed is an authoring mistake, and half-writing it to an append-only log
    // makes the mistake permanent.
    if checked.rejected() > 0 {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": "E_OP_REJECTED",
                "message": format!("{} of {} ops are not well-formed; nothing was appended",
                                   checked.rejected(), checked.verdicts.len()),
                "ops": checked.report(),
            })),
        );
    }
    let record = json!({
        "parent": checked.parent,
        "author": checked.author.sub,
        "author_email": checked.author.email,
        "surface": checked.surface,
        "canonical": checked.canonical,
    });
    match s.log.append(&record) {
        Ok(offset) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "queued": true,
                "log_offset": offset,
                "admissible_ops": checked.admissible(),
                "queued_ops": checked.queued(),
                "ops": checked.report(),
                "canonical": checked.canonical,
                // Named, not omitted: a caller that expected an id should find out
                // why there isn't one rather than read `null` as a bug.
                "address": Value::Null,
                "address_computed_by": "the door, in the build — this plugin has no hash primitive",
            })),
        ),
        Err(why) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "E_LOG_APPEND", "message": why })),
        ),
    }
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
            "admissible_ops": checked.admissible(),
            "queued_ops": checked.queued(),
            "rejected_ops": checked.rejected(),
            "ops": checked.report(),
            "canonical": checked.canonical,
            // Context, not consequence: the infeasibilities that already exist as of
            // the last emit. If an op you are about to submit lands on one of these
            // quantities, that is worth seeing before you submit it.
            "known_empty_envelopes": known,
            "limits": [
                "structural only — op vocabulary, required fields, enumerated values, capability",
                "does NOT evaluate the coherence gates; the empty-envelope check is a build-time SPARQL aggregate",
                "does NOT verify `parent` names a real bitemporal read point",
                "no content address — see `address_computed_by` on POST /proposal",
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
        serve_with(readmodel_dir, log, None).await
    }

    /// The same, plus a dispatch log — its own parameter rather than a third
    /// positional on every existing call site.
    async fn serve_with(
        readmodel_dir: &str,
        log: Option<&str>,
        dispatch_log: Option<&str>,
    ) -> String {
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
        let dispatches = Arc::new(ProposalLog::new(dispatch_log.map(std::path::PathBuf::from)));
        let app = router(
            HttpState {
                backend,
                readmodel,
                log,
                evaluations,
                dispatches,
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
    async fn a_write_without_a_principal_is_refused() {
        let addr = serve(&readmodel_fixture(), None).await;
        let payload = r#"{"parent":"p","ops":[{"op":"retractNS","subject":"s","reason":"r"}]}"#;
        let (status, body) = request(&addr, "POST", "/proposal", Some(("", payload))).await;
        assert_eq!(status, 401, "{body}");
        assert!(body.contains("E_NO_PRINCIPAL"), "{body}");
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
    async fn a_write_is_refused_when_the_log_is_unset_and_appended_when_it_is_set() {
        let payload = r#"{"parent":"p","ops":[{"op":"retractNS","subject":"s","reason":"r"}]}"#;
        let hdr = "x-fastverk-user-sub: u-1\r\n";

        let addr = serve(&readmodel_fixture(), None).await;
        let (status, body) = request(&addr, "POST", "/proposal", Some((hdr, payload))).await;
        assert_eq!(status, 503, "{body}");
        assert!(body.contains("E_WRITE_DISABLED"), "{body}");

        let dir = std::env::temp_dir().join(format!("spec-proposal-{}", std::process::id()));
        let log = dir.join("proposals.jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        let addr = serve(&readmodel_fixture(), Some(log.to_str().unwrap())).await;
        let (status, body) = request(&addr, "POST", "/proposal", Some((hdr, payload))).await;
        assert_eq!(status, 202, "{body}");
        let v: Value = serde_json::from_str(&body).expect(&body);
        assert_eq!(v["queued"], json!(true));
        assert_eq!(v["address"], Value::Null, "no address may be minted here: {body}");
        let written = std::fs::read_to_string(&log).unwrap();
        assert_eq!(written.lines().count(), 1, "one line per proposal: {written}");
        assert!(written.contains("\"author\":\"u-1\""), "{written}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_malformed_op_is_rejected_and_nothing_is_appended() {
        let dir = std::env::temp_dir().join(format!("spec-reject-{}", std::process::id()));
        let log = dir.join("proposals.jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        let addr = serve(&readmodel_fixture(), Some(log.to_str().unwrap())).await;
        let payload = r#"{"parent":"p","ops":[{"op":"promote","subject":"s","rung":"R9","evidence":"e"}]}"#;
        let hdr = "x-fastverk-user-sub: u-1\r\n";
        let (status, body) = request(&addr, "POST", "/proposal", Some((hdr, payload))).await;
        assert_eq!(status, 422, "{body}");
        assert!(body.contains("E_OP_REJECTED"), "{body}");
        assert!(!log.exists(), "a rejected proposal must not touch the log");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_flat_form_submission_is_accepted_on_the_op_route() {
        let dir = std::env::temp_dir().join(format!("spec-flat-{}", std::process::id()));
        let log = dir.join("proposals.jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        let addr = serve(&readmodel_fixture(), Some(log.to_str().unwrap())).await;
        // Exactly what renderFormPanelInto POSTs: flat, and every value a string.
        let payload = concat!(
            r#"{"parent":"p","op":"assertNS","subject":"fire-soc-cap","#,
            r#""text":"MUST NOT exceed 70 MW","discipline":"fire & life safety","#,
            r#""rung":"R4","quantity":"q-sustained-discharge","bound_kind":"UpperBound","#,
            r#""bound_value":"70","defeasible":"false","guard":""}"#
        );
        let hdr = "x-fastverk-user-sub: u-1\r\n";
        let (status, body) = request(&addr, "POST", "/proposal/op", Some((hdr, payload))).await;
        assert_eq!(status, 202, "{body}");
        let v: Value = serde_json::from_str(&body).expect(&body);
        assert_eq!(v["admissible_ops"], json!(1));
        // The canonical bytes must carry the COERCED types, not the form's strings —
        // otherwise the content address would differ from the same op submitted as
        // real JSON, and click- and API-authored changes would stop being identical.
        let canon = v["canonical"].as_str().expect(&body);
        assert!(canon.contains(r#""bound_value":70.0"#), "{canon}");
        assert!(canon.contains(r#""defeasible":false"#), "{canon}");
        assert!(!canon.contains("guard"), "a blank input must not be recorded: {canon}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_flat_submission_that_will_not_coerce_is_a_400() {
        let dir = std::env::temp_dir().join(format!("spec-flatbad-{}", std::process::id()));
        let log = dir.join("proposals.jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        let addr = serve(&readmodel_fixture(), Some(log.to_str().unwrap())).await;
        let payload = concat!(
            r#"{"parent":"p","op":"assertNS","subject":"s","text":"t","#,
            r#""discipline":"d","rung":"R4","bound_value":"seventy"}"#
        );
        let hdr = "x-fastverk-user-sub: u-1\r\n";
        let (status, body) = request(&addr, "POST", "/proposal/op", Some((hdr, payload))).await;
        assert_eq!(status, 400, "{body}");
        assert!(body.contains("E_MALFORMED_FORM"), "{body}");
        assert!(!log.exists(), "a malformed form must not touch the log");
        let _ = std::fs::remove_dir_all(&dir);
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

    // ── Fanout: the dispatch door over HTTP (#45) ───────────────────────────
    //
    // `workorder.rs` proves the gate's logic against payloads it builds
    // itself; these prove the ROUTE — that the door is reachable, that it
    // reads the committed payload, that a refusal appends nothing, and that
    // the two principal rules hold at the edge where a caller actually is.

    /// A readmodel dir carrying one READY and one HELD order, so the dispatch
    /// path can be exercised without depending on how ampere happens to be
    /// adjudicated today.
    fn workorders_fixture(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("spec-wo-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("workorders.json"),
            serde_json::to_vec_pretty(&json!({
                "orders": [
                    {
                        "order_id": "wo-ready",
                        "scope": "s-ready",
                        "obligation_count": 3,
                        "state": "READY",
                        "state_code": "WORK_ORDER_STATE_READY",
                        "agents": 0,
                        "order": {
                            "order_id": "wo-ready",
                            "scope": "s-ready",
                            "as_of": "sha256:0000000000000001",
                            "conflict_holds": [],
                            "write_capability": { "artifact_paths": ["src/ready/**"] }
                        }
                    },
                    {
                        "order_id": "wo-held",
                        "scope": "s-held",
                        "obligation_count": 5,
                        "state": "HELD · INV-03",
                        "state_code": "WORK_ORDER_STATE_HELD",
                        "agents": 0,
                        "order": {
                            "order_id": "wo-held",
                            "scope": "s-held",
                            "as_of": "sha256:0000000000000001",
                            "conflict_holds": ["INV-03"],
                            "write_capability": { "artifact_paths": ["src/held/**"] }
                        }
                    }
                ],
                "unreachable_repos": []
            }))
            .unwrap(),
        )
        .unwrap();
        dir
    }

    async fn dispatch(addr: &str, sub: &str, body: Value) -> (u16, Value) {
        let payload = body.to_string();
        let hdr = format!(
            "x-fastverk-user-sub: {sub}\r\nx-fastverk-user-email: d.okafor@example.com\r\n"
        );
        let (status, raw) = request(
            addr,
            "POST",
            "/workorder/dispatch",
            Some((hdr.as_str(), payload.as_str())),
        )
        .await;
        (status, serde_json::from_str(&raw).unwrap_or(Value::Null))
    }

    async fn get_json(addr: &str, path: &str) -> Value {
        let (status, raw) = request(addr, "GET", path, None).await;
        assert_eq!(status, 200, "GET {path} -> {status}: {raw}");
        serde_json::from_str(&raw).expect(&raw)
    }

    #[tokio::test]
    async fn workorders_answers_with_its_rows_field() {
        let dir = workorders_fixture("list");
        let addr = serve(dir.to_str().unwrap(), None).await;
        let body = get_json(&addr, "/workorders").await;
        let rows = body["orders"].as_array().expect("rows_field `orders`");
        assert_eq!(rows.len(), 2);
        assert_eq!(body["dispatch_enabled"], json!(false));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_dispatch_without_a_principal_is_refused() {
        let dir = workorders_fixture("noprincipal");
        let addr = serve(dir.to_str().unwrap(), None).await;
        let payload = json!({ "order_id": "wo-ready" }).to_string();
        let (status, _raw) =
            request(&addr, "POST", "/workorder/dispatch", Some(("", payload.as_str()))).await;
        assert_eq!(status, 401);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_agent_may_not_dispatch() {
        let dir = workorders_fixture("agent");
        let log = dir.join("dispatch.jsonl");
        let addr = serve_with(dir.to_str().unwrap(), None, log.to_str()).await;
        let (status, body) = dispatch(&addr, "agent:a-7714", json!({"order_id": "wo-ready"})).await;
        assert_eq!(status, 403, "{body}");
        assert_eq!(body["error"], "E_AGENT_MAY_NOT_DISPATCH");
        // And nothing was written.
        assert!(!log.exists() || std::fs::read_to_string(&log).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_held_order_is_refused_and_nothing_is_appended() {
        let dir = workorders_fixture("held");
        let log = dir.join("dispatch.jsonl");
        let addr = serve_with(dir.to_str().unwrap(), None, log.to_str()).await;
        let (status, body) = dispatch(&addr, "google:d.okafor", json!({"order_id": "wo-held"})).await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(body["verdict"], "DISPATCH_VERDICT_REFUSED_HELD");
        assert_eq!(body["because"], json!(["INV-03"]));
        assert!(!log.exists() || std::fs::read_to_string(&log).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_ready_order_dispatches_once_and_then_reads_running() {
        let dir = workorders_fixture("ready");
        let log = dir.join("dispatch.jsonl");
        let addr = serve_with(dir.to_str().unwrap(), None, log.to_str()).await;

        let (status, body) =
            dispatch(&addr, "google:d.okafor", json!({"order_id": "wo-ready", "agents": 2})).await;
        assert_eq!(status, 202, "{body}");
        assert_eq!(body["verdict"], "DISPATCH_VERDICT_DISPATCHED");
        assert_eq!(body["as_of"], "sha256:0000000000000001");

        // The record names who authorized it and at which cursor.
        let written = std::fs::read_to_string(&log).unwrap();
        let rec: Value = serde_json::from_str(written.lines().next().unwrap()).unwrap();
        assert_eq!(rec["order_id"], "wo-ready");
        assert_eq!(rec["author"], "d.okafor@example.com");
        assert_eq!(rec["agents"], 2);

        // The list route overlays RUNNING from the log — the state the build
        // could not compute, because the build cannot see dispatches.
        let listed = get_json(&addr, "/workorders").await;
        let ready = listed["orders"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["order_id"] == "wo-ready")
            .unwrap()
            .clone();
        assert_eq!(ready["state_code"], "WORK_ORDER_STATE_RUNNING");
        assert_eq!(ready["state"], "RUNNING · 2 agents");

        // And it will not re-arm.
        let (status, body) =
            dispatch(&addr, "google:d.okafor", json!({"order_id": "wo-ready"})).await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(body["verdict"], "DISPATCH_VERDICT_REFUSED_ALREADY_RUNNING");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn dispatch_is_disabled_when_the_log_is_unset() {
        let dir = workorders_fixture("nolog");
        let addr = serve(dir.to_str().unwrap(), None).await;
        let (status, body) = dispatch(&addr, "google:d.okafor", json!({"order_id": "wo-ready"})).await;
        assert_eq!(status, 503, "{body}");
        assert_eq!(body["error"], "E_WRITE_DISABLED");
        std::fs::remove_dir_all(&dir).ok();
    }

}
