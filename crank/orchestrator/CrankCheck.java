package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.Term;
import dev.fastverk.crank.v1.Triple;
import java.util.List;

/**
 * Runs the crank loop with the in-process {@link MockPredictor} and asserts the
 * contract-bound loop behaves: it converges (frontier emptied), the graph grows,
 * the corrector drops a redundant edge each round, and the energy E(G) descends.
 * Wired as a java_test (use_testrunner=False) — a non-zero exit fails the test.
 */
public final class CrankCheck {
  public static void main(String[] args) {
    List<Triple> initial = List.of(
        edge("rc:RFC-0903", "rfc:dependsOn", "rc:RFC-0900"),
        edge("rc:RFC-0901", "rfc:dependsOn", "rc:RFC-0900"),
        edge("rc:RFC-0902", "rfc:dependsOn", "rc:RFC-0900"));
    List<String> frontier = List.of("rc:leafA", "rc:leafB", "rc:leafC");

    CrankOrchestrator orch = new CrankOrchestrator(initial, frontier);
    int startSize = orch.graphSize();
    orch.run(new MockPredictor(), 10, 1.0, 0.6);
    List<EnergySnapshot> s = orch.series();

    check(s.size() == 3, "expected 3 cranks (one per frontier leaf), got " + s.size());
    check(orch.frontier().isEmpty(), "frontier should be empty (converged)");
    check(orch.graphSize() > startSize, "graph should grow from " + startSize);
    check(s.get(0).getRedundancy() >= 1, "corrector should drop a redundant edge each crank");
    double e0 = CrankOrchestrator.energy(s.get(0));
    double eN = CrankOrchestrator.energy(s.get(s.size() - 1));
    check(eN < e0, "E(G) should descend: e0=" + e0 + " eN=" + eN);

    System.out.println("crank loop OK — contract-bound predict->project->gate->measure, E(G) series:");
    for (int i = 0; i < s.size(); i++) {
      EnergySnapshot e = s.get(i);
      System.out.printf(
          "  crank %d:  U=%d  L=%d  S=%d  R=%d   E=%.1f   tau=%.2f%n",
          i + 1, e.getUnderSpec(), e.getConnectivity(), e.getSymmetry(),
          e.getRedundancy(), CrankOrchestrator.energy(e), e.getTemperature());
    }
  }

  private static Triple edge(String s, String p, String o) {
    return Triple.newBuilder().setSubject(iri(s)).setPredicate(iri(p)).setObject(iri(o)).build();
  }

  private static Term iri(String v) {
    return Term.newBuilder().setIri(v).build();
  }

  private static void check(boolean cond, String msg) {
    if (!cond) {
      throw new RuntimeException("CHECK FAILED: " + msg);
    }
  }
}
