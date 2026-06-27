package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.GraphDelta;
import dev.fastverk.crank.v1.PredictRequest;
import dev.fastverk.crank.v1.PredictResponse;
import dev.fastverk.crank.v1.Provenance;
import dev.fastverk.crank.v1.Term;
import dev.fastverk.crank.v1.Triple;

/**
 * An in-process stand-in for the agora fleet: a {@link CrankPredictor} that, each
 * crank, attacks the first frontier leaf by proposing two claims for it (plus one
 * deliberately-redundant edge already in the context, so the deterministic
 * corrector has something to drop). Abstains (empty delta) when the frontier is
 * exhausted — the convergence signal. Swap this for the gRPC stub to the real
 * fleet and nothing else in the loop changes.
 */
public final class MockPredictor implements CrankPredictor {
  @Override
  public PredictResponse predict(PredictRequest req) {
    if (req.getFrontierCount() == 0) {
      return PredictResponse.newBuilder().build(); // abstain: empty delta
    }
    String leaf = req.getFrontier(0);
    GraphDelta.Builder delta = GraphDelta.newBuilder()
        .addAdd(triple(leaf, "rfc:hasClaim", lit("MUST claim 1 for " + leaf)))
        .addAdd(triple(leaf, "rfc:hasClaim", lit("MUST claim 2 for " + leaf)));
    // Propose one edge that already exists — the corrector (project) drops it.
    if (req.getContextCount() > 0) {
      delta.addAdd(req.getContext(0));
    }
    delta.setProv(Provenance.newBuilder()
        .addProposerModels("ensemble-mock")
        .setConfidence(0.9f)
        .setProposerId("mock-fleet-worker")
        .setRepairIters(1)
        .build());
    return PredictResponse.newBuilder().setDelta(delta).build();
  }

  private static Triple triple(String s, String p, Term o) {
    return Triple.newBuilder().setSubject(iri(s)).setPredicate(iri(p)).setObject(o).build();
  }

  private static Term iri(String v) {
    return Term.newBuilder().setIri(v).build();
  }

  private static Term lit(String v) {
    return Term.newBuilder().setLiteral(v).build();
  }
}
