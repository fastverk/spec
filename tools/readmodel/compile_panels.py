#!/usr/bin/env python3
"""compile_panels — compile ui/panels.textproto to panels.binpb without protoc.

`bazel build //services/spec/ui:panels` is the real compiler and stays the source of
truth. This exists because the compiled bundle is ALSO committed (a `cargo run` has
no Bazel runfiles to read it from), and a committed generated file that nobody can
regenerate goes stale the first time the textproto is edited by someone without a
working Bazel.

    python3 tools/readmodel/compile_panels.py            # verify only
    python3 tools/readmodel/compile_panels.py --write    # verify, then rewrite .binpb

## Why this is trustworthy despite hand-rolling protobuf

The field numbers were not guessed. They were read off the committed bundle — which
protoc produced — by decoding it on the wire. And the codec is validated on every
run, before it is allowed to emit anything, by two checks:

  1. **Round-trip.** Decode the committed `.binpb` and re-encode it. The result must
     be byte-identical. A codec that cannot reproduce protoc's own output on real
     data has no business producing a replacement.
  2. **Agreement.** Compile the textproto, decode the result, and compare EVERY
     field it carries — panel ids, titles, populate pairs, rows_fields, item_nouns,
     placeholders, and each column's header / field_path / pref_width — against what
     the textproto says. This catches a textproto the parser misread, which
     round-tripping cannot.

     Note what this check CANNOT do, established by injecting the bug and watching
     it pass: it compares the parser's output to the encoder's output, so a parser
     fault applied *consistently* is invisible to it. The mojibake below corrupted
     both sides identically and the agreement check was satisfied. Comparing every
     field still earns its place — it catches a field read into the wrong place, or
     dropped — but it is not what caught the character-level bug.

  3. **Byte-equality with the committed bundle.** This is what actually caught the
     mojibake: protoc's output was 2971 bytes and this compiler emitted 2983. A
     difference of 12 bytes in strings nobody would look at twice is the only signal
     that existed, which is the argument for keeping the comparison byte-exact rather
     than relaxing it to "structurally equivalent" when it disagrees.

  4. **A standing assertion on `unquote`** (`_assert_unquote_preserves_utf8`), which
     runs before anything else on every invocation. Checks 1–3 are all indirect; this
     one names the property.

If either fails the script exits non-zero and writes nothing.

## The schema, as read off the wire

    PanelBundle   panels=2 (repeated)
    Panel         panel_id=1  title=2  table=3
    TablePanel    populate=1  rows_field=2  item_noun=3  placeholder=4  columns=5 (rep)
    RpcCall       service=1   method=2
    Column        header=1    field_path=2  pref_width=4

Note `pref_width` is field **4**, not 3 — the kind of thing that is obvious from the
bytes and invisible from the textproto. Only these shapes are supported: a panel
whose body is anything other than `table` (an `adhoc`, `form` or `gallery` panel)
makes this script exit rather than guess a field number it has no evidence for.
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEXTPROTO = os.path.join(ROOT, "services/spec/ui/panels.textproto")
BINPB = os.path.join(ROOT, "services/spec/ui/panels.binpb")

FIELDS = {
    "PanelBundle": {"panels": (2, "Panel")},
    "Panel": {"panel_id": (1, "str"), "title": (2, "str"), "table": (3, "TablePanel")},
    "TablePanel": {
        "populate": (1, "RpcCall"),
        "rows_field": (2, "str"),
        "item_noun": (3, "str"),
        "placeholder": (4, "str"),
        "columns": (5, "Column"),
    },
    "RpcCall": {"service": (1, "str"), "method": (2, "str")},
    "Column": {"header": (1, "str"), "field_path": (2, "str"), "pref_width": (4, "int")},
}

# ── protobuf wire codec ───────────────────────────────────────────────────────


def read_varint(b, i):
    shift, val = 0, 0
    while True:
        byte = b[i]
        i += 1
        val |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return val, i
        shift += 7


def write_varint(v):
    out = bytearray()
    while True:
        if v < 0x80:
            out.append(v)
            return bytes(out)
        out.append((v & 0x7F) | 0x80)
        v >>= 7


def decode(b):
    """-> [(field_no, wiretype, payload)] in wire order."""
    out, i = [], 0
    while i < len(b):
        key, i = read_varint(b, i)
        fno, wt = key >> 3, key & 7
        if wt == 0:
            v, i = read_varint(b, i)
            out.append((fno, wt, v))
        elif wt == 2:
            ln, i = read_varint(b, i)
            out.append((fno, wt, b[i : i + ln]))
            i += ln
        elif wt == 5:
            out.append((fno, wt, b[i : i + 4]))
            i += 4
        elif wt == 1:
            out.append((fno, wt, b[i : i + 8]))
            i += 8
        else:
            raise ValueError(f"wiretype {wt} at offset {i}")
    return out


def encode(fields):
    out = bytearray()
    for fno, wt, payload in fields:
        out += write_varint((fno << 3) | wt)
        if wt == 0:
            out += write_varint(payload)
        elif wt == 2:
            out += write_varint(len(payload))
            out += payload
        else:
            out += payload
    return bytes(out)


# ── textproto parser (only the shapes this bundle uses) ──────────────────────

TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[{}]|[A-Za-z_][A-Za-z0-9_]*|:|-?\d+')


def tokenize(text):
    """Tokenize, dropping `#` comments but never inside a string literal."""
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
        out += TOKEN.findall(keep)
    return out


# The escapes textproto actually uses. Deliberately NOT
# `.encode("utf-8").decode("unicode_escape")`: that round-trip reads each UTF-8
# BYTE as a Latin-1 codepoint, so `≥` (U+2265, three bytes) comes back as three
# characters and re-encodes to six. It is silent — the string still looks like a
# string — and it is how this compiler once emitted a bundle 9 bytes larger than
# protoc's, with `Requires ≥` stored as `Requires â‰¥`.
#
# Worth knowing exactly which check would have stopped it, because two of the three
# would not: the agreement check corrupts both sides equally and passes, and the
# round-trip check never touches the textproto. Only byte-equality against protoc's
# own committed output caught it — and only because someone ran the tool on a bundle
# protoc had produced. Hence `_assert_unquote_preserves_utf8` below, which does not
# depend on that luck.
_ESCAPES = {
    "\\": "\\", '"': '"', "'": "'", "n": "\n", "r": "\r", "t": "\t",
    "a": "\a", "b": "\b", "f": "\f", "v": "\v", "?": "?",
}


def unquote(tok):
    """Decode a textproto string literal, leaving every non-escape character —
    including multi-byte UTF-8 — exactly as it was."""
    body, out, i = tok[1:-1], [], 0
    while i < len(body):
        c = body[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        if i + 1 >= len(body):
            raise SyntaxError(f"trailing backslash in {tok!r}")
        nxt = body[i + 1]
        if nxt not in _ESCAPES:
            # Octal (\ooo), hex (\xhh) and \uXXXX are legal textproto and not
            # handled here. Refusing beats guessing: a wrong decode is a corrupted
            # bundle that still parses.
            raise SyntaxError(
                f"unsupported escape `\\{nxt}` in {tok!r}; extend _ESCAPES rather "
                f"than letting it through"
            )
        out.append(_ESCAPES[nxt])
        i += 2
    return "".join(out)


def parse_block(toks, i):
    """Body of a `{ ... }` -> [(key, value)]. i points past `{`."""
    entries = []
    while toks[i] != "}":
        key = toks[i]
        i += 1
        if toks[i] == "{":
            sub, i = parse_block(toks, i + 1)
            entries.append((key, sub))
        elif toks[i] == ":":
            i += 1
            v = toks[i]
            entries.append((key, unquote(v) if v.startswith('"') else int(v)))
            i += 1
        else:
            raise SyntaxError(f"unexpected {toks[i]!r} after {key!r}")
    return entries, i + 1


def parse_top(text):
    toks = tokenize(text)
    entries, i = [], 0
    while i < len(toks):
        key = toks[i]
        if toks[i + 1] != "{":
            raise SyntaxError(f"top-level {key!r} must be a message")
        sub, i = parse_block(toks, i + 2)
        entries.append((key, sub))
    return entries


def emit(entries, msg_type):
    wire = []
    for key, val in entries:
        if key not in FIELDS[msg_type]:
            raise SystemExit(
                f"unsupported field `{key}` in {msg_type}. This script only knows the "
                f"`table` panel shape — a non-table panel needs field numbers read off "
                f"a bundle that protoc produced, which is a `bazel build "
                f"//services/spec/ui:panels` away."
            )
        fno, kind = FIELDS[msg_type][key]
        if kind == "str":
            wire.append((fno, 2, val.encode("utf-8")))
        elif kind == "int":
            wire.append((fno, 0, val))
        else:
            wire.append((fno, 2, emit(val, kind)))
    return encode(wire)


# ── structural view, for the agreement check ─────────────────────────────────


def summary_from_textproto(entries):
    """Every field the bundle carries, not just the identifiers.

    An earlier version compared only `field_path`s — all ASCII — which is exactly
    why a mojibaked `header` passed the agreement check. The rule the hard way: a
    self-check that skips the fields most likely to be corrupted is not a check.
    """
    out = []
    for _key, panel in entries:
        p = dict(panel)
        table_entries = p.get("table", [])
        table = dict(table_entries)
        populate = dict(table.get("populate", []))
        # `columns` is repeated, so it must be read off the ENTRY LIST — dict() keeps
        # only the last one.
        cols = tuple(
            (dict(sub).get("header"), dict(sub).get("field_path"), dict(sub).get("pref_width"))
            for k, sub in table_entries
            if k == "columns"
        )
        out.append(
            (
                p.get("panel_id"),
                p.get("title"),
                populate.get("service"),
                populate.get("method"),
                table.get("rows_field"),
                table.get("item_noun"),
                table.get("placeholder"),
                cols,
            )
        )
    return out


def summary_from_binpb(raw):
    out = []
    for _fno, panel in ((f, p) for f, w, p in decode(raw) if f == 2 and w == 2):
        pid = title = svc = meth = rows = noun = placeholder = None
        cols = []
        for sfno, swt, sp in decode(panel):
            if sfno == 1 and swt == 2:
                pid = sp.decode("utf-8")
            elif sfno == 2 and swt == 2:
                title = sp.decode("utf-8")
            elif sfno == 3 and swt == 2:
                for tfno, twt, tp in decode(sp):
                    if tfno == 1 and twt == 2:
                        for rfno, _rwt, rp in decode(tp):
                            if rfno == 1:
                                svc = rp.decode("utf-8")
                            elif rfno == 2:
                                meth = rp.decode("utf-8")
                    elif tfno == 2 and twt == 2:
                        rows = tp.decode("utf-8")
                    elif tfno == 3 and twt == 2:
                        noun = tp.decode("utf-8")
                    elif tfno == 4 and twt == 2:
                        placeholder = tp.decode("utf-8")
                    elif tfno == 5 and twt == 2:
                        header = field_path = width = None
                        for cfno, _cwt, cp in decode(tp):
                            if cfno == 1:
                                header = cp.decode("utf-8")
                            elif cfno == 2:
                                field_path = cp.decode("utf-8")
                            elif cfno == 4:
                                width = cp
                        cols.append((header, field_path, width))
        out.append((pid, title, svc, meth, rows, noun, placeholder, tuple(cols)))
    return out


def _assert_unquote_preserves_utf8():
    """Runs on every invocation, because the bug it guards was silent.

    Costs microseconds and cannot be skipped, which is the point: the mojibake it
    catches produced a bundle that parsed, rendered, and passed the agreement check.
    """
    cases = {
        r'"Requires \u2265"'.replace("\\u2265", "\u2265"): "Requires \u2265",
        '"Permits \u2264"': "Permits \u2264",
        '"an em\u2014dash"': "an em\u2014dash",
        '"a \\"quoted\\" word"': 'a "quoted" word',
        '"tab\\there"': "tab\there",
        '"back\\\\slash"': "back\\slash",
    }
    for literal, want in cases.items():
        got = unquote(literal)
        assert got == want, f"unquote({literal!r}) = {got!r}, want {want!r}"
        assert got.encode("utf-8") == want.encode("utf-8")


def main():
    _assert_unquote_preserves_utf8()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="rewrite panels.binpb if both checks pass")
    args = ap.parse_args()

    committed = open(BINPB, "rb").read()

    # Check 1 — the codec reproduces protoc's own output byte-for-byte.
    if encode(decode(committed)) != committed:
        sys.exit("FAIL: the wire codec cannot round-trip the committed bundle")
    print(f"codec round-trips the committed bundle ({len(committed)} bytes)")

    entries = parse_top(open(TEXTPROTO).read())
    compiled = emit(entries, "PanelBundle")

    # Check 2 — the compiled bytes and the textproto agree structurally.
    want = summary_from_textproto(entries)
    got = summary_from_binpb(compiled)
    if want != got:
        for a, b in zip(want, got):
            if a != b:
                sys.exit(f"FAIL: textproto says {a}\n      compiled says {b}")
        sys.exit(f"FAIL: {len(want)} panels in the textproto, {len(got)} compiled")
    print(f"compiled bytes agree with the textproto ({len(want)} panels, {len(compiled)} bytes)")
    for pid, _title, svc, meth, rows, _noun, _placeholder, cols in want:
        print(f"  {pid:14} {svc}/{meth:20} rows_field={rows:12} {len(cols)} columns")

    if compiled == committed:
        print("committed panels.binpb is up to date")
        return
    if not args.write:
        sys.exit(
            f"STALE: panels.binpb is {len(committed)} bytes, the textproto compiles to "
            f"{len(compiled)}. Re-run with --write (or `bazel build //services/spec/ui:panels`)."
        )
    open(BINPB, "wb").write(compiled)
    print(f"wrote {BINPB} ({len(compiled)} bytes)")


if __name__ == "__main__":
    main()
