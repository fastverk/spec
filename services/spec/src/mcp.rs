//! mcp — spec's MCP tool surface (`POST /api/gw/spec/mcp`).
//!
//! Exposes the estate spec index as read-only MCP tools so the console chat host
//! can answer questions like "which contracts are uncited?" or "what carries
//! sorries?". The chat host discovers any plugin that serves `/mcp` and unions its
//! `tools/list`, so this needs no chat-host changes.
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
use crate::SpecBackend;

/// Per-request context: just the shared index backend (no per-user credential).
pub struct Ctx {
    backend: Arc<SpecBackend>,
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
pub fn router(backend: Arc<SpecBackend>) -> Router {
    McpServer::new("spec", env!("CARGO_PKG_VERSION"), move |_headers: &HeaderMap| {
        Arc::new(Ctx {
            backend: backend.clone(),
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
    .router()
}
