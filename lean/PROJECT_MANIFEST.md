# Consumer-owned project manifest conventions

The legacy `projectManifestOf` function and AX-034 continue to name
`project.aion`. Gnomon requires `project.gnm`; equating those literals or
renaming the legacy conclusion would misstate one consumer's contract.

`Spec.ProjectManifest` adds an explicit nonempty `ProjectManifestConvention`
and `projectManifestFor convention module`. Its two theorems prove the exact
selected name and nonemptiness by structural projection, without new axioms.
A consumer owns the convention value and must use the parameterized function
explicitly. No overload changes an existing call's meaning.

These theorems describe a constructed formal manifest. They do not establish
that a file exists, the parser accepts it, the compiler uses it, its contents
are valid, or any backend realizes the model. Existing semantic mismatch and
release gates still apply. `project_manifest_test` checks independent names,
invalid empty-name rejection, cross-convention proof rejection, and the
unchanged legacy conclusion; `spec_framework_test` includes those controls.
