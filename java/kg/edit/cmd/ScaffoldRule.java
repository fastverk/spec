package kg.edit.cmd;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.Resource;

import kg.Loader;
import kg.edit.Output;
import kg.edit.WriteOps;

/**
 * Add a normative statement (rule) to an RFC section, promoted to a
 * stable IRI of the form rfc:RFC-NNNN/sec-{N}/rule-{seq}.
 *
 *   kg_edit scaffold-rule \
 *       --rfc RFC-NNNN --section 4 \
 *       --modality MUST \
 *       --predicate "..." \
 *       [--rationale "..."] \
 *       [--emits MNNxxx]
 *
 * Validates:
 *   - the RFC + section exist
 *   - modality is one of MUST / MUST_NOT / SHOULD / SHOULD_NOT / MAY
 *   - --emits diagnostic exists in the corpus (if provided)
 */
public final class ScaffoldRule {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String RFC_INST = "https://aion.savvi.io/rfc/";
    private static final List<String> MODALITIES =
        List.of("MUST", "MUST_NOT", "SHOULD", "SHOULD_NOT", "MAY");

    private ScaffoldRule() {}

    public static Output.Result run(Path kgRoot, String rfcId, String section, String modality,
                                    String predicate, String rationale, String emitsCode, boolean apply) throws IOException {
        if (!MODALITIES.contains(modality)) return error("modality must be one of: " + MODALITIES);
        if (predicate == null || predicate.isBlank()) return error("--predicate is required");
        Path file = WriteOps.turtleFileFor(kgRoot, rfcId);
        if (!Files.isRegularFile(file)) return error("RFC TTL not found: " + file);

        Dataset live = Loader.loadDataset(kgRoot);

        String sectionIri = RFC_INST + rfcId + "#sec-" + section;
        if (!sectionExists(live, sectionIri)) {
            return error("section " + sectionIri + " does not exist in " + rfcId);
        }

        Resource emitsDiag = null;
        if (emitsCode != null && !emitsCode.isBlank()) {
            String diagIri = lookupDiagnosticByCode(live, emitsCode);
            if (diagIri == null) {
                return error("--emits diagnostic " + emitsCode + " not found in corpus");
            }
            emitsDiag = ((Model) live.getDefaultModel()).createResource(diagIri);
        }

        // Allocate a stable rule sequence number within the section.
        int seq = nextRuleSeq(live, rfcId, section);
        String ruleIri = RFC_INST + rfcId + "/sec-" + section + "/rule-" + seq;

        Model orig = WriteOps.loadFile(file);
        Model neu  = ScaffoldDiagnostic.cloneModel(orig);
        Resource sec = neu.createResource(sectionIri);
        Resource rule = neu.createResource(ruleIri);
        Property typeP = neu.createProperty("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
        Resource normType = neu.createResource(RFC_NS + "NormativeStatement");
        Property modP = neu.createProperty(RFC_NS + "modality");
        Property predP = neu.createProperty(RFC_NS + "predicate");
        Property contains = neu.createProperty(RFC_NS + "containsRule");

        neu.add(rule, typeP, normType);
        neu.add(rule, modP, neu.createResource(RFC_NS + modality));
        neu.add(rule, predP, predicate);
        if (rationale != null && !rationale.isBlank()) {
            neu.add(rule, neu.createProperty(RFC_NS + "rationale"), rationale);
        }
        if (emitsDiag != null) {
            neu.add(rule, neu.createProperty(RFC_NS + "emits"), neu.createResource(emitsDiag.getURI()));
        }
        neu.add(sec, contains, rule);

        WriteOps.Result wr = WriteOps.applyAndCheck(
            List.of(new WriteOps.Edit(file, orig, neu)), kgRoot, apply);
        return ScaffoldDiagnostic.finalize(wr, "scaffold-rule",
            Map.of("rfc", rfcId, "section", section, "modality", modality,
                   "iri", ruleIri, "emits", emitsCode == null ? "" : emitsCode,
                   "applied", wr.wrote()));
    }

    private static boolean sectionExists(Dataset ds, String iri) {
        String q = "PREFIX rfc: <" + RFC_NS + "> ASK { <" + iri + "> a rfc:Section }";
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            return exec.execAsk();
        }
    }

    private static String lookupDiagnosticByCode(Dataset ds, String code) {
        String q = "PREFIX rfc: <" + RFC_NS + "> "
            + "SELECT ?d WHERE { ?d a rfc:Diagnostic ; rfc:code \"" + code + "\" } LIMIT 1";
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            var rs = exec.execSelect();
            if (!rs.hasNext()) return null;
            return rs.next().getResource("d").getURI();
        }
    }

    private static int nextRuleSeq(Dataset ds, String rfcId, String section) {
        // Find all rule-N IRIs under this section, return max+1.
        String prefix = RFC_INST + rfcId + "/sec-" + section + "/rule-";
        String q = "SELECT ?r WHERE { ?r ?p ?o . FILTER (STRSTARTS(STR(?r), \"" + prefix + "\")) }";
        int max = 0;
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            var rs = exec.execSelect();
            while (rs.hasNext()) {
                String iri = rs.next().getResource("r").getURI();
                String suffix = iri.substring(prefix.length());
                try { max = Math.max(max, Integer.parseInt(suffix)); }
                catch (NumberFormatException ignore) {}
            }
        }
        return max + 1;
    }

    private static Output.Result error(String msg) {
        return new Output.Result("scaffold-rule", Map.of(), List.of(), List.of(msg), 2);
    }
}
