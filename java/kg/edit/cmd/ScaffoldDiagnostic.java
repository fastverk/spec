package kg.edit.cmd;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.Resource;

import kg.GateHarness;
import kg.Loader;
import kg.edit.Output;
import kg.edit.WriteOps;

/**
 * Add a new diagnostic to an RFC.
 *
 *   kg_edit scaffold-diagnostic --rfc RFC-NNNN \
 *       --code MNNxxx --severity Error \
 *       --description "..."
 *
 * Validates:
 *   - the RFC exists
 *   - the code matches the RFC's declared diagnosticRange (if present)
 *   - the code does not collide with an existing diagnostic in the corpus
 *   - severity is one of Fatal / Error / Warning / Info / Defect
 */
public final class ScaffoldDiagnostic {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String RFC_INST = "https://aion.savvi.io/rfc/";
    private static final List<String> SEVERITIES =
        List.of("Fatal", "Error", "Warning", "Info", "Defect");

    private ScaffoldDiagnostic() {}

    public static Output.Result run(Path kgRoot, String rfcId, String code, String severity, String description, boolean apply) throws IOException {
        if (!SEVERITIES.contains(severity)) return error("severity must be one of: " + SEVERITIES);
        if (description == null || description.isBlank()) return error("--description is required");
        Path file = WriteOps.turtleFileFor(kgRoot, rfcId);
        if (!Files.isRegularFile(file)) return error("RFC TTL not found: " + file);

        // Validate code matches RFC's range and isn't already taken.
        Dataset live = Loader.loadDataset(kgRoot);
        String range = querySingleLiteral(live,
            "PREFIX rfc: <" + RFC_NS + "> "
                + "SELECT ?r WHERE { <" + RFC_INST + rfcId + "> rfc:diagnosticRange ?r } LIMIT 1");
        if (range != null && !codeInRange(code, range)) {
            return error("code " + code + " is outside RFC " + rfcId + "'s declared range " + range);
        }
        if (codeInUse(live, code)) return error("code " + code + " already in use elsewhere in the corpus");

        Model orig = WriteOps.loadFile(file);
        Model neu  = cloneModel(orig);

        Resource doc = neu.createResource(RFC_INST + rfcId);
        Resource diag = neu.createResource(RFC_INST + code);
        Property typeP = neu.createProperty("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
        Resource diagType = neu.createResource(RFC_NS + "Diagnostic");
        Property introP = neu.createProperty(RFC_NS + "introducesDiagnostic");
        Property codeP  = neu.createProperty(RFC_NS + "code");
        Property sevP   = neu.createProperty(RFC_NS + "severity");
        Property descP  = neu.createProperty(RFC_NS + "description");

        neu.add(diag, typeP, diagType);
        neu.add(diag, codeP, code);
        neu.add(diag, sevP, neu.createResource(RFC_NS + severity));
        neu.add(diag, descP, description);
        neu.add(doc, introP, diag);

        WriteOps.Result wr = WriteOps.applyAndCheck(
            List.of(new WriteOps.Edit(file, orig, neu)), kgRoot, apply);
        return finalize(wr, "scaffold-diagnostic",
            Map.of("rfc", rfcId, "code", code, "severity", severity, "applied", wr.wrote()));
    }

    private static boolean codeInRange(String code, String range) {
        // range like "M36000-M36099"
        Matcher m = Pattern.compile("([A-Z]\\d+)-([A-Z]\\d+)").matcher(range);
        if (!m.matches()) return true; // unknown form — don't reject
        if (!code.startsWith(String.valueOf(m.group(1).charAt(0)))) return false;
        try {
            int lo = Integer.parseInt(m.group(1).substring(1));
            int hi = Integer.parseInt(m.group(2).substring(1));
            int v = Integer.parseInt(code.substring(1));
            return v >= lo && v <= hi;
        } catch (NumberFormatException e) {
            return true;
        }
    }

    private static boolean codeInUse(Dataset ds, String code) {
        String q = "PREFIX rfc: <" + RFC_NS + "> ASK { ?d a rfc:Diagnostic ; rfc:code \"" + code + "\" }";
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            return exec.execAsk();
        }
    }

    private static String querySingleLiteral(Dataset ds, String sparql) {
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(sparql), ds)) {
            var rs = exec.execSelect();
            if (!rs.hasNext()) return null;
            var sol = rs.next();
            String v = rs.getResultVars().get(0);
            return sol.contains(v) ? sol.getLiteral(v).getString() : null;
        }
    }

    static Model cloneModel(Model m) {
        Model copy = ModelFactory.createDefaultModel();
        copy.setNsPrefixes(m.getNsPrefixMap());
        copy.add(m);
        return copy;
    }

    static Output.Result error(String msg) {
        return new Output.Result("scaffold-diagnostic", Map.of(), List.of(), List.of(msg), 2);
    }

    static Output.Result finalize(WriteOps.Result wr, String subcommand, Map<String, Object> args) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> op : wr.ops()) {
            @SuppressWarnings("unchecked")
            List<Map<String, String>> removed = (List<Map<String, String>>) op.get("removed");
            for (Map<String, String> t : removed) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("file", op.get("file"));
                r.put("op", "del");
                r.put("triple", shorten(t.get("s")) + " " + shorten(t.get("p")) + " " + shorten(t.get("o")));
                rows.add(r);
            }
            @SuppressWarnings("unchecked")
            List<Map<String, String>> added = (List<Map<String, String>>) op.get("added");
            for (Map<String, String> t : added) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("file", op.get("file"));
                r.put("op", "add");
                r.put("triple", shorten(t.get("s")) + " " + shorten(t.get("p")) + " " + shorten(t.get("o")));
                rows.add(r);
            }
        }
        List<String> messages = new ArrayList<>();
        if (!wr.gatesPassed()) {
            messages.add("preflight gates FAILED — refusing to write:");
            messages.add(GateHarness.renderHuman(wr.gates()));
        } else if (wr.wrote()) {
            messages.add("write applied; all 7 gates pass.");
        } else {
            messages.add("dry-run: all 7 gates pass.");
            messages.add("re-run with --apply to write.");
        }
        return new Output.Result(subcommand, args, rows, messages, wr.gatesPassed() ? 0 : 1);
    }

    private static String shorten(String iri) {
        if (iri.startsWith(RFC_NS)) return ":" + iri.substring(RFC_NS.length());
        if (iri.startsWith(RFC_INST)) return "rfc:" + iri.substring(RFC_INST.length());
        return iri;
    }
}
