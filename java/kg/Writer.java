package kg;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import org.apache.jena.datatypes.RDFDatatype;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.RDFNode;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.rdf.model.StmtIterator;

/**
 * Deterministic Turtle serializer.
 *
 * Same set of triples → same bytes, regardless of triple-add order or
 * the blank-node IDs Jena happens to assign on this load. This is the
 * property that lets {@code kg_edit} write back cleanly: an untouched
 * Model serializes to byte-identical TTL on every run, so the only diff
 * in a refactor PR is the actual semantic change.
 *
 * The shape:
 *   - Prefix block emitted in a stable order (declared list first, then
 *     anything else the model carries, lexicographic).
 *   - Subjects grouped, named subjects (IRIs) before blank nodes.
 *   - Within a subject, predicates sorted lexicographically.
 *   - Within (subject, predicate), objects sorted by serialized form.
 *   - Blank-node labels assigned by content-hash rank, so a bnode whose
 *     outgoing star matches another's gets the same label across runs.
 *
 * Output style:
 *   subject
 *       a Class ;
 *       prop1 obj1 ;
 *       prop2 obj2 .
 *
 *   This matches the human-edited Turtle convention used in
 *   {@code kg/ontology/aion-rfc.ttl}.
 */
public final class Writer {

    /** Prefix order to emit when present. Anything else gets appended
     *  alphabetically. */
    private static final List<String> PREFIX_ORDER = List.of(
        "rdf", "rdfs", "owl", "xsd", "sh", "skos",
        "rfc", "d", "claim", "kp"
    );

    private Writer() {}

    public static void writeStable(Model model, OutputStream out) throws IOException {
        writeStable(model, model, out);
    }

    /**
     * Serialize {@code model} to TTL but compute blank-node labels from
     * {@code context}. Use this when {@code model} is a slice of a larger
     * graph (e.g., the inferred-only subset of a closure) — stable bnode
     * labels require full-graph context, otherwise the slice's thin
     * outgoing stars hash-collide and tiebreaker order varies across runs.
     */
    public static void writeStable(Model model, Model context, OutputStream out) throws IOException {
        // Compute labels over the union: bnodes in `context` get stable
        // hash-based labels; bnodes that exist only in `model` (e.g.,
        // provenance reifications kg_reasoner creates) ride along with
        // the same labelling pass so they get distinct labels too.
        Model union = ModelFactory.createDefaultModel();
        union.add(context);
        union.add(model);
        Map<String, String> bnodeLabels = assignBlankLabels(union);
        try (java.io.Writer w = new OutputStreamWriter(out, StandardCharsets.UTF_8)) {
            writePrefixes(model, w);
            writeBody(model, bnodeLabels, w);
        }
    }

    public static byte[] writeStable(Model model) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(8192);
        writeStable(model, buf);
        return buf.toByteArray();
    }

    public static byte[] writeStable(Model model, Model context) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(8192);
        writeStable(model, context, buf);
        return buf.toByteArray();
    }

    public static void writeStableTo(Model model, Path file) throws IOException {
        Files.write(file, writeStable(model));
    }

    // -----------------------------------------------------------------------
    // Prefix block
    // -----------------------------------------------------------------------

    private static void writePrefixes(Model model, java.io.Writer w) throws IOException {
        Map<String, String> prefixMap = model.getNsPrefixMap();
        Set<String> remaining = new TreeSet<>(prefixMap.keySet());
        for (String pref : PREFIX_ORDER) {
            if (remaining.remove(pref)) {
                w.write("@prefix ");
                w.write(pref);
                w.write(": <");
                w.write(prefixMap.get(pref));
                w.write("> .\n");
            }
        }
        for (String pref : remaining) {
            w.write("@prefix ");
            w.write(pref);
            w.write(": <");
            w.write(prefixMap.get(pref));
            w.write("> .\n");
        }
        w.write("\n");
    }

    // -----------------------------------------------------------------------
    // Body — subjects, predicates, objects
    // -----------------------------------------------------------------------

    private static void writeBody(Model model, Map<String, String> bnodeLabels, java.io.Writer w) throws IOException {
        // Group statements by subject.
        Map<Resource, List<Statement>> bySubject = new LinkedHashMap<>();
        StmtIterator it = model.listStatements();
        while (it.hasNext()) {
            Statement s = it.nextStatement();
            bySubject.computeIfAbsent(s.getSubject(), k -> new ArrayList<>()).add(s);
        }

        List<Resource> subjects = new ArrayList<>(bySubject.keySet());
        subjects.sort(subjectComparator(bnodeLabels));

        boolean first = true;
        for (Resource subj : subjects) {
            if (!first) w.write("\n");
            first = false;
            writeSubjectBlock(subj, bySubject.get(subj), bnodeLabels, model, w);
        }
    }

    private static void writeSubjectBlock(Resource subj, List<Statement> stmts,
                                          Map<String, String> bnodeLabels, Model model,
                                          java.io.Writer w) throws IOException {
        w.write(renderResource(subj, bnodeLabels, model));
        w.write("\n");

        // Sort predicates; rdf:type goes first (rendered as `a`).
        Map<Property, List<RDFNode>> byPred = new LinkedHashMap<>();
        for (Statement s : stmts) {
            byPred.computeIfAbsent(s.getPredicate(), k -> new ArrayList<>()).add(s.getObject());
        }
        List<Property> preds = new ArrayList<>(byPred.keySet());
        preds.sort((a, b) -> {
            boolean aType = a.getURI().equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
            boolean bType = b.getURI().equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
            if (aType != bType) return aType ? -1 : 1;
            return a.getURI().compareTo(b.getURI());
        });

        for (int i = 0; i < preds.size(); i++) {
            Property p = preds.get(i);
            List<RDFNode> objects = byPred.get(p);
            // Sort multi-valued objects by their rendered form.
            List<String> rendered = new ArrayList<>(objects.size());
            for (RDFNode o : objects) rendered.add(renderObject(o, bnodeLabels, model));
            rendered.sort(Comparator.naturalOrder());

            String predStr = p.getURI().equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
                ? "a"
                : renderResource(p, bnodeLabels, model);

            // First object: indent + predicate + " " + object.
            // Subsequent objects: indent + comma + object (predicate not repeated).
            String predIndent = "    ";
            String contIndent = "        ";
            boolean lastPred = (i == preds.size() - 1);
            for (int j = 0; j < rendered.size(); j++) {
                if (j == 0) {
                    w.write(predIndent);
                    w.write(predStr);
                    w.write(" ");
                } else {
                    w.write(contIndent);
                }
                w.write(rendered.get(j));
                boolean lastObject = (j == rendered.size() - 1);
                if (!lastObject) {
                    w.write(" ,\n");
                } else if (lastPred) {
                    w.write(" .\n");
                } else {
                    w.write(" ;\n");
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Node rendering
    // -----------------------------------------------------------------------

    private static String renderResource(Resource r, Map<String, String> bnodeLabels, Model model) {
        if (r.isAnon()) return "_:" + bnodeLabels.get(r.getId().getLabelString());
        return shortenIri(r.getURI(), model);
    }

    private static String renderObject(RDFNode o, Map<String, String> bnodeLabels, Model model) {
        if (o.isResource()) return renderResource(o.asResource(), bnodeLabels, model);
        // Literal.
        var lit = o.asLiteral();
        String lex = lit.getLexicalForm();
        String lang = lit.getLanguage();
        RDFDatatype dt = lit.getDatatype();
        StringBuilder out = new StringBuilder();
        out.append('"').append(escapeString(lex)).append('"');
        if (lang != null && !lang.isEmpty()) {
            out.append('@').append(lang);
        } else if (dt != null
                   && !dt.getURI().equals(XSDDatatype.XSDstring.getURI())
                   && !dt.getURI().equals("http://www.w3.org/1999/02/22-rdf-syntax-ns#langString")) {
            out.append("^^").append(shortenIri(dt.getURI(), model));
        }
        return out.toString();
    }

    private static String shortenIri(String iri, Model model) {
        // Try to use a known prefix.
        for (Map.Entry<String, String> e : model.getNsPrefixMap().entrySet()) {
            String ns = e.getValue();
            if (iri.startsWith(ns) && iri.length() > ns.length()) {
                String local = iri.substring(ns.length());
                if (isValidPnLocal(local)) return e.getKey() + ":" + local;
            }
        }
        return "<" + iri + ">";
    }

    /** Conservative PN_LOCAL acceptance — fall back to angle-bracketed
     *  form if the local part contains anything beyond ASCII letters,
     *  digits, hyphens, dots, or underscores. Notably DOES NOT include
     *  '/' — Turtle's PN_LOCAL grammar (SPARQL 1.1) forbids unescaped
     *  slashes, so {@code rfc:RFC-0036/term/x} would parse as nonsense.
     *  Such IRIs get angle-bracketed by the writer instead. */
    private static boolean isValidPnLocal(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                  || (c >= '0' && c <= '9')
                  || c == '_' || c == '-' || c == '.')) {
                return false;
            }
        }
        return true;
    }

    private static String escapeString(String s) {
        StringBuilder out = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': out.append("\\\\"); break;
                case '"':  out.append("\\\""); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:   out.append(c);
            }
        }
        return out.toString();
    }

    // -----------------------------------------------------------------------
    // Stable blank-node labels
    // -----------------------------------------------------------------------

    /**
     * Compute a content-stable label for every blank node in the model.
     *
     * Algorithm: tag each bnode with a hash of its outgoing predicate-object
     * stars, recursively for nested bnodes (with cycle protection). Sort by
     * hash and assign sequential `b1`, `b2`, ... labels. Two models with
     * isomorphic bnode subgraphs produce the same label assignment.
     *
     * Note: this is a simple iterative approximation, not a full canonical
     * labelling (which is graph-isomorphism-hard in the worst case). It's
     * good enough for the Aion corpus where bnode subgraphs are shallow
     * and rarely identical (NormativeStatements differ by predicate text).
     */
    private static Map<String, String> assignBlankLabels(Model model) {
        // Collect all bnode IDs.
        Set<String> bnodeIds = new HashSet<>();
        StmtIterator it = model.listStatements();
        while (it.hasNext()) {
            Statement s = it.nextStatement();
            if (s.getSubject().isAnon()) bnodeIds.add(s.getSubject().getId().getLabelString());
            if (s.getObject().isResource() && s.getObject().asResource().isAnon())
                bnodeIds.add(s.getObject().asResource().getId().getLabelString());
        }

        // Hash each bnode's outgoing star.
        Map<String, String> hashes = new HashMap<>();
        for (String id : bnodeIds) hashes.put(id, hashBnodeStar(model, id, new HashSet<>()));

        // Sort by hash, then by original id (tiebreaker for collisions);
        // assign b1..bN.
        List<String> sorted = new ArrayList<>(bnodeIds);
        sorted.sort((a, b) -> {
            int c = hashes.get(a).compareTo(hashes.get(b));
            return c != 0 ? c : a.compareTo(b);
        });

        Map<String, String> labels = new HashMap<>();
        for (int i = 0; i < sorted.size(); i++) {
            labels.put(sorted.get(i), "b" + (i + 1));
        }
        return labels;
    }

    private static String hashBnodeStar(Model model, String bnodeId, Set<String> visiting) {
        if (visiting.contains(bnodeId)) return "[cycle]";
        visiting.add(bnodeId);
        try {
            Resource r = model.createResource(new org.apache.jena.rdf.model.AnonId(bnodeId));
            // Collect (predicate, object-rendered) pairs, sorted.
            TreeSet<String> pairs = new TreeSet<>();
            StmtIterator it = model.listStatements(r, null, (RDFNode) null);
            while (it.hasNext()) {
                Statement s = it.nextStatement();
                String pred = s.getPredicate().getURI();
                RDFNode o = s.getObject();
                String obj;
                if (o.isLiteral()) {
                    obj = "L:" + o.asLiteral().getLexicalForm();
                } else if (o.asResource().isAnon()) {
                    obj = "B:" + hashBnodeStar(model, o.asResource().getId().getLabelString(),
                                                new HashSet<>(visiting));
                } else {
                    obj = "I:" + o.asResource().getURI();
                }
                pairs.add(pred + "|" + obj);
            }
            return sha1(String.join(";", pairs));
        } finally {
            visiting.remove(bnodeId);
        }
    }

    private static String sha1(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] hash = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(40);
            for (byte b : hash) out.append(String.format("%02x", b));
            return out.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    // -----------------------------------------------------------------------
    // Subject ordering
    // -----------------------------------------------------------------------

    private static Comparator<Resource> subjectComparator(Map<String, String> bnodeLabels) {
        return (a, b) -> {
            boolean aAnon = a.isAnon();
            boolean bAnon = b.isAnon();
            if (aAnon != bAnon) return aAnon ? 1 : -1; // named first
            if (aAnon) {
                return bnodeLabels.get(a.getId().getLabelString())
                    .compareTo(bnodeLabels.get(b.getId().getLabelString()));
            }
            return a.getURI().compareTo(b.getURI());
        };
    }
}
