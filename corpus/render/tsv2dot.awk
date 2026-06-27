# tsv2dot.awk — turn the //corpus:corpus_edges SPARQL TSV into a Graphviz .dot.
#
# Input  : the TSV emitted by //corpus:corpus_edges. A header row `?src ?rel
#          ?dst`, then TAB-separated, double-quoted values, e.g.
#          "RFC-0901"  "dependsOn"  "RFC-0900".
# Output : a twopi digraph rooted at RFC-0900 (the conservation kernel), with
#          every node declared exactly once, role-colored with the ratio
#          palette, and edges styled by relation:
#            dependsOn -> solid   references -> dotted   refines -> dashed
#
# Run with `awk -F'\t' -f tsv2dot.awk corpus_edges.tsv`. Nothing here is
# hand-authored: the figure's topology is whatever the materialized graph says.

function deq(s) { gsub(/^"|"$/, "", s); return s }       # strip the TSV quotes

function role(n) {                                         # palette bucket per node
  if (n == "RFC-0900") return "kernel"                    # conservation kernel (hub)
  if (n == "RFC-0901") return "hub"                       # portfolio-accounting hub
  if (n == "RFC-0950") return "standard"                  # SEC NAV standard
  return "component"
}

NR == 1 { next }                                          # drop the ?src ?rel ?dst header

{
  src = deq($1); rel = deq($2); dst = deq($3)
  if (src == "" || dst == "") next
  if (!(src in seen)) { seen[src] = 1; order[++n] = src } # node set, first-seen order,
  if (!(dst in seen)) { seen[dst] = 1; order[++n] = dst } # declared exactly once
  e_src[++m] = src; e_rel[m] = rel; e_dst[m] = dst        # stash edges for pass two
}

END {
  print "// GENERATED from //corpus:corpus_edges — do not edit by hand."
  print "// Topology read out of the materialized Jena graph via SPARQL."
  print "digraph hero {"
  print "  layout = twopi;"
  print "  root = \"RFC-0900\";"
  print "  ranksep = \"1.6 equally\";"
  print "  overlap = false;"
  print "  splines = true;"
  print "  bgcolor = \"transparent\";"
  print "  node [shape=box, style=\"rounded,filled\", fontname=\"Helvetica\","
  print "        fontsize=10, color=\"#3A2A1C\", penwidth=1.0, margin=\"0.10,0.05\"];"
  print "  edge [color=\"#6E4F34\", penwidth=0.9, arrowsize=0.6];"
  print ""

  for (i = 1; i <= n; i++) {
    v = order[i]; r = role(v)
    if (r == "kernel")
      printf "  \"%s\" [label=\"%s\\n(conservation kernel)\", fillcolor=\"#6E4F34\", fontcolor=\"#F4EEDD\", fontsize=15, penwidth=2.2, margin=\"0.18,0.11\"];\n", v, v
    else if (r == "hub")
      printf "  \"%s\" [label=\"%s\\n(read-projection hub)\", fillcolor=\"#B98E5E\", fontcolor=\"#3A2A1C\", fontsize=12, penwidth=1.7];\n", v, v
    else if (r == "standard")
      printf "  \"%s\" [label=\"%s\\n(SEC NAV standard)\", shape=note, fillcolor=\"#CFE8CF\", color=\"#2F6B2F\", fontsize=10, penwidth=1.2];\n", v, v
    else
      printf "  \"%s\" [label=\"%s\", fillcolor=\"#F4EEDD\", fontcolor=\"#3A2A1C\", fontsize=9, penwidth=0.8];\n", v, v
  }
  print ""

  for (j = 1; j <= m; j++) {
    style = (e_rel[j] == "references") ? "dotted" : (e_rel[j] == "refines") ? "dashed" : "solid"
    col   = (e_rel[j] == "references") ? "#2F6B2F" : "#6E4F34"
    printf "  \"%s\" -> \"%s\" [style=%s, color=\"%s\"];\n", e_src[j], e_dst[j], style, col
  }
  print "}"
}
