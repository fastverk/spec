//! spec-server — the spec plugin backend (HTTP-only, read-only).
//!
//! Serves `/api/gw/spec/*` for the fastverk-web shell: the meridian PanelBundle
//! (`/panels.binpb`) + manifest (`/describe`) + the estate spec index data routes
//! (`/specs`, `/contracts`, `/status`, …). No gRPC/nav plane in v1 (that needs the
//! fastverk-layout crate) and no outbound network — the index is a scan of the
//! git-synced source tree at `$SPEC_SOURCE_ROOT`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "spec-server", about = "fastverk spec (formal-specs index) plugin backend")]
struct Args {
    /// HTTP/JSON facade bind address (the in-cluster Service / gateway forwards here).
    #[arg(long, default_value = "0.0.0.0:8080", env = "PORT_ADDR")]
    http_addr: String,

    /// Path to the compiled meridian PanelBundle (.binpb). Defaults to the bazel
    /// runfiles location populated by `//services/spec/ui:panels`; set explicitly
    /// for `cargo run`.
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

    let backend = Arc::new(spec::SpecBackend::from_env());
    tracing::info!(source_root = %backend.source_root().display(), "spec index source root");

    let panels = load_panels(args.panel_bundle);
    let gateway_token = std::env::var("FASTVERK_PLUGIN_TOKEN").ok();
    let app = spec::http::router(spec::http::HttpState { backend, panels }, gateway_token);

    tracing::info!(?http_addr, "starting spec-server (HTTP)");
    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;
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
        Some(_) => tracing::info!("loaded spec panel bundle; serving /panels.binpb"),
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
