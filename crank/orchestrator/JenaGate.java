package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.Triple;
import java.util.Collection;
import org.apache.jena.rdf.model.Model;

/**
 * The real gate: rejects a candidate graph that violates a {@code //corpus}
 * consistency invariant. Here, the load-bearing one for the crank — the
 * {@code dependsOn} relation must stay a DAG (it is {@code owl:TransitiveProperty};
 * a cycle would make the transitive closure — and the energy — ill-defined). A
 * candidate that introduces a {@code dependsOn} cycle is rejected, so the worst
 * an over-eager predictor can do is have its delta thrown away.
 */
public final class JenaGate implements Gate {
  @Override
  public boolean passes(Collection<Triple> graph) {
    return passesModel(JenaGraph.toModel(graph));
  }

  /** Gate an already-materialized model (e.g. the loaded ratio corpus). */
  public boolean passesModel(Model m) {
    boolean hasCycle = JenaGraph.ask(m, "ASK { ?x (rfc:dependsOn)+ ?x }");
    return !hasCycle;
  }
}
