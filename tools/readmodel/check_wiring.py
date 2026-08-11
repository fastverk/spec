#!/usr/bin/env python3
"""check_wiring — assert the six places that describe the authoring plane agree.

The RFC-002 authoring read model is described in six places, and every one of them
is a place a rename can be forgotten:

  1. tools/readmodel/emit_readmodel.py     the SPARQL -> JSON route table
  2. services/spec/readmodel/*.json        the emitted payloads (rows_field)
  3. services/spec/readmodel/describe.web_routes.json   the emitted /describe fragment
  4. services/spec/src/readmodel.rs        the Rust ROUTES table
  5. services/spec/src/routes.rs           describe_web_routes() (the declaration)
     …and services/spec/src/http.rs       the axum route table (the registration)
  6. services/spec/ui/panels.textproto     each panel's populate pair + rows_field
     …and services/spec/src/main.rs        the LayoutService nav leaves
     …and services/spec/ui/panels.binpb    the compiled bundle
  7. mocks/ux/panels.authoring-form.textproto  the declarative WRITE descriptors,
     whose submit bindings must name real fields and a real POST route

A mismatch between any two of them is invisible until a browser renders "no gateway
route for spec.v1.Authoring/ListEnvelopes" or a table full of blank cells. None of
those failures is caught by the compiler, and — because a panel binds by STRING —
none is caught by a type. So they are caught here.

    python3 tools/readmodel/check_wiring.py

Exits non-zero on any disagreement. Needs nothing but the standard library, which
is the point: it runs in CI, in a pre-commit hook, or on a laptop with no Bazel, no
Lean toolchain, and no crate registry access.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

EMITTER = "tools/readmodel/emit_readmodel.py"
READMODEL_DIR = "services/spec/readmodel"
DESCRIBE_FRAGMENT = f"{READMODEL_DIR}/describe.web_routes.json"
RS_READMODEL = "services/spec/src/readmodel.rs"
RS_HTTP = "services/spec/src/http.rs"
RS_ROUTES = "services/spec/src/routes.rs"
RS_MAIN = "services/spec/src/main.rs"
PANELS_TEXTPROTO = "services/spec/ui/panels.textproto"
PANELS_BINPB = "services/spec/ui/panels.binpb"
FORMS_TEXTPROTO = "mocks/ux/panels.authoring-form.textproto"

SERVICE = "spec.v1.Authoring"

failures = []
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        failures.append(msg)
    return cond


def read(rel):
    with open(os.path.join(ROOT, rel)) as fh:
        return fh.read()


# ── 1. the emitter's route table ──────────────────────────────────────────────
# Parsed rather than imported, so this script does not need rdflib installed.
emitter = read(EMITTER)
emit_routes = re.findall(
    r'\(\s*"([a-z_]+)",\s*"([a-z_]+)",\s*"(\w+)",\s*Q_\w+,\s*shape_\w+\s*\)', emitter
)
# A bare count is not redundant with the per-route checks below: those assert
# that whatever routes exist agree everywhere, and would stay green if a route
# were silently DELETED from all seven places at once. This is the tripwire that
# makes adding or removing one a deliberate edit. Bump it on purpose.
#
# 8 = concepts, disciplines, conflicts, frontier, measure, evaluations,
#     requirements, terms.
check(len(emit_routes) == 8, f"{EMITTER}: found {len(emit_routes)} routes, expected 8")
emit_by_path = {p: (rows, method) for p, rows, method in emit_routes}

emit_service = re.search(r'^SERVICE\s*=\s*"([^"]+)"', emitter, re.M)
check(
    emit_service and emit_service.group(1) == SERVICE,
    f"{EMITTER}: SERVICE is {emit_service and emit_service.group(1)!r}, expected {SERVICE!r}",
)

# ── 2. the emitted payloads ───────────────────────────────────────────────────
for path, (rows_field, _method) in emit_by_path.items():
    rel = f"{READMODEL_DIR}/{path}.json"
    if not check(os.path.isfile(os.path.join(ROOT, rel)), f"{rel}: missing payload"):
        continue
    payload = json.loads(read(rel))
    check(
        isinstance(payload.get(rows_field), list),
        f"{rel}: no `{rows_field}` array (keys: {sorted(payload)})",
    )
    check(
        isinstance(payload.get("unreachable_repos"), list),
        f"{rel}: no `unreachable_repos` array — the plugin's partial-result envelope",
    )

# ── 3. the emitted /describe fragment ─────────────────────────────────────────
fragment = json.loads(read(DESCRIBE_FRAGMENT))["web_routes"]
frag_by_path = {r["path"]: r for r in fragment}
check(
    set(frag_by_path) == set(emit_by_path),
    f"{DESCRIBE_FRAGMENT}: paths {sorted(frag_by_path)} != emitter {sorted(emit_by_path)}",
)
for path, r in frag_by_path.items():
    check(r["service"] == SERVICE, f"{DESCRIBE_FRAGMENT}: {path} service is {r['service']!r}")
    check(
        r["method"] == emit_by_path[path][1],
        f"{DESCRIBE_FRAGMENT}: {path} method {r['method']!r} != emitter {emit_by_path[path][1]!r}",
    )
    check(r["http_method"] == "GET", f"{DESCRIBE_FRAGMENT}: {path} is not a GET")

# ── 4. the Rust ROUTES table ──────────────────────────────────────────────────
rs_rm = read(RS_READMODEL)
block = re.search(r"pub const ROUTES:[^=]*=\s*&\[(.*?)\];", rs_rm, re.S)
check(block is not None, f"{RS_READMODEL}: no ROUTES table found")
rs_routes = re.findall(r'\("([a-z_]+)",\s*"([a-z_]+)"\)', block.group(1)) if block else []
check(
    dict(rs_routes) == {p: rows for p, (rows, _) in emit_by_path.items()},
    f"{RS_READMODEL}: ROUTES {dict(rs_routes)} != emitter {{path: rows_field}} "
    f"{ {p: rows for p, (rows, _) in emit_by_path.items()} }",
)

# ── 5. the declaration (routes.rs) vs the registration (http.rs) ──────────────
rs_routes = read(RS_ROUTES)
rs_http = read(RS_HTTP)


def rust_triples(src, const):
    block = re.search(rf"pub const {const}:[^=]*=\s*&\[(.*?)\];", src, re.S)
    if not block:
        return None
    return re.findall(r'\("(\w+)",\s*"(\w+)",\s*"([a-z_/\-]+)"\)', block.group(1))


declared_reads = rust_triples(rs_routes, "AUTHORING_READS")
check(declared_reads is not None, f"{RS_ROUTES}: no AUTHORING_READS table")

# Routes served from the proposal log rather than an emitted payload. Read from
# the Rust source rather than repeated here, so the exception has ONE definition
# and cannot drift between the two descriptions that both have to know about it.
log_backed = set(
    re.findall(
        r'"([a-z_/\-]+)"',
        (re.search(r"pub const LOG_BACKED_ROUTES:[^=]*=\s*&\[(.*?)\];", read(RS_READMODEL), re.S)
         or type("m", (), {"group": lambda *_: ""})()).group(1),
    )
)
check(bool(log_backed), f"{RS_READMODEL}: no LOG_BACKED_ROUTES table")
check(
    log_backed <= {path for _m, _v, path in (declared_reads or [])},
    f"{RS_ROUTES}: a log-backed route is served but not declared ({sorted(log_backed)})",
)
check(
    {path: method for method, _verb, path in (declared_reads or []) if path not in log_backed}
    == {path: method for path, (_rows, method) in emit_by_path.items()},
    f"{RS_ROUTES}: AUTHORING_READS disagrees with the emitter's (path, method) pairs",
)
for _m, verb, _p in declared_reads or []:
    check(verb == "GET", f"{RS_ROUTES}: a read route declares verb {verb!r}")

declared_writes = rust_triples(rs_routes, "AUTHORING_WRITES")
check(declared_writes is not None, f"{RS_ROUTES}: no AUTHORING_WRITES table")
# The three writes RFC-002 needs: the nested proposal, its structural preview, and
# the flat one-op form a declarative FormPanel can submit.
check(
    {m for m, _v, _p in (declared_writes or [])}
    == {"SubmitProposal", "PreviewProposal", "SubmitOp"},
    f"{RS_ROUTES}: AUTHORING_WRITES is {declared_writes}",
)
for _m, verb, _p in declared_writes or []:
    check(verb == "POST", f"{RS_ROUTES}: a write route declares verb {verb!r}")

# every DECLARED route must be a REGISTERED axum route — the two are connected by
# nothing but a string, so nothing but a check can connect them
for path in emit_by_path:
    check(
        f'.route("/{path}", get(' in rs_http,
        f"{RS_HTTP}: no `.route(\"/{path}\", get(...))` for a declared route",
    )
for _method, _verb, path in declared_writes or []:
    check(f'.route("/{path}", post(' in rs_http, f"{RS_HTTP}: POST /{path} is not registered")

# ── 6. the panel bundle: textproto, nav leaves, and the compiled bytes ────────
textproto = read(PANELS_TEXTPROTO)
panels = re.findall(
    r'panel_id:\s*"([a-z_]+)".*?service:\s*"([\w.]+)"\s*method:\s*"(\w+)".*?rows_field:\s*"([a-z_]+)"',
    textproto,
    re.S,
)
check(len(panels) == 10, f"{PANELS_TEXTPROTO}: parsed {len(panels)} table panels, expected 10")
authoring_panels = [p for p in panels if p[1] == SERVICE]
check(
    len(authoring_panels) == 7,
    f"{PANELS_TEXTPROTO}: {len(authoring_panels)} authoring panels, expected 7",
)
for panel_id, _svc, method, rows_field in authoring_panels:
    # the panel_id is the route path for every authoring panel except `frontier`,
    # whose rows_field is `stalls` — so key on the method, which is unambiguous
    match = [p for p, (_, m) in emit_by_path.items() if m == method]
    if not check(match, f"{PANELS_TEXTPROTO}: panel {panel_id} populates unknown method {method!r}"):
        continue
    path = match[0]
    check(
        rows_field == emit_by_path[path][0],
        f"{PANELS_TEXTPROTO}: panel {panel_id} rows_field {rows_field!r} != "
        f"emitted {emit_by_path[path][0]!r}",
    )
    check(
        panel_id == path,
        f"{PANELS_TEXTPROTO}: panel_id {panel_id!r} != route path {path!r} "
        f"(the LayoutService nav leaf id must equal the panel id)",
    )

# every panel_id needs a nav leaf, or the shell falls back to client-side grouping
rs_main = read(RS_MAIN)
nav_leaves = re.findall(r'fastverk_layout::leaf\("([a-z_]+)"', rs_main)
check(
    set(nav_leaves) == {p[0] for p in panels},
    f"{RS_MAIN}: nav leaves {sorted(nav_leaves)} != panel ids {sorted(p[0] for p in panels)}",
)

# the compiled bundle must carry the same panel ids as the textproto. Decoded on the
# protobuf wire format directly (panel_id is field 1 of a length-delimited field 2 of
# the bundle) so this needs no protoc and no generated code.
raw = open(os.path.join(ROOT, PANELS_BINPB), "rb").read()


def wire_fields(buf):
    i = 0
    while i < len(buf):
        key = 0
        shift = 0
        while True:
            b = buf[i]
            i += 1
            key |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        fno, wt = key >> 3, key & 7
        if wt == 2:
            ln = 0
            shift = 0
            while True:
                b = buf[i]
                i += 1
                ln |= (b & 0x7F) << shift
                if not b & 0x80:
                    break
                shift += 7
            yield fno, buf[i : i + ln]
            i += ln
        elif wt == 0:
            while buf[i] & 0x80:
                i += 1
            i += 1
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            raise ValueError(f"wiretype {wt}")


binpb_ids = [
    sub.decode("utf-8")
    for fno, panel in wire_fields(raw)
    if fno == 2
    for sfno, sub in wire_fields(panel)
    if sfno == 1
]
check(
    binpb_ids == [p[0] for p in panels],
    f"{PANELS_BINPB}: compiled panel ids {binpb_ids} != textproto {[p[0] for p in panels]} "
    f"— recompile the bundle (`bazel build //services/spec/ui:panels`)",
)

# ── 7. the declarative write descriptors ──────────────────────────────────────
#
# panels.authoring-form.textproto is a MOCK — it cannot be compiled here, because
# `form { }` needs a meridian_schemas version newer than spec's pin (see the file's
# header). What CAN be checked without a schema is its internal consistency, and
# these are the mistakes that would otherwise sit undiscovered until the version bump:
# a binding naming a field that does not exist, a field nothing binds, a submit
# pointing at an undeclared route, or an op outside the closed vocabulary.
forms = read(FORMS_TEXTPROTO)

TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[{}]|[A-Za-z_][A-Za-z0-9_]*|:|-?\d+')


def strip_comments(text):
    out = []
    for line in text.splitlines():
        keep, in_str, i = "", False, 0
        while i < len(line):
            c = line[i]
            if c == '"' and (i == 0 or line[i - 1] != "\\"):
                in_str = not in_str
            if c == "#" and not in_str:
                break
            keep += c
            i += 1
        out.append(keep)
    return "\n".join(out)


def blocks(toks, i):
    """Parse a `{ ... }` body -> list of (key, value|list). i points past `{`."""
    entries = []
    while toks[i] != "}":
        key = toks[i]
        i += 1
        if toks[i] == "{":
            sub, i = blocks(toks, i + 1)
            entries.append((key, sub))
        elif toks[i] == ":":
            i += 1
            v = toks[i]
            entries.append((key, v[1:-1] if v.startswith('"') else int(v)))
            i += 1
        else:
            raise SyntaxError(f"unexpected {toks[i]!r} after {key!r}")
    return entries, i + 1


form_toks = TOKEN.findall(strip_comments(forms))
form_panels, i = [], 0
try:
    while i < len(form_toks):
        assert form_toks[i] == "panels" and form_toks[i + 1] == "{", form_toks[i : i + 2]
        sub, i = blocks(form_toks, i + 2)
        form_panels.append(sub)
    parsed = True
except (SyntaxError, AssertionError, IndexError) as e:
    check(False, f"{FORMS_TEXTPROTO}: does not parse as textproto ({e})")
    parsed = False

# The routes a form may submit to: whatever routes.rs declares as a POST.
post_methods = {m for m, v, _p in (declared_writes or []) if v == "POST"}
op_kinds = set(
    re.findall(r'kind:\s*"(\w+)"', re.search(r"pub const OPS:.*?\n\];", read("services/spec/src/proposal.rs"), re.S).group(0))
)
check(len(op_kinds) == 17, f"proposal.rs: parsed {len(op_kinds)} op kinds, expected RFC-002's 16 + retractTerm")

if parsed:
    check(len(form_panels) >= 1, f"{FORMS_TEXTPROTO}: no panels")
    for panel in form_panels:
        entries = dict(panel)
        pid = entries.get("panel_id", "<unnamed>")
        form = entries.get("form")
        if not check(isinstance(form, list), f"{FORMS_TEXTPROTO}: panel {pid} has no `form` block"):
            continue
        field_ids = [v for k, sub in form if k == "fields" for kk, v in sub if kk == "field_id"]
        check(field_ids, f"{FORMS_TEXTPROTO}: panel {pid} declares no fields")
        check(
            len(set(field_ids)) == len(field_ids),
            f"{FORMS_TEXTPROTO}: panel {pid} has duplicate field_ids: {field_ids}",
        )
        # every field must carry exactly one `kind` — the shell falls back to a plain
        # text input for an unrecognised one, silently turning an enum into free text
        for k, sub in form:
            if k != "fields":
                continue
            f = dict(sub)
            kinds = [kk for kk, _ in sub if kk in ("text", "masked", "integer", "enum_selection")]
            check(
                len(kinds) == 1,
                f"{FORMS_TEXTPROTO}: field {f.get('field_id')} in {pid} has kinds {kinds}, expected exactly 1",
            )
        submit = dict(next((sub for k, sub in form if k == "submit"), []))
        submit_entries = next((sub for k, sub in form if k == "submit"), [])
        if not check(submit, f"{FORMS_TEXTPROTO}: panel {pid} has no `submit`"):
            continue
        check(
            submit.get("service") == SERVICE,
            f"{FORMS_TEXTPROTO}: panel {pid} submits to {submit.get('service')!r}, expected {SERVICE!r}",
        )
        check(
            submit.get("method") in post_methods,
            f"{FORMS_TEXTPROTO}: panel {pid} submits to method {submit.get('method')!r}, "
            f"which routes.rs does not declare as a POST ({sorted(post_methods)})",
        )
        bindings = [dict(sub) for k, sub in submit_entries if k == "bindings"]
        bound_from_fields = {b["form_field"] for b in bindings if "form_field" in b}
        check(
            bound_from_fields == set(field_ids),
            f"{FORMS_TEXTPROTO}: panel {pid} — fields {sorted(set(field_ids) - bound_from_fields)} are "
            f"declared but never bound; {sorted(bound_from_fields - set(field_ids))} are bound but not declared",
        )
        literals = {b["request_field"]: b["literal"] for b in bindings if "literal" in b}
        check(
            literals.get("op") in op_kinds,
            f"{FORMS_TEXTPROTO}: panel {pid} binds op={literals.get('op')!r}, "
            f"which is not in the closed op vocabulary",
        )
        # `parent` must reach the server, or the write has no read point
        check(
            "parent" in bound_from_fields or "parent" in literals,
            f"{FORMS_TEXTPROTO}: panel {pid} never sends `parent`",
        )

# ── report ────────────────────────────────────────────────────────────────────
if failures:
    print(f"FAIL — {len(failures)} of {checks} checks failed:\n", file=sys.stderr)
    for f in failures:
        print(f"  * {f}", file=sys.stderr)
    sys.exit(1)
print(f"OK — {checks} checks passed across 6 descriptions of the authoring plane")
print(f"     routes: {', '.join(sorted(emit_by_path))}")
print(f"     panels: {', '.join(p[0] for p in panels)}")
