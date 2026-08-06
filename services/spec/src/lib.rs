//! spec — an estate-wide, live index of formal specifications for the fastverk console.
//!
//! A read-only BFF: it scans a git-synced source tree (`$SPEC_SOURCE_ROOT`) for
//! every repo's formal specs (Lean today) and serves three console tables —
//! **Specs** (every spec file + its verifying Bazel target + green/`sorry` status),
//! **Contracts** (a repo's contract catalog with live discharge/citation status;
//! botnoc-only in v1), and **Proof Status** (per-module rollup). The gRPC
//! `spec.v1.SpecIndex` service is the canonical contract; this is the HTTP
//! projection the fastverk-web shell forwards to (`/api/gw/spec/*`), mirroring the
//! forge / compliance plugins.
//!
//! It reuses botnoc's own authoritative checks over source: the `grep sorry` green
//! sweep (botnoc `lean/BUILD.bazel`) and the `Discharges: <id>` citation walk
//! (botnoc `tests/contracts_cited`). "Live" is bounded by the git-sync period; a
//! short-TTL in-memory index cache keeps a full-estate scan off the hot path. The
//! scanner is deliberately resilient to in-flight Bazel/Lean layout: it lists every
//! `.lean` file even when its `lean_test`/`lean_emit` target is mid-migration
//! (`kind`/`target` just fall blank).

pub mod backend;
pub mod http;
pub mod json;
pub mod mcp;
pub mod proposal;
pub mod readmodel;
pub mod routes;

/// The canonical gRPC service name for the RFC-002 authoring plane. The read model
/// and the proposal routes are its HTTP projection, exactly as `spec.v1.SpecIndex`
/// is the read-only index's — so a panel's `populate.service` and a form's
/// `submit.service` resolve through the same `web_routes` mechanism.
pub const AUTHORING_SERVICE: &str = "spec.v1.Authoring";

/// prost-generated `spec.v1` message types (messages only; v1 is HTTP-only).
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/spec.v1.rs"));
}

pub use backend::SpecBackend;
