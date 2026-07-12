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

use std::sync::Arc;

use axum::extract::{Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::json as spec_json;
use crate::proto::SpecLang;
use crate::SpecBackend;

/// Shared state for the facade: the estate indexer + the optional panel bytes.
#[derive(Clone)]
pub struct HttpState {
    pub backend: Arc<SpecBackend>,
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
            "services": [{ "name": "spec.v1.SpecIndex" }],
            "runtime": "RUNTIME_SIDECAR",
            "lifecycle": "LIFECYCLE_ON_DEMAND",
            "privilege": "PRIVILEGE_USER",
            "panels": [{ "bundle_path": "panels.binpb", "adhoc_handler_ids": [] }],
            "server_services": [{ "name": "spec.v1.SpecIndex" }],
            // The web-plane routes the shell's RPC invoker resolves for this
            // plugin's panels (populate service/method -> REST path).
            "web_routes": [
                { "service": "spec.v1.SpecIndex", "method": "ListSpecs",        "http_method": "GET", "path": "specs" },
                { "service": "spec.v1.SpecIndex", "method": "ListContracts",    "http_method": "GET", "path": "contracts" },
                { "service": "spec.v1.SpecIndex", "method": "ListModuleStatus", "http_method": "GET", "path": "status" },
                { "service": "spec.v1.SpecIndex", "method": "GetSpec",          "http_method": "GET", "path": "spec" },
                { "service": "spec.v1.SpecIndex", "method": "GetContract",      "http_method": "GET", "path": "contract" },
            ],
        },
        "healthy": true,
    })
}

/// Build the facade router. Mounted at the root of the plugin's own service (the
/// shell prefixes `/api/gw/spec`). `/healthz` is open; everything else is behind
/// the gateway-token guard when `$FASTVERK_PLUGIN_TOKEN` is set.
pub fn router(state: HttpState, gateway_token: Option<String>) -> Router {
    let guarded = Router::new()
        .route("/describe", get(describe))
        .route("/panels.binpb", get(panels))
        .route("/specs", get(list_specs))
        .route("/contracts", get(list_contracts))
        .route("/status", get(list_module_status))
        .route("/spec", get(get_spec))
        .route("/contract", get(get_contract))
        .with_state(state);
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
