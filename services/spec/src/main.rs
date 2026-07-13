//! spec-server — the spec plugin backend (read-only).
//!
//! Two planes over the same estate index:
//!   * HTTP/JSON facade on `$PORT_ADDR` (:8080) — the web plane the fastverk-web
//!     shell forwards to (`/api/gw/spec/*`): `/healthz`, `/describe`,
//!     `/panels.binpb`, the data routes, and the MCP tool surface (`/mcp`).
//!   * gRPC meridian `LayoutService` on `$SPEC_GRPC_ADDR` (:50056) — the plugin's
//!     nested nav (Specs / Contracts / Proof-Status), so the console shell renders
//!     a proper section subtree instead of the flat-leaf fallback. The leaf ids
//!     match the panel ids in ui/panels.textproto.
//!
//! Both run concurrently; if either exits, the process exits. No outbound network
//! — the index is a scan of the git-synced source tree at `$SPEC_SOURCE_ROOT`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "spec-server", about = "fastverk spec (formal-specs index) plugin backend")]
struct Args {
    /// HTTP/JSON facade bind address (the in-cluster Service / gateway forwards here).
    #[arg(long, default_value = "0.0.0.0:8080", env = "PORT_ADDR")]
    http_addr: String,

    /// Path to the compiled meridian PanelBundle (.binpb). Defaults to the bazel
    /// runfiles location; set explicitly (or via $SPEC_PANEL_BUNDLE) otherwise.
    #[arg(long, env = "SPEC_PANEL_BUNDLE")]
    panel_bundle: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let args = Args::parse();
    let http_addr: SocketAddr = args.http_addr.parse()?;
    let grpc_addr: SocketAddr = std::env::var("SPEC_GRPC_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:50056".to_string())
        .parse()?;

    let backend = Arc::new(spec::SpecBackend::from_env());
    tracing::info!(source_root = %backend.source_root().display(), "spec index source root");

    let panels = load_panels(args.panel_bundle);
    let gateway_token = std::env::var("FASTVERK_PLUGIN_TOKEN").ok();
    let http = spec::http::router(
        spec::http::HttpState {
            backend,
            panels: panels.clone(),
        },
        gateway_token,
    );

    tracing::info!(?http_addr, ?grpc_addr, "starting spec-server (HTTP + gRPC nav)");

    // The uniform plugin nav plane: spec's section subtree via
    // meridian.ui.v1.LayoutService.GetNavTree (shared fastverk-layout crate). The
    // leaf ids match ui/panels.textproto (specs / contracts / status).
    let grpc = async move {
        Server::builder()
            .add_service(
                fastverk_layout::StaticLayout::new(vec![
                    fastverk_layout::leaf("specs", "Specs"),
                    fastverk_layout::leaf("contracts", "Contracts"),
                    fastverk_layout::leaf("status", "Proof Status"),
                ])
                .with_panels(panels)
                .into_server(),
            )
            .serve(grpc_addr)
            .await
            .map_err(anyhow::Error::from)
    };
    let web = async move {
        let listener = tokio::net::TcpListener::bind(http_addr).await?;
        axum::serve(listener, http).await.map_err(anyhow::Error::from)
    };
    tokio::try_join!(grpc, web)?;
    Ok(())
}

/// Load the compiled panel bundle: the explicit `--panel-bundle` first, else the
/// bazel runfiles location `<exe>.runfiles/_main/services/spec/ui/panels.binpb`.
fn load_panels(explicit: Option<PathBuf>) -> Option<Arc<Vec<u8>>> {
    let panels = explicit
        .or_else(default_panel_bundle)
        .filter(|p| p.is_file())
        .and_then(|p| std::fs::read(p).ok())
        .map(Arc::new);
    match panels {
        Some(_) => tracing::info!("loaded spec panel bundle; serving /panels.binpb + LayoutService panels"),
        None => tracing::warn!("spec panel bundle not found; /panels.binpb will 404"),
    }
    panels
}

fn default_panel_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let runfiles = exe.with_extension("runfiles");
    let path = runfiles.join("_main/services/spec/ui/panels.binpb");
    path.is_file().then_some(path)
}
