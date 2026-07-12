//! Build script — prost codegen for `spec.v1` (message types only; v1 is
//! HTTP-only so no gRPC service code is generated — the `service SpecIndex` block
//! in the proto is the canonical contract for the deferred nav/gRPC plane).
//!
//! Paths are relative to the crate manifest dir (services/spec), which is the
//! build-script CWD under BOTH `cargo` and Bazel's `cargo_build_script` — so
//! `../../proto/...` resolves to the repo's proto tree either way (Bazel stages
//! the `proto_data` label at that exec-root-relative path). `$PROTOC` (set by the
//! macro to the hermetic protoc under Bazel; unset under cargo → protoc on PATH)
//! is honored by prost-build automatically.

fn main() {
    prost_build::Config::new()
        .compile_protos(&["../../proto/spec/v1/spec.proto"], &["../../proto"])
        .expect("prost compile spec.v1");
    println!("cargo:rerun-if-changed=../../proto/spec/v1/spec.proto");
}
