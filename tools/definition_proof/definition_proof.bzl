"""Source-only kernel checking as an actual dependency of consumer artifacts."""

def _definition_proof_impl(ctx):
    tc = ctx.toolchains["@rules_lean//lean:toolchain_type"].leantc
    output = ctx.actions.declare_file(ctx.label.name + ".pb")
    args = ctx.actions.args()
    args.add("--request", ctx.file.request)
    args.add("--review", ctx.file.review)
    args.add("--schema", ctx.file._schema)
    args.add("--lean", tc.lean)
    args.add("--output", output)
    for source in ctx.files.srcs:
        args.add("--input", source.short_path + "=" + source.path)
    ctx.actions.run(
        executable = ctx.executable._verifier,
        arguments = [args],
        inputs = depset([ctx.file.request, ctx.file.review, ctx.file._schema, tc.lean] + ctx.files.srcs,
                        transitive = [tc.runtime]),
        tools = [ctx.attr._verifier[DefaultInfo].files_to_run],
        outputs = [output],
        mnemonic = "VerifiedDefinitionProof",
        progress_message = "Kernel-checking reviewed definition proof %s" % ctx.label,
    )
    return [DefaultInfo(files = depset([output]))]

definition_proof = rule(
    implementation = _definition_proof_impl,
    attrs = {
        "request": attr.label(mandatory = True, allow_single_file = True),
        "review": attr.label(mandatory = True, allow_single_file = True),
        "srcs": attr.label_list(allow_files = True),
        "_schema": attr.label(default = Label("//proto/spec/v1:definition_proof.proto"), allow_single_file = True),
        "_verifier": attr.label(default = Label("//tools/definition_proof:verify"), executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_lean//lean:toolchain_type"],
)

def _controls_impl(ctx):
    tc = ctx.toolchains["@rules_lean//lean:toolchain_type"].leantc
    marker = ctx.actions.declare_file(ctx.label.name + ".checked")
    args = ctx.actions.args()
    args.add("--lean", tc.lean)
    args.add("--schema", ctx.file._schema)
    args.add("--output", marker)
    ctx.actions.run(
        executable = ctx.executable._controls,
        arguments = [args],
        inputs = depset([tc.lean, ctx.file._schema], transitive = [tc.runtime]),
        tools = [ctx.attr._controls[DefaultInfo].files_to_run],
        outputs = [marker],
        mnemonic = "DefinitionProofControls",
    )
    runner = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(runner, "#!/bin/sh\nexit 0\n", is_executable = True)
    return [DefaultInfo(executable = runner, runfiles = ctx.runfiles(files = [marker]))]

definition_proof_controls_test = rule(
    implementation = _controls_impl,
    test = True,
    attrs = {
        "_controls": attr.label(default = Label("//tools/definition_proof:kernel_controls"), executable = True, cfg = "exec"),
        "_schema": attr.label(default = Label("//proto/spec/v1:definition_proof.proto"), allow_single_file = True),
    },
    toolchains = ["@rules_lean//lean:toolchain_type"],
)
