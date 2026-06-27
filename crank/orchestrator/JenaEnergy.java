package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.Triple;
import java.util.Collection;
import org.apache.jena.rdf.model.Model;

/**
 * The real measure step: builds a Jena model from the crank graph and computes
 * the E(G) terms with ARQ SPARQL — the same patterns the {@code //corpus} energy
 * targets use (eg-measure / compaction-measure), not an in-Java heuristic.
 *
 * <ul>
 *   <li><b>L</b> connectivity — <em>meaningful</em> typed edges: the
 *       transitive-reduction count of dependsOn (a redundant edge adds no
 *       reachability, so it is not real connectivity) plus refines / references,
 *       matching {@code compaction-measure.rq}'s "edges (after reduction)".
 *   <li><b>R</b> redundancy — transitively-implied dependsOn edges
 *       ({@code ?a dependsOn ?c} with a longer {@code ?a→?b→…→?c} path); exactly
 *       what the transitive-reduction corrector removes. A redundant edge raises
 *       R without raising L, so the reduction strictly lowers E(G).
 *   <li><b>S</b> symmetry — distinct predicate types (an MDL proxy).
 *   <li><b>U</b> under-spec — the frontier size (the open leaves).
 *   <li><b>D</b> dangling — refines/references targets that are never a subject.
 *   <li><b>C</b> contradictions — a node asserted both MUST and MUST_NOT.
 * </ul>
 *
 * The {@code redundant} hint is ignored — R is derived structurally from the
 * graph, which is the honest definition.
 */
public final class JenaEnergy implements EnergyModel {

  @Override
  public EnergySnapshot measure(Collection<Triple> graph, int frontierSize, int redundant, double tau) {
    Model m = JenaGraph.toModel(graph);

    // L = transitive-reduction count of dependsOn (drop transitively-implied
    // edges — they are R, not real connectivity) + refines + references.
    int connectivity =
        JenaGraph.count(
            m,
            "SELECT * WHERE {"
                + " { ?a rfc:dependsOn ?c ."
                + "   FILTER NOT EXISTS { ?a rfc:dependsOn ?b . ?b (rfc:dependsOn)+ ?c ."
                + "                       FILTER(?a != ?b && ?b != ?c) } }"
                + " UNION { ?a rfc:refines ?c }"
                + " UNION { ?a rfc:references ?c } }");

    int redundancy =
        JenaGraph.count(
            m,
            "SELECT DISTINCT ?a ?c WHERE {"
                + " ?a rfc:dependsOn ?c . ?a rfc:dependsOn ?b . ?b (rfc:dependsOn)+ ?c ."
                + " FILTER(?a != ?b && ?b != ?c) }");

    int symmetry = JenaGraph.count(m, "SELECT DISTINCT ?p WHERE { ?a ?p ?b }");

    int dangling =
        JenaGraph.count(
            m,
            "SELECT DISTINCT ?o WHERE {"
                + " ?s ?p ?o . FILTER(?p IN (rfc:refines, rfc:references)) . FILTER(isIRI(?o)) ."
                + " FILTER NOT EXISTS { ?o ?q ?z } }");

    int contradictions =
        JenaGraph.count(
            m, "SELECT DISTINCT ?n WHERE { ?n rfc:modality rfc:MUST . ?n rfc:modality rfc:MUST_NOT }");

    return EnergySnapshot.newBuilder()
        .setRedundancy(redundancy)
        .setContradictions(contradictions)
        .setDangling(dangling)
        .setUnderSpec(frontierSize)
        .setConnectivity(connectivity)
        .setSymmetry(symmetry)
        .setTemperature(tau)
        .build();
  }
}
