package kg.lean;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;

import kg.Loader;

/**
 * Bidirectional sync test for {@code rfc:provenBy}.
 *
 * Forward direction:
 *   For every {@code <ns> rfc:provenBy "X"} triple, verify that
 *   identifier `X` exists somewhere in
 *   {@code lean/Aion/Spec/Theorems.lean} or
 *   {@code lean/Aion/Derivations/Proofs.lean} as a {@code theorem X}
 *   declaration whose theorem block does NOT contain `sorry`. A
 *   missing or sorry'd theorem fails the gate — we never claim
 *   "proven" without a real proof.
 *
 * Reverse direction:
 *   For every RFC-tagged hand theorem in Theorems.lean (each preceded
 *   by a {@code -- RFC-NNNN — ...} comment block), verify that some
 *   NS in the TTL references it via {@code :provenBy}. An orphan
 *   hand theorem fails the gate — we never let a proof exist that
 *   isn't credited to a real corpus NS.
 *
 * Note: the reverse check is scoped to RFC-tagged hand theorems in
 * Theorems.lean. The other worked theorems in that file (Theorem 1,
 * Theorem 2, ...) without `-- RFC-NNNN` headers are pedagogical
 * compositions, not corpus-derivation proofs, and are exempt.
 *
 * Run:
 *   bazel test //kg/java/lean:provenby_sync_test
 */
public final class ProvenBySyncCheck {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";

    public static void main(String[] args) throws IOException {
        Path kgRoot = Loader.resolveKgRoot();
        Path workspace = kgRoot.getParent();
        Path theoremsRoot = workspace.resolve("lean/Aion/Spec");
        Path proofsFile = workspace.resolve("lean/Aion/Derivations/Proofs.lean");

        // Gather every Theorems.lean under lean/Aion/Spec/** (the monolith was
        // split into per-area files on 2026-05-30). Each file is scanned the
        // same way; we union the results.
        java.util.List<Path> theoremsFiles = new java.util.ArrayList<>();
        try (java.util.stream.Stream<Path> walk = Files.walk(theoremsRoot)) {
            walk.filter(Files::isRegularFile)
                .filter(p -> p.getFileName().toString().equals("Theorems.lean"))
                .forEach(theoremsFiles::add);
        }
        if (theoremsFiles.isEmpty()) {
            System.err.println("ERROR: no Theorems.lean files under " + theoremsRoot);
            System.exit(2);
        }
        if (!Files.isRegularFile(proofsFile)) {
            System.err.println("ERROR: not found: " + proofsFile);
            System.exit(2);
        }

        // 1. Build (theoremName -> kernelVerified?) maps for every Theorems.lean
        //    plus Proofs.lean.
        java.util.Map<String, Boolean> theoremStatus = new TreeMap<>();
        for (Path tf : theoremsFiles) {
            addBlockBased(theoremStatus, tf);
        }
        addBlockBased(theoremStatus, proofsFile);

        // 2. Build the set of RFC-tagged hand theorem names (for reverse check)
        //    by unioning across every Theorems.lean.
        Set<String> rfcTaggedHand = new java.util.TreeSet<>();
        for (Path tf : theoremsFiles) {
            rfcTaggedHand.addAll(collectRfcTagged(tf));
        }

        // 3. Pull all :provenBy values from TTL.
        Dataset ds = Loader.loadDataset(kgRoot);
        Query q = QueryFactory.create(""
            + "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT ?ns ?theoremName WHERE {\n"
            + "  ?ns a rfc:NormativeStatement ; rfc:provenBy ?theoremName .\n"
            + "} ORDER BY ?theoremName");

        List<String[]> claimedProofs = new ArrayList<>();
        try (QueryExecution ex = QueryExecutionFactory.create(q, ds)) {
            ResultSet rs = ex.execSelect();
            while (rs.hasNext()) {
                QuerySolution sol = rs.next();
                claimedProofs.add(new String[] {
                    sol.getResource("ns").getURI(),
                    sol.getLiteral("theoremName").getString(),
                });
            }
        }

        // 4. Forward: every claimed theorem name must exist + be sorry-free.
        List<String> forwardErrors = new ArrayList<>();
        Set<String> referencedNames = new LinkedHashSet<>();
        for (String[] row : claimedProofs) {
            String name = row[1];
            referencedNames.add(name);
            Boolean verified = theoremStatus.get(name);
            if (verified == null) {
                forwardErrors.add(":provenBy \"" + name + "\" → no such theorem found"
                    + " (TTL: " + row[0] + ")");
            } else if (!verified) {
                forwardErrors.add(":provenBy \"" + name + "\" → theorem exists but contains sorry"
                    + " (TTL: " + row[0] + ")");
            }
        }

        // 5. Reverse: every RFC-tagged hand theorem must be referenced by some :provenBy.
        List<String> reverseErrors = new ArrayList<>();
        for (String name : rfcTaggedHand) {
            if (!referencedNames.contains(name)) {
                reverseErrors.add(name + " (RFC-tagged hand theorem in Theorems.lean) "
                    + "→ no :provenBy reference in any TTL file");
            }
        }

        // 6. Reachability: every :provenBy triple must be on an NS that is
        //    reachable via Document → Section → containsRule. Catches the
        //    orphan-bnode bug where :provenBy gets written on a stranded
        //    blank node (PR #88's first emitter pass had this defect).
        Query reachQ = QueryFactory.create(""
            + "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT (COUNT(DISTINCT ?ns) AS ?n) WHERE {\n"
            + "  ?doc a rfc:Document ; rfc:hasSection ?sec .\n"
            + "  ?sec rfc:containsRule ?ns .\n"
            + "  ?ns a rfc:NormativeStatement ; rfc:provenBy ?theoremName .\n"
            + "}");
        Query totalQ = QueryFactory.create(""
            + "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT (COUNT(DISTINCT ?ns) AS ?n) WHERE {\n"
            + "  ?ns a rfc:NormativeStatement ; rfc:provenBy ?theoremName .\n"
            + "}");
        int reachable = countOne(ds, reachQ);
        int total = countOne(ds, totalQ);
        List<String> reachabilityErrors = new ArrayList<>();
        if (reachable != total) {
            reachabilityErrors.add(
                "found " + total + " NS(es) with :provenBy but only " + reachable
                + " are reachable via Document → Section → containsRule. "
                + "The remaining " + (total - reachable) + " are stranded — "
                + "they will not appear in per-RFC SPARQL queries. Cause is "
                + "usually a buggy emitter writing blank-node subjects from "
                + "one Model into another.");
        }

        if (forwardErrors.isEmpty() && reverseErrors.isEmpty() && reachabilityErrors.isEmpty()) {
            System.out.printf(
                "[provenby_sync_check] %d :provenBy triple(s); all resolve to non-sorry theorems; "
                + "%d RFC-tagged hand theorem(s) all credited; %d NS(es) reachable from a Document.%n",
                claimedProofs.size(), rfcTaggedHand.size(), reachable);
            return;
        }

        if (!forwardErrors.isEmpty()) {
            System.err.println("ERROR: forward direction (TTL → Lean):");
            for (String e : forwardErrors) System.err.println("  - " + e);
        }
        if (!reverseErrors.isEmpty()) {
            System.err.println("ERROR: reverse direction (Lean → TTL):");
            for (String e : reverseErrors) System.err.println("  - " + e);
        }
        if (!reachabilityErrors.isEmpty()) {
            System.err.println("ERROR: reachability (Document → NS):");
            for (String e : reachabilityErrors) System.err.println("  - " + e);
        }
        System.err.println();
        System.err.println("Resolution:");
        System.err.println("  - To fix forward errors: ensure each :provenBy value names a real"
            + " non-sorry theorem in Theorems.lean or Proofs.lean.");
        System.err.println("  - To fix reverse errors: add a :provenBy triple to the matching"
            + " TTL NS, or remove the RFC-NNNN tag from the theorem if it's not a"
            + " corpus-derivation proof.");
        System.err.println("  - To fix reachability errors: re-run //kg/java/lean:proven_by_emitter."
            + " The current ProvenByEmitter writes :provenBy onto NS blank nodes within each"
            + " per-file Model and clears stranded triples, so a fresh run heals the corpus.");
        System.exit(1);
    }

    private static int countOne(Dataset ds, Query q) {
        try (QueryExecution exec = QueryExecutionFactory.create(q, ds)) {
            ResultSet rs = exec.execSelect();
            if (rs.hasNext()) return rs.next().getLiteral("n").getInt();
        }
        return 0;
    }

    /** Scan a Lean file for theorem declarations within RFC-tagged
     *  blocks and record each as (name -> kernelVerified). A block
     *  starts at `-- RFC-NNNN ...` and ends at the next such header
     *  (or EOF). Within the block, the theorem is kernel-verified
     *  iff no line contains the substring `sorry`. */
    private static void addBlockBased(java.util.Map<String, Boolean> out, Path file)
            throws IOException {
        List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
        int n = lines.size();
        int i = 0;
        while (i < n) {
            if (!lines.get(i).startsWith("-- RFC-")) { i++; continue; }
            int blockStart = i;
            int blockEnd = n;
            for (int j = i + 1; j < n; j++) {
                if (lines.get(j).startsWith("-- RFC-")) { blockEnd = j; break; }
            }
            String name = null;
            boolean hasSorry = false;
            // Multi-line signatures (theorem name on one line, args on
            // the next, `:` later) are common; don't require the colon
            // on the same line as the name.
            Pattern thmPat = Pattern.compile("^theorem\\s+([A-Za-z0-9_']+)\\b");
            for (int j = blockStart; j < blockEnd; j++) {
                String line = lines.get(j);
                if (line.contains("sorry")) hasSorry = true;
                if (name == null) {
                    Matcher m = thmPat.matcher(line);
                    if (m.find()) name = m.group(1);
                }
            }
            if (name != null) out.put(name, !hasSorry);
            i = blockEnd;
        }
    }

    /** Collect just the RFC-tagged theorem names from Theorems.lean
     *  (ignores other worked theorems in the same file). Used for the
     *  reverse-direction check. */
    private static Set<String> collectRfcTagged(Path file) throws IOException {
        Set<String> out = new LinkedHashSet<>();
        List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
        int n = lines.size();
        int i = 0;
        Pattern thmPat = Pattern.compile("^theorem\\s+([A-Za-z0-9_']+)\\b");
        while (i < n) {
            if (!lines.get(i).startsWith("-- RFC-")) { i++; continue; }
            int blockEnd = n;
            for (int j = i + 1; j < n; j++) {
                if (lines.get(j).startsWith("-- RFC-")) { blockEnd = j; break; }
            }
            for (int j = i; j < blockEnd; j++) {
                Matcher m = thmPat.matcher(lines.get(j));
                if (m.find()) {
                    out.add(m.group(1));
                    break;
                }
            }
            i = blockEnd;
        }
        return out;
    }
}
