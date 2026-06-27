package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.Triple;
import java.util.Collection;

/**
 * The crank's <em>measure</em> step, factored out so the orchestrator can be run
 * with either the fast in-Java {@link HeuristicEnergy} or the real
 * {@link JenaEnergy} (ARQ SPARQL over a Jena model, the same queries the
 * {@code //corpus} energy targets use). E(G) = R + C + D + w·U − L − w·S; the
 * weights live in {@link CrankOrchestrator#energy}.
 */
public interface EnergyModel {
  /**
   * @param graph the current asserted triples (a set)
   * @param frontierSize U — count of under-specified leaves still open
   * @param redundant a per-crank redundancy hint (proposed adds already present);
   *     a SPARQL model may instead derive R structurally and ignore this
   * @param tau the annealing temperature to stamp on the snapshot
   */
  EnergySnapshot measure(Collection<Triple> graph, int frontierSize, int redundant, double tau);
}
