package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.Triple;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;

/**
 * The fast, dependency-free measure: counts typed edges (L) and distinct
 * predicates (S) in-process, takes U from the frontier and R from the per-crank
 * redundancy hint. Used by {@link CrankCheck} / {@link GrpcRoundTrip} so those
 * stay free of a Jena dependency; {@link JenaEnergy} is the real-SPARQL twin.
 */
public final class HeuristicEnergy implements EnergyModel {
  @Override
  public EnergySnapshot measure(Collection<Triple> graph, int frontierSize, int redundant, double tau) {
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
        .setUnderSpec(frontierSize)
        .setConnectivity(edges)
        .setSymmetry(predicates.size())
        .setTemperature(tau)
        .build();
  }
}
