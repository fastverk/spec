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
        .compile_protos(
            &[
                "../../proto/spec/v1/spec.proto",
                // The intent-grounding types. `invariant.proto` is what spec
                // PERSISTS; `grounding_adapter.proto` is the contract a project
                // implements so its terms can be grounded without its data ever
                // reaching here. Compiling both is also what proves the one-way
                // import boundary between them actually resolves —
                // //proto/spec/v1:data_boundary_test asserts it stays that way.
                "../../proto/spec/v1/invariant.proto",
                "../../proto/spec/v1/grounding_adapter.proto",
            ],
            &["../../proto"],
        )
        .expect("prost compile spec.v1");
    for p in [
        "../../proto/spec/v1/spec.proto",
        "../../proto/spec/v1/invariant.proto",
        "../../proto/spec/v1/grounding_adapter.proto",
    ] {
        println!("cargo:rerun-if-changed={p}");
    }
}
