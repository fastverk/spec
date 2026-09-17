//! mcp — spec's MCP tool surface (`POST /api/gw/spec/mcp`).
//!
//! Exposes the estate spec index as read-only MCP tools so the console chat host
//! can answer questions like "which contracts are uncited?" or "what carries
//! sorries?". The chat host discovers any plugin that serves `/mcp` and unions its
//! `tools/list`, so this needs no chat-host changes.
//!
//! Seven tools: three over the spec index, four over the RFC-002 authoring read
//! model (`list_conflicts` / `list_empty_envelopes` / `frontier` /
//! `list_work_orders`). The authoring four
//! are the grounding half of RFC-002 §9's chat loop — a model cannot ask "does this
//! contradict anything" without them, and the write half (`preview_proposal` /
//! `submit_proposal`) is deliberately NOT here: `POST /proposal` is a mutation
//! behind the confirm-gated pattern `plugin-chat` already implements, and exposing
//! it as an MCP tool is P5 work, not a side effect of shipping the reads.
//!
//! Non-per-user context (like tbzl): the index is a shared read-only view of the
//! synced source tree, so there is no per-request token — the context factory just
//! hands each tool the shared backend.

use std::sync::Arc;

use axum::http::HeaderMap;
use axum::Router;
use fastverk_mcp::{McpServer, ToolFuture};
use serde_json::{json, Value};

use crate::json as spec_json;
use crate::readmodel::ReadModel;
use crate::SpecBackend;

/// Per-request context: the shared index backend + the authoring read model (no
/// per-user credential — both are read-only shared views).
pub struct Ctx {
    backend: Arc<SpecBackend>,
    readmodel: Arc<ReadModel>,
}

/// Read a CSV-or-array argument as `Vec<String>` (a JSON array of strings or a
/// single comma-separated string).
fn str_list(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Some(Value::String(s)) => s
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    }
}

/// A JSON-schema `array<string>` property with a description.
fn str_array(desc: &str) -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": desc })
}

/// Build spec's `POST /mcp` router with its read-only tools.
pub fn router(backend: Arc<SpecBackend>, readmodel: Arc<ReadModel>) -> Router {
    McpServer::new("spec", env!("CARGO_PKG_VERSION"), move |_headers: &HeaderMap| {
        Arc::new(Ctx {
            backend: backend.clone(),
            readmodel: readmodel.clone(),
        })
    })
    .tool(
        "list_specs",
        "List formal-spec files across the estate — each with its repo, module, \
         path, language, verifying Bazel target (lean_test/lean_emit), proof status \
         (GREEN/SORRY), and open-obligation (`sorry`) count. Read-only.",
        json!({
            "type": "object",
            "properties": {
                "repos": str_array("Repo names to include (e.g. botnoc, agora). Empty = all indexed repos."),
                "kinds": str_array("Bazel rule kinds to include (lean_test, lean_emit). Empty = all."),
            },
        }),
        |args, ctx: Arc<Ctx>| -> ToolFuture {
            Box::pin(async move {
                let repos = str_list(&args, "repos");
                let kinds = str_list(&args, "kinds");
                let b = ctx.backend.clone();
                let (specs, unreachable) =
                    tokio::task::spawn_blocking(move || b.list_specs(&repos, &[], &kinds)).await?;
                Ok(spec_json::list_specs_response(specs, unreachable))
            })
        },
    )
    .tool(
        "list_contracts",
        "List contract-catalog rows — theorem-backed promises with their id, \
         theorem name, promise text, discharging handler, live citation status \
         (whether a `Discharges: <id>` comment names it in code), and the theorem \
         module's proof status. Set only_uncited=true to surface promises whose \
         discharger is set but that are NOT cited in code (unverified). Read-only.",
        json!({
            "type": "object",
            "properties": {
                "repos": str_array("Repo names to include. Empty = all (botnoc carries the catalog today)."),
                "only_uncited": { "type": "boolean", "description": "Only contracts with a discharger set but no citation found." },
            },
        }),
        |args, ctx: Arc<Ctx>| -> ToolFuture {
            Box::pin(async move {
                let repos = str_list(&args, "repos");
                let only_uncited = args.get("only_uncited").and_then(Value::as_bool).unwrap_or(false);
                let b = ctx.backend.clone();
                let (contracts, unreachable) =
                    tokio::task::spawn_blocking(move || b.list_contracts(&repos, only_uncited)).await?;
                Ok(spec_json::list_contracts_response(contracts, unreachable))
            })
        },
    )
    .tool(
        "module_status",
        "Per-module proof status across the estate: each module's verifying \
         lean_test target, status (GREEN/SORRY), open-`sorry` count, and number of \
         spec files. Read-only.",
        json!({
            "type": "object",
            "properties": {
                "repos": str_array("Repo names to include. Empty = all."),
            },
        }),
        |args, ctx: Arc<Ctx>| -> ToolFuture {
            Box::pin(async move {
                let repos = str_list(&args, "repos");
                let b = ctx.backend.clone();
                let (modules, unreachable) =
                    tokio::task::spawn_blocking(move || b.list_module_status(&repos)).await?;
                Ok(spec_json::list_module_status_response(modules, unreachable))
            })
        },
    )
    // ── the RFC-002 authoring read model ─────────────────────────────────────
    //
    // These three are what make the chat authoring loop possible at all. RFC-002 §9
    // has the model ground an intent against the corpus before proposing ops; it can
    // only do that if it can *see* what is already in conflict, what is already
    // infeasible, and what is already stalled. Without them the model's only source
    // for "does this contradict anything" is the prose it was pasted, which is the
    // failure mode the whole system exists to remove.
    //
    // Read-only, precomputed, and no argument: the same six payloads the browser
    // panels bind to. A chat-authored and a click-authored change therefore start
    // from byte-identical grounding — which is what RFC-002 §9.1's equal-citizen
    // property means on the read side.
    .tool(
        "list_conflicts",
        "List recorded cross-discipline conflicts in the spec corpus — each with its \
         kind, the disciplines involved, party count, how many work orders it blocks, \
         its owner, whether it is open or adjudicated, and the outcome if adjudicated. \
         An OPEN conflict is a legitimate steady state, not a failure. Read-only.",
        json!({ "type": "object", "properties": {} }),
        |_args, ctx: Arc<Ctx>| -> ToolFuture {
            Box::pin(async move { Ok(read_route(ctx, "conflicts").await?) })
        },
    )
    .tool(
        "list_empty_envelopes",
        "List every typed quantity whose recorded bounds intersect to NOTHING — the \
         greatest lower bound exceeds the least upper bound — with the deficit and how \
         many disciplines contributed a bound. Each row is a joint infeasibility that \
         no single document states: every instrument is individually satisfiable. Use \
         this before proposing any bound on a quantity. `recorded: false` means no \
         conflict names it yet, which is a build-gate failure. Read-only.",
        json!({ "type": "object", "properties": {} }),
        |_args, ctx: Arc<Ctx>| -> ToolFuture {
            Box::pin(async move { Ok(read_route(ctx, "envelopes").await?) })
        },
    )
    .tool(
        "frontier",
        "List claims below R4 — the binding rung — each with the blocker it names and \
         how many claims depend on it. R0-R3 claims are explicitly NON-BINDING: agent \
         fanout may not use them as satisfaction evidence. This is the formalization \
         work queue. Read-only.",
        json!({ "type": "object", "properties": {} }),
        |_args, ctx: Arc<Ctx>| -> ToolFuture {
            Box::pin(async move { Ok(read_route(ctx, "frontier").await?) })
        },
    )
    // The fanout read. `mocks/ux/chat/03-agent-fanout.md` opens by calling this
    // tool by this name; #45 is where the name resolves to a payload.
    //
    // Read-only, like every tool here — `dispatch` is a MUTATION that
    // authorizes writes to a path set, and it is deliberately NOT an MCP tool:
    // the confirm-gated write pattern is P5 work, and a door that refuses an
    // agent principal (services/spec/src/workorder.rs) should not be reachable
    // from the surface an agent speaks through.
    .tool(
        "list_work_orders",
        "List the work orders derived from the corpus — each with its scope, how many          obligations its closure carries, which disciplines those bind, the artifact          paths it may write, and its state. HELD means a live conflict touches its          closure and it CANNOT dispatch until that conflict is adjudicated; the state          is computed from the corpus, never set by a person. READY means dispatchable          now. Obligations below R4 travel with the order marked non-binding, so a          mostly-dark closure is a legal and informative answer rather than an empty          one. Read-only.",
        json!({ "type": "object", "properties": {} }),
        |_args, ctx: Arc<Ctx>| -> ToolFuture {
            Box::pin(async move { Ok(read_route(ctx, "workorders").await?) })
        },
    )
    .router()
}

/// One read-model route, off the async runtime (it reads a file behind a TTL cache).
async fn read_route(ctx: Arc<Ctx>, route: &'static str) -> Result<Value, tokio::task::JoinError> {
    let rm = ctx.readmodel.clone();
    tokio::task::spawn_blocking(move || rm.route(route)).await
}
