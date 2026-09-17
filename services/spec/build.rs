//! Build script — prost codegen for `spec.v1` (message types only for the web
//! plane; v1 is HTTP-only, so the `service SpecIndex` block in the proto stays the
//! canonical contract for the deferred nav plane and generates no code) plus tonic
//! SERVER stubs for `spec.v1.Derivation`, which this crate does implement.
//!
//! Paths are relative to the crate manifest dir (services/spec), which is the
//! build-script CWD under BOTH `cargo` and Bazel's `cargo_build_script` — so
//! `../../proto/...` resolves to the repo's proto tree either way (Bazel stages
//! the `proto_data` label at that exec-root-relative path). `$PROTOC` (set by the
//! macro to the hermetic protoc under Bazel; unset under cargo → protoc on PATH)
//! is honored by prost-build automatically.
//!
//! ⛔ TWO CODEGEN PASSES, TWO OUTPUT DIRECTORIES, AND THAT IS NOT STYLE.
//! prost names its output after the proto PACKAGE, not the file. Every proto here
//! is `package spec.v1`, so both passes want to write `spec.v1.rs` and the second
//! silently overwrites the first — a build that succeeds and a crate that has lost
//! either its message types or its service. The failure is a "cannot find type"
//! miles from its cause. `derivation` therefore gets its own `OUT_DIR/derivation/`
//! and `lib.rs` includes the two separately.
//!
//! Compiling derivation.proto in the FIRST pass instead would avoid that, and cost
//! more: tonic-build emits a server for every service in the files it is given, so
//! `SpecIndex` and `GroundingAdapter` would grow server traits nobody implements —
//! generated code asserting a plane exists when it does not.

use std::path::PathBuf;

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

    // The gate plane's contract, with a server. `build_client(false)` because
    // nothing in this process calls Derivation — it IS the implementation, and a
    // generated client here would be a caller that does not exist.
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("derivation");
    std::fs::create_dir_all(&out).expect("create derivation OUT_DIR");
    tonic_build::configure()
        .build_client(false)
        .build_server(true)
        .out_dir(&out)
        .compile_protos(&["../../proto/spec/v1/derivation.proto"], &["../../proto"])
        .expect("tonic compile spec.v1.Derivation");

    for p in [
        "../../proto/spec/v1/spec.proto",
        "../../proto/spec/v1/invariant.proto",
        "../../proto/spec/v1/grounding_adapter.proto",
        "../../proto/spec/v1/derivation.proto",
    ] {
        println!("cargo:rerun-if-changed={p}");
    }
}
