package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.GraphDelta;
import dev.fastverk.crank.v1.PredictRequest;
import dev.fastverk.crank.v1.PredictResponse;
import dev.fastverk.crank.v1.Term;
import dev.fastverk.crank.v1.Triple;
import java.util.List;

/**
 * Proves the crank's measure + gate are REAL — ARQ SPARQL over a Jena model, the
 * same queries the {@code //corpus} energy/consistency targets use — not the
 * in-Java heuristic. Three checks:
 *
 * <ol>
 *   <li><b>the loop descends on real E(G)</b>: run the orchestrator with
 *       {@link JenaEnergy} + {@link JenaGate} and a fleet that grounds each
 *       frontier leaf with a typed {@code dependsOn} edge — U falls, L rises, and
 *       the SPARQL-measured energy descends to convergence;
 *   <li><b>R is structural</b>: {@link JenaEnergy} counts a transitively-implied
 *       {@code dependsOn} edge as redundancy, and removing it (the transitive
 *       reduction the corrector performs) lowers the real E(G);
 *   <li><b>the gate is real</b>: {@link JenaGate} admits the acyclic crank graph
 *       and rejects one with a {@code dependsOn} cycle.
 * </ol>
 *
 * java_test with use_testrunner=False: a non-zero exit fails the test.
 */
public final class JenaEnergyCheck {
  public static void main(String[] args) {
    // (1) The loop, measured by real SPARQL, descends.
    List<Triple> initial =
        List.of(
            edge("rc:RFC-0903", "rfc:dependsOn", "rc:RFC-0900"),
            edge("rc:RFC-0901", "rfc:dependsOn", "rc:RFC-0900"),
            edge("rc:RFC-0902", "rfc:dependsOn", "rc:RFC-0900"));
    List<String> frontier = List.of("rc:leafA", "rc:leafB", "rc:leafC");

    CrankOrchestrator orch =
        new CrankOrchestrator(initial, frontier, new JenaEnergy(), new JenaGate());
    orch.run(new DependsPredictor(), 10, 1.0, 0.6);
    List<EnergySnapshot> s = orch.series();

    check(s.size() == 3, "expected 3 cranks (one per leaf), got " + s.size());
    check(orch.frontier().isEmpty(), "frontier should be empty (converged)");
    double e0 = CrankOrchestrator.energy(s.get(0));
    double eN = CrankOrchestrator.energy(s.get(s.size() - 1));
    check(eN < e0, "real Jena E(G) should descend: e0=" + e0 + " eN=" + eN);
    check(s.get(s.size() - 1).getUnderSpec() == 0, "U should reach 0");
    check(s.get(s.size() - 1).getConnectivity() == 6, "L should be 6 typed edges (3+3)");

    // (2) Redundancy is structural: a transitively-implied edge is counted, and
    // the transitive reduction (corrector) lowers E.
    JenaEnergy je = new JenaEnergy();
    List<Triple> withRedundant =
        List.of(
            edge("rc:A", "rfc:dependsOn", "rc:B"),
            edge("rc:B", "rfc:dependsOn", "rc:C"),
            edge("rc:A", "rfc:dependsOn", "rc:C")); // implied by A→B→C
    EnergySnapshot before = je.measure(withRedundant, 0, 0, 1.0);
    check(before.getRedundancy() == 1, "transitively-implied A→C counted as R, got " + before.getRedundancy());

    List<Triple> reduced =
        List.of(edge("rc:A", "rfc:dependsOn", "rc:B"), edge("rc:B", "rfc:dependsOn", "rc:C"));
    EnergySnapshot after = je.measure(reduced, 0, 0, 1.0);
    check(after.getRedundancy() == 0, "reduction removes R, got " + after.getRedundancy());
    check(
        CrankOrchestrator.energy(after) < CrankOrchestrator.energy(before),
        "transitive reduction lowers real E(G)");

    // (3) The gate is real: cycles are rejected.
    JenaGate gate = new JenaGate();
    check(gate.passes(initial), "acyclic crank graph should pass the gate");
    List<Triple> cyclic =
        List.of(edge("rc:X", "rfc:dependsOn", "rc:Y"), edge("rc:Y", "rfc:dependsOn", "rc:X"));
    check(!gate.passes(cyclic), "a dependsOn cycle should be rejected by the gate");

    System.out.println("Jena measure/gate OK — real ARQ SPARQL E(G) over the crank graph. Series:");
    for (int i = 0; i < s.size(); i++) {
      EnergySnapshot e = s.get(i);
      System.out.printf(
          "  crank %d:  U=%d  L=%d  S=%d  R=%d  D=%d  C=%d   E=%.1f   tau=%.2f%n",
          i + 1,
          e.getUnderSpec(),
          e.getConnectivity(),
          e.getSymmetry(),
          e.getRedundancy(),
          e.getDangling(),
          e.getContradictions(),
          CrankOrchestrator.energy(e),
          e.getTemperature());
    }
    System.out.printf(
        "  redundancy: R(A→B→C, A→C)=%d  →  R(reduced)=%d   (E %.1f → %.1f)%n",
        before.getRedundancy(),
        after.getRedundancy(),
        CrankOrchestrator.energy(before),
        CrankOrchestrator.energy(after));
  }

  /** A fleet that grounds the first open leaf with a typed dependsOn edge. */
  static final class DependsPredictor implements CrankPredictor {
    @Override
    public PredictResponse predict(PredictRequest req) {
      if (req.getFrontierCount() == 0) {
        return PredictResponse.newBuilder().build(); // abstain — converged
      }
      String leaf = req.getFrontier(0);
      GraphDelta delta =
          GraphDelta.newBuilder().addAdd(edge(leaf, "rfc:dependsOn", "rc:RFC-0900")).build();
      return PredictResponse.newBuilder().setDelta(delta).build();
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
