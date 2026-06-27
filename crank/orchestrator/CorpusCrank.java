package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;

/**
 * Runs the crank against the FULL materialized ratio corpus — {@code
 * ratio-corpus.ttl} loaded straight into Jena — not the synthetic demo graph.
 *
 * <p>The measure + gate are the real ones ({@link JenaEnergy} / {@link JenaGate},
 * ARQ SPARQL). The frontier here is the corpus's <em>ungrounded claims</em>:
 * NormativeStatements with no {@code provenBy} (only the two kernel invariants
 * core-2 / core-12 are proven in the seed). A crank grounds one claim — the
 * grounding the agora fleet's proposer would supply — which drops U and lowers
 * the real E(G). The grounding move is deterministic here (the LLM proposer is
 * the one remaining non-hermetic piece); everything measured is real.
 *
 * <p>Asserts the SPARQL-measured E(G) descends strictly, crank over crank, on the
 * real corpus, and the gate keeps the dependsOn DAG acyclic throughout.
 *
 * <p>java_test with use_testrunner=False: a non-zero exit fails the test.
 */
public final class CorpusCrank {
  private static final String PROVEN_BY = JenaGraph.RFC + "provenBy";

  public static void main(String[] args) throws Exception {
    Model corpus = loadCorpus();
    JenaEnergy energy = new JenaEnergy();
    JenaGate gate = new JenaGate();

    int claims = countClaims(corpus);
    int u0 = countUngrounded(corpus);
    EnergySnapshot base = energy.measureModel(corpus, u0, 1.0);
    check(claims > u0, "the seed should have some grounded claims (core-2/core-12)");
    check(gate.passesModel(corpus), "the seed corpus must be an acyclic DAG");

    System.out.printf(
        "loaded ratio-corpus.ttl — %d claims, %d ungrounded (U), L=%d R=%d S=%d  E=%.1f%n",
        claims, u0, base.getConnectivity(), base.getRedundancy(), base.getSymmetry(),
        CrankOrchestrator.energy(base));

    // Crank: ground one ungrounded claim per round; real E(G) must fall each time.
    List<EnergySnapshot> series = new ArrayList<>();
    double tau = 1.0;
    int rounds = 5;
    for (int i = 0; i < rounds; i++) {
      String leaf = firstUngrounded(corpus);
      if (leaf == null) {
        break; // converged — every claim grounded
      }
      // predict + project: the grounding delta (a proven-by edge for the leaf).
      corpus.add(
          corpus.createResource(leaf),
          corpus.createProperty(PROVEN_BY),
          corpus.createLiteral("Ratio.Lemma." + localName(leaf)));
      // gate: the dependsOn DAG must stay acyclic.
      check(gate.passesModel(corpus), "grounding must not break the DAG");
      // measure: real E(G) over the mutated corpus.
      int u = countUngrounded(corpus);
      EnergySnapshot snap = energy.measureModel(corpus, u, tau);
      series.add(snap);
      tau *= 0.6;
    }

    check(!series.isEmpty(), "expected at least one crank on the real corpus");
    double prev = CrankOrchestrator.energy(base);
    for (EnergySnapshot s : series) {
      double e = CrankOrchestrator.energy(s);
      check(e < prev, "real E(G) must descend crank over crank: " + e + " !< " + prev);
      prev = e;
    }
    check(
        series.get(series.size() - 1).getUnderSpec() == u0 - series.size(),
        "U should drop by one per crank");

    System.out.println("corpus crank OK — real ARQ SPARQL E(G) over ratio-corpus.ttl descends:");
    System.out.printf("  seed:     U=%d  E=%.1f%n", base.getUnderSpec(), CrankOrchestrator.energy(base));
    for (int i = 0; i < series.size(); i++) {
      EnergySnapshot s = series.get(i);
      System.out.printf(
          "  crank %d:  U=%d  L=%d  S=%d  R=%d   E=%.1f   tau=%.2f%n",
          i + 1, s.getUnderSpec(), s.getConnectivity(), s.getSymmetry(),
          s.getRedundancy(), CrankOrchestrator.energy(s), s.getTemperature());
    }
  }

  private static Model loadCorpus() throws Exception {
    Model m = ModelFactory.createDefaultModel();
    try (InputStream in = CorpusCrank.class.getResourceAsStream("/ratio-corpus.ttl")) {
      if (in == null) {
        throw new IllegalStateException("ratio-corpus.ttl not on the classpath");
      }
      RDFDataMgr.read(m, in, Lang.TURTLE);
    }
    return m;
  }

  private static int countClaims(Model m) {
    return JenaGraph.count(m, "SELECT ?n WHERE { ?n a rfc:NormativeStatement }");
  }

  private static int countUngrounded(Model m) {
    return JenaGraph.count(
        m,
        "SELECT ?n WHERE { ?n a rfc:NormativeStatement ."
            + " FILTER NOT EXISTS { ?n rfc:provenBy ?p } }");
  }

  /** The first ungrounded claim's IRI, in a stable order, or null if none. */
  private static String firstUngrounded(Model m) {
    String q =
        JenaGraph.PREFIXES
            + "SELECT ?n WHERE { ?n a rfc:NormativeStatement ."
            + " FILTER NOT EXISTS { ?n rfc:provenBy ?p } } ORDER BY STR(?n) LIMIT 1";
    try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), m)) {
      ResultSet rs = exec.execSelect();
      if (rs.hasNext()) {
        QuerySolution s = rs.next();
        return s.getResource("n").getURI();
      }
      return null;
    }
  }

  private static String localName(String iri) {
    int slash = Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#'));
    return slash >= 0 ? iri.substring(slash + 1) : iri;
  }

  private static void check(boolean cond, String msg) {
    if (!cond) {
      throw new RuntimeException("CHECK FAILED: " + msg);
    }
  }
}
