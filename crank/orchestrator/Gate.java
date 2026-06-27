package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.Triple;
import java.util.Collection;

/**
 * The crank's <em>gate</em> step: a candidate graph (the corrector's output) is
 * admitted only if it passes. The deterministic corrector can only lower E(G),
 * so the worst case a gate ever sees is a sound-but-pointless delta; a gate
 * failure means the proposal was structurally unsound (e.g. it introduced a
 * {@code dependsOn} cycle) and the crank rejects it. {@link JenaGate} is the
 * real implementation (SPARQL, mirroring the {@code //corpus} consistency
 * gates); a null gate (the default) admits everything.
 */
public interface Gate {
  boolean passes(Collection<Triple> graph);
}
