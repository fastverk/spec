package rdf.ontology.fixtures;

import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

import org.apache.jena.graph.Node;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.shacl.ShaclValidator;
import org.apache.jena.shacl.Shapes;
import org.apache.jena.shacl.ValidationReport;
import org.apache.jena.shacl.lib.ShLib;
import org.apache.jena.shacl.validation.ReportEntry;

/**
 * The adversarial control for DocumentShape — proof that the profile rule is
 * real, not decorative.
 *
 * rdf_validate_test is pass/fail and produces no report, so it can prove a
 * corpus conforms and cannot prove the shape would have said no. This can: it
 * validates the conforming fixture (must pass), then the four planted
 * violations (must fail, naming EXACTLY those four focus nodes — a shape that
 * also flags the Section nodes, or misses the disguised RFC, fails here), and
 * it asserts the sh:or message actually surfaces in the report, because a
 * refusal nobody can read is a refusal nobody can act on.
 *
 * java_test (use_testrunner=False): a non-zero exit fails the test.
 * args: shapes.ttl aion-rfc.ttl plain-document.ttl document-profile-violations.ttl
 */
public final class AdversarialShapeCheck {
  static final String FX = "https://aion.savvi.io/fixture/documents#";

  public static void main(String[] args) {
    if (args.length != 4) {
      System.err.println("usage: AdversarialShapeCheck shapes.ttl vocab.ttl clean.ttl violations.ttl");
      System.exit(2);
    }
    Shapes shapes = Shapes.parse(RDFDataMgr.loadGraph(args[0]));

    // Negative control: the conforming fixture conforms. A plain document with
    // no sections is the whole point of the profile, so this is the first thing
    // that would go wrong if the branches were miswired.
    ValidationReport clean = ShaclValidator.get().validate(shapes, load(args[1], args[2]).getGraph());
    if (!clean.conforms()) {
      ShLib.printReport(clean);
      fail("plain-document.ttl must conform");
    }

    // Positive control: exactly the four planted documents, and no other node.
    ValidationReport report = ShaclValidator.get().validate(shapes, load(args[1], args[3]).getGraph());
    System.out.println("── validation report over document-profile-violations.ttl ──");
    ShLib.printReport(report);
    check(!report.conforms(), "the planted violations must NOT conform");

    Set<String> focus = report.getEntries().stream()
        .map(e -> uri(e.focusNode()))
        .collect(Collectors.toCollection(TreeSet::new));
    Set<String> planted = new TreeSet<>(Set.of(
        FX + "rfc-without-sections",
        FX + "plain-with-rfc-id",
        FX + "plain-with-whitespace-id",
        FX + "unknown-profile"));
    check(focus.equals(planted),
        "non-conforming focus nodes " + focus + " must be exactly the planted " + planted);

    // Each planted document must fail for ITS reason, not some other.
    check(has(report, "rfc-without-sections", "neither profile"),
        "(i) an RFC with no sections must fail the sh:or, with DocumentShape's message");
    check(has(report, "plain-with-rfc-id", "neither profile"),
        "(ii) the plain marker on an RFC-NNNN id must fail the sh:or — the branches are disjoint");
    check(has(report, "plain-with-whitespace-id", "no whitespace"),
        "(iii) whitespace in an rfcId must fail the core pattern");
    check(has(report, "unknown-profile", "documentProfile"),
        "(iv) an unknown profile must fail the core sh:in");

    System.out.println(
        "adversarial shape OK — plain-document.ttl conforms; the four planted documents are the "
            + "four non-conforming focus nodes, each refused for its own reason, and the sh:or carries "
            + "DocumentShape's message.");
  }

  private static boolean has(ValidationReport report, String local, String messageFragment) {
    return report.getEntries().stream().anyMatch(e ->
        (FX + local).equals(uri(e.focusNode()))
            && e.message() != null
            && e.message().contains(messageFragment));
  }

  private static String uri(Node n) {
    return n.isURI() ? n.getURI() : n.toString();
  }

  private static Model load(String... files) {
    Model m = ModelFactory.createDefaultModel();
    for (String f : files) RDFDataMgr.read(m, f);
    return m;
  }

  private static void check(boolean ok, String what) {
    if (!ok) fail(what);
  }

  private static void fail(String what) {
    System.err.println("ADVERSARIAL SHAPE CHECK FAILED: " + what);
    System.exit(1);
  }
}
