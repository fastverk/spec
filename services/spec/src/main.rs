//! spec-server — the spec plugin backend.
//!
//! Two planes over two sources:
//!   * HTTP/JSON facade on `$PORT_ADDR` (:8080) — the web plane the fastverk-web
//!     shell forwards to (`/api/gw/spec/*`): `/healthz`, `/describe`,
//!     `/panels.binpb`, the data routes, and the MCP tool surface (`/mcp`).
//!   * gRPC meridian `LayoutService` on `$SPEC_GRPC_ADDR` (:50056) — the plugin's
//!     nav subtree, so the console shell renders a proper section instead of the
//!     flat-leaf fallback. The leaf ids match the panel ids in ui/panels.textproto.
//!
//! The two sources are the estate **spec index** (`$SPEC_SOURCE_ROOT`, a scan of
//! the git-synced tree) and the RFC-002 **authoring read model**
//! (`$SPEC_READMODEL_DIR`, precomputed SPARQL results). Both are read-only. The one
//! write surface — `POST /proposal` — appends to `$SPEC_PROPOSAL_LOG` and is
//! disabled unless that is set; it queues rather than admits, because the door that
//! admits runs in the build (see `spec::proposal`).
//!
//! Both planes run concurrently; if either exits, the process exits. No outbound
//! network.

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

    // The RFC-002 authoring read model: precomputed SPARQL results served as files
    // (the build computes, the plugin serves — see spec::readmodel).
    let readmodel = Arc::new(spec::readmodel::ReadModel::from_env(backend.source_root()));
    tracing::info!(dir = %readmodel.dir().display(), "authoring read model directory");
    for r in readmodel.status()["routes"].as_array().into_iter().flatten() {
        tracing::info!(
            route = r["route"].as_str().unwrap_or(""),
            rows = r["rows"].as_u64().unwrap_or(0),
            available = r["available"].as_bool().unwrap_or(false),
            note = r["note"].as_str().unwrap_or(""),
            "read model route",
        );
    }

    // Fail LOUD at boot if a served authoring route isn't declared in /describe.
    // The alternative is discovering it as "no gateway route for
    // spec.v1.Authoring/…" in a browser console, which reads as a console bug.
    if let Err(why) = spec::readmodel::routes_match_describe(&spec::routes::describe_web_routes()) {
        tracing::error!(%why, "web_routes and the served read-model routes disagree");
    }

    let log = Arc::new(spec::proposal::ProposalLog::from_env());
    // A SEPARATE file. Replaying judgements and measurements from one log would
    // make "who decided this" and "what did it measure" the same question.
    let evaluations = Arc::new(spec::proposal::AppendLog::new(
        std::env::var("SPEC_EVALUATION_LOG")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from),
    ));
    // And a THIRD, for the same reason again: a dispatch is neither a
    // judgement nor a measurement — it authorizes writes to a path set. Unset
    // disables the dispatch route (503 naming the variable), which is the right
    // default for an instance nobody has decided may fan agents out.
    let dispatches = Arc::new(spec::proposal::AppendLog::new(
        std::env::var("SPEC_DISPATCH_LOG")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from),
    ));

    // The gate plane's client. Constructed unconditionally: whether the sidecar is
    // deployed is a fact about the pod, and the service reports it per-call
    // (FAILED_PRECONDITION naming $SPEC_GATE_ADDR) rather than by being absent
    // from the server — an UNIMPLEMENTED would say this build cannot gate, which
    // is a different and untrue thing.
    //
    // ⚠ No boot-time probe. The JVM beside us is still parsing its corpus while
    // this line runs, so a probe here would report a healthy sidecar as absent for
    // the first few seconds and log a warning that is wrong more often than right.
    let gate = Arc::new(spec::gate::GateClient::from_env());
    match gate.addr() {
        Some(addr) => tracing::info!(%addr, project = gate.serves_project().unwrap_or("<unset>"),
                                     "gate plane configured (spec.v1.Derivation)"),
        None => tracing::info!(
            "no gate sidecar ({} unset); spec.v1.Derivation will report FAILED_PRECONDITION",
            spec::gate::GATE_ADDR_ENV
        ),
    }

    let panels = load_panels(args.panel_bundle);
    let gateway_token = std::env::var("FASTVERK_PLUGIN_TOKEN").ok();
    let http = spec::http::router(
        spec::http::HttpState {
            backend,
            readmodel,
            log,
            evaluations,
            dispatches,
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
                    // The RFC-002 authoring plane. Flat leaves, not a `group`:
                    // `leaf` is the only constructor this plugin's pinned
                    // fastverk-layout tag is known to carry, and nine leaves read
                    // fine. Grouping is a follow-up, not a prerequisite.
                    //
                    // Order is deliberate — the three shipped index leaves keep
                    // their positions, then the authoring surfaces in the order
                    // they are actually used: what is in conflict, what is
                    // infeasible, what is stalled, who owns what. Claims is LAST:
                    // with thousands of them a flat list is the least useful
                    // surface, and the point of the four above it is that you
                    // rarely need it.
                    fastverk_layout::leaf("conflicts", "Conflicts"),
                    fastverk_layout::leaf("envelopes", "Envelopes"),
                    fastverk_layout::leaf("frontier", "Frontier"),
                    fastverk_layout::leaf("disciplines", "Disciplines"),
                    fastverk_layout::leaf("witness", "Witnesses"),
                    fastverk_layout::leaf("claims", "Claims"),
                    fastverk_layout::leaf("requirements", "Requirements"),
                    fastverk_layout::leaf("workorders", "Fanout"),
                ])
                .with_panels(panels)
                .into_server(),
            )
            // The gate plane (RFC-006 §5). Same server as the nav plane: one
            // gRPC port, two services, and the ALB target group that will front
            // it does not need to learn a second one.
            .add_service(spec::derivation::DerivationService::new(gate).into_server())
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
