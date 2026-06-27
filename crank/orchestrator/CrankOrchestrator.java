package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.GraphDelta;
import dev.fastverk.crank.v1.PredictRequest;
import dev.fastverk.crank.v1.PredictResponse;
import dev.fastverk.crank.v1.Triple;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The crank loop driver: {@code predict → project → gate → measure}, annealing
 * τ→0. It dials a {@link CrankPredictor} (the fleet contract), applies the
 * returned {@link GraphDelta}, runs the deterministic corrector (here, the
 * proven dedup over the asserted-triple set — see {@code Spec.Compaction}),
 * recomputes the energy, and records the {@link EnergySnapshot} series. This is
 * an in-process sketch over proto types; the production driver swaps the
 * predictor for the gRPC stub and the energy/gate for the Jena SPARQL targets in
 * //corpus, but the control flow is exactly this.
 */
public final class CrankOrchestrator {
  private final LinkedHashSet<Triple> graph = new LinkedHashSet<>();
  private final List<String> frontier = new ArrayList<>();
  private final List<EnergySnapshot> series = new ArrayList<>();

  public CrankOrchestrator(Collection<Triple> initial, List<String> frontierLeaves) {
    graph.addAll(initial);
    frontier.addAll(frontierLeaves);
  }

  public List<EnergySnapshot> series() {
    return series;
  }

  public int graphSize() {
    return graph.size();
  }

  public List<String> frontier() {
    return frontier;
  }

  /** One crank: predict → project (dedup) → measure. Returns null on abstain (converged). */
  public EnergySnapshot crank(CrankPredictor predictor, double tau) {
    PredictRequest req = PredictRequest.newBuilder()
        .addAllContext(graph)
        .setEnergy(measure(tau, 0))
        .addAllFrontier(frontier)
        .addAllowedPrefixes("rfc")
        .addAllowedPrefixes("rc")
        .setCorpusId("ratio")
        .build();

    PredictResponse resp = predictor.predict(req);
    GraphDelta d = resp.getDelta();
    if (d.getAddCount() == 0 && d.getRemoveCount() == 0) {
      return null; // abstain — the crystal: no accepted move lowers E
    }

    // Project (the corrector): the graph is a set, so dedup is automatic and
    // idempotent (Spec.Compaction.dedupE_idem). Count adds already present = R.
    int redundant = 0;
    for (Triple t : d.getAddList()) {
      if (graph.contains(t)) {
        redundant++;
      }
    }
    graph.addAll(d.getAddList());
    d.getRemoveList().forEach(graph::remove);

    // Any frontier leaf now specified (appears as a subject) leaves the frontier.
    frontier.removeIf(leaf -> graph.stream().anyMatch(t -> t.getSubject().getIri().equals(leaf)));

    EnergySnapshot snap = measure(tau, redundant);
    series.add(snap);
    return snap;
  }

  /** Run the annealed loop until the fleet abstains (converged) or rounds run out. */
  public void run(CrankPredictor predictor, int rounds, double tau0, double decay) {
    double tau = tau0;
    for (int i = 0; i < rounds; i++) {
      if (crank(predictor, tau) == null) {
        break;
      }
      tau *= decay;
    }
  }

  private EnergySnapshot measure(double tau, int redundant) {
    int edges = 0;
    Set<String> predicates = new HashSet<>();
    for (Triple t : graph) {
      String p = t.getPredicate().getIri();
      predicates.add(p);
      if (p.contains("depends") || p.contains("refines") || p.contains("hasClaim")) {
        edges++;
      }
    }
    return EnergySnapshot.newBuilder()
        .setRedundancy(redundant)
        .setContradictions(0)
        .setDangling(0)
        .setUnderSpec(frontier.size())
        .setConnectivity(edges)
        .setSymmetry(predicates.size())
        .setTemperature(tau)
        .build();
  }

  /** The spec energy E(G) (toy weights) — what the crank drives down. */
  public static double energy(EnergySnapshot e) {
    return e.getRedundancy() + e.getContradictions() + e.getDangling()
        + 2.0 * e.getUnderSpec() - 1.0 * e.getConnectivity() - 2.0 * e.getSymmetry();
  }
}
