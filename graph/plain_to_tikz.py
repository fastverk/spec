"""Graphviz `plain` layout → standalone TikZ, for the crank-001 deck figures.

# Why this exists

These figures used to go DOT → SVG → PDF through `rules_graphviz@0.2.0`'s
`svg_pdf` (and `//corpus/render:hero_pdf` through `dot_pdf`). Both macros are
**broken for every consumer**, not just this repo:

    var __dirname = "/private/tmp/claude-501/.../scratchpad/
                     svg2pdf-final/node_modules/pdfkit/js";
    return fs2.readFileSync(__dirname + "/data/Helvetica.afm", "utf8");

`bun build` folded `__dirname` into a literal at bundle time, and pdfkit reads
its AFM font metrics off disk at run time — so the vendored bundle reaches for
an absolute path inside the ephemeral scratchpad of the machine that built it.
No `.afm` file ships with the module either, so it cannot be repaired by
patching the path: the data is absent, not misplaced.

The failure mode is worth naming, because it is the reason this went unnoticed:
the module is hermetic in *appearance* — vendored bundle, no host `dot`, no
cairo — and reaches an absolute path anyway. Only the PDF path fails, only at
run time, with an error that names a font. A build that renders SVG fine tells
you nothing about `svg_pdf`.

# What this does instead

`dot_diagram` DOES work, and one of its supported outputs is graphviz's `plain`
format — the layout, already computed, as text:

    graph SCALE WIDTH HEIGHT
    node NAME X Y WIDTH HEIGHT LABEL STYLE SHAPE COLOR FILLCOLOR
    edge TAIL HEAD N x1 y1 ... xn yn [LABEL xl yl] STYLE COLOR
    stop

So graphviz still does the hard part (layout, hermetically, in WASM) and this
script turns the result into TikZ that LaTeX draws as vector. The figures stay
*derived from the authored .dot* rather than being swapped for hand-drawn
stand-ins, and they become the same kind of object as the deck's other figures
(`deck/figures/*.tex`), which were already native pgfplots/TikZ.

Coordinates in `plain` are inches with the origin bottom-left, which is also
TikZ's convention, so they pass through unscaled.

Ported from `agora/papers/grounding/figures/plain_to_tikz.py`, which hit the
identical `rules_graphviz` failure.
"""

import argparse
import math
import shlex
import sys


def _finite(*vals):
    return all(isinstance(v, float) and math.isfinite(v) for v in vals)


def _parse_plain(text):
    """Split a `plain` stream into (scale, w, h), nodes, edges.

    `plain` quotes labels containing spaces, so the line must be split with
    shell-like quoting rather than `str.split()` — a label of "claim gas"
    otherwise consumes the style/shape/color fields and every subsequent index
    is wrong.
    """
    header, nodes, edges = None, [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            parts = shlex.split(line)
        except ValueError:
            # Unbalanced quotes: keep going rather than lose the figure.
            parts = line.split()
        if not parts:
            continue
        kind = parts[0]
        if kind == "graph" and len(parts) >= 4:
            header = (float(parts[1]), float(parts[2]), float(parts[3]))
        elif kind == "node" and len(parts) >= 11:
            nodes.append({
                "name": parts[1],
                "x": float(parts[2]), "y": float(parts[3]),
                "w": float(parts[4]), "h": float(parts[5]),
                "label": parts[6],
                "shape": parts[8],
                "color": parts[9],
                "fill": parts[10],
            })
        elif kind == "edge" and len(parts) >= 4:
            n = int(parts[3])
            pts = [
                (float(parts[4 + 2 * i]), float(parts[5 + 2 * i]))
                for i in range(n)
            ]
            edges.append({"tail": parts[1], "head": parts[2], "points": pts})
        elif kind == "stop":
            break
    return header, nodes, edges


def _tex_escape(s):
    """Escape a graphviz label for LaTeX text mode.

    `\\N` is graphviz's "use the node name" default; it must not reach the
    output. `\\n` is graphviz's line break and becomes `\\\\`.
    """
    if s == "\\N":
        return ""
    s = s.replace("\\n", "\x00")
    for ch, rep in [
        ("\\", r"\textbackslash{}"),
        ("&", r"\&"), ("%", r"\%"), ("$", r"\$"), ("#", r"\#"),
        ("_", r"\_"), ("{", r"\{"), ("}", r"\}"),
        ("~", r"\textasciitilde{}"), ("^", r"\textasciicircum{}"),
    ]:
        s = s.replace(ch, rep)
    return s.replace("\x00", r"\\")


def _bezier(points):
    """`plain` edge points are a start followed by cubic Bézier triples.

    A degenerate run (not 1 + 3k points) falls back to a polyline, which is
    visually close enough and never drops the edge — an edge silently missing
    from a spec graph is worse than one drawn straight.
    """
    if len(points) < 4 or (len(points) - 1) % 3 != 0:
        return " -- ".join(f"({x:.4f},{y:.4f})" for x, y in points)
    out = [f"({points[0][0]:.4f},{points[0][1]:.4f})"]
    for i in range(1, len(points), 3):
        c1, c2, p = points[i], points[i + 1], points[i + 2]
        out.append(
            f" .. controls ({c1[0]:.4f},{c1[1]:.4f})"
            f" and ({c2[0]:.4f},{c2[1]:.4f}) .."
            f" ({p[0]:.4f},{p[1]:.4f})"
        )
    return "".join(out)


def _color(spec, defs):
    """Map a graphviz color to a TikZ color name, defining it if needed.

    Hex is passed through via xcolor's HTML model rather than being
    approximated, so the figure's fills are the ones the DOT asked for.
    """
    if not spec:
        return "white"
    s = spec.strip().strip('"')
    if s.startswith("#") and len(s) >= 7:
        hexval = s[1:7].upper()
        name = "gvc" + hexval
        defs.setdefault(name, hexval)
        return name
    # A bare name reaches LaTeX as-is only if xcolor knows it; anything else
    # would fail the run, so restrict to the ones it always has.
    known = {
        "white", "black", "red", "green", "blue", "cyan", "magenta",
        "yellow", "gray", "lightgray", "darkgray", "orange", "violet",
        "purple", "brown", "olive", "pink", "teal", "lime",
    }
    return s if s.lower() in known else "white"


def render(text):
    header, nodes, edges = _parse_plain(text)
    if header is None:
        raise SystemExit(
            "plain_to_tikz: no `graph` header found — the input is not "
            "graphviz `plain` output. Check dot_diagram's output_format."
        )
    if not nodes:
        raise SystemExit(
            "plain_to_tikz: layout has zero nodes. An empty figure would "
            "render as a blank box and read as 'the graph collapsed to "
            "nothing', so this fails instead."
        )

    # Graphviz can emit `nan` coordinates -- sfdp with `overlap=prism` did
    # exactly that for one node of collapse_before.dot, and the NaN flowed
    # through to TeX as "Missing number, treated as zero". A node that cannot
    # be placed must not be silently dropped: these figures are counting
    # arguments ("16 specs are one orbit"), so a missing node changes the
    # claim. Fail instead, and name the node so the .dot can be fixed.
    bad = [n["name"] for n in nodes if not _finite(n["x"], n["y"])]
    if bad:
        raise SystemExit(
            "plain_to_tikz: graphviz emitted non-finite coordinates for "
            + ", ".join(sorted(bad))
            + ". The layout failed for those nodes; dropping them would "
            "quietly change what the figure counts. Try `overlap=scale` "
            "(prism/voronoi are the usual cause)."
        )

    pos = {n["name"]: (n["x"], n["y"]) for n in nodes}
    defs = {}
    body = []

    # Edges first so node boxes paint over the spline ends.
    for e in edges:
        pts = e["points"]
        if not all(_finite(x, y) for x, y in pts):
            # The endpoints are known good (nodes were checked above), so draw
            # the edge straight rather than losing it -- a missing edge in a
            # duplication figure understates the duplication.
            tail, head = pos.get(e["tail"]), pos.get(e["head"])
            if tail is None or head is None:
                print(
                    "plain_to_tikz: dropping edge {} -> {} (non-finite spline "
                    "and unknown endpoint)".format(e["tail"], e["head"]),
                    file=sys.stderr,
                )
                continue
            print(
                "plain_to_tikz: edge {} -> {} had a non-finite spline; drawing "
                "it straight".format(e["tail"], e["head"]),
                file=sys.stderr,
            )
            pts = [tail, head]
        body.append(
            r"  \draw[-{Stealth[length=1.4mm]}, gray!65] "
            + _bezier(pts) + ";"
        )

    for n in nodes:
        label = _tex_escape(n["label"]) or _tex_escape(n["name"])
        # The .dot sources encode meaning in hex fills. An earlier version of
        # this converter matched a handful of NAMED colors and fell through to
        # white — which loses the encoding while still producing a perfectly
        # good-looking graph, i.e. it fails invisibly.
        fill = _color(n["fill"], defs)
        body.append(
            f"  \\node[draw, rounded corners=1.5pt, fill={fill}, "
            f"font=\\scriptsize, align=center, "
            f"minimum width={n['w']:.3f}in, minimum height={n['h']:.3f}in, "
            f"inner sep=1pt] at ({n['x']:.4f},{n['y']:.4f}) "
            f"{{{label}}};"
        )

    out = [
        "% Generated by //graph:plain_to_tikz — do not edit.",
        "% Source: the graphviz `plain` layout of the authored .dot.",
    ]
    # \definecolor before the picture, so the fills resolve.
    out += [f"\\definecolor{{{n}}}{{HTML}}{{{v}}}" for n, v in sorted(defs.items())]
    out.append(r"\begin{tikzpicture}[x=1in, y=1in]")
    return "\n".join(out + body + [r"\end{tikzpicture}"]) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layout", required=True,
                    help="graphviz `plain` output from dot_diagram.")
    ap.add_argument("--output", required=True, help="TikZ .tex to write.")
    args = ap.parse_args(argv)

    with open(args.layout, encoding="utf-8") as f:
        tikz = render(f.read())
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(tikz)
    return 0


if __name__ == "__main__":
    sys.exit(main())
