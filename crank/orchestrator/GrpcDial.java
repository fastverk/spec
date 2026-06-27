package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.Term;
import dev.fastverk.crank.v1.Triple;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import java.util.List;

/**
 * Dials a LIVE {@code agora_crank} CrankPredictor endpoint over the network
 * (netty, plaintext) and runs the crank loop against it — the cross-language
 * crank: a JVM orchestrator whose predict step is a Rust tonic fleet server.
 *
 * <pre>
 *   # start the fleet (agora repo):
 *   cargo run -p agora_crank --bin crank-server -- 127.0.0.1:50051
 *   # dial it (spec repo):
 *   bazel run //crank/orchestrator:grpc_dial -- 127.0.0.1:50051
 * </pre>
 *
 * <p>A binary, not a test, because it needs an external server; the hermetic
 * equivalent is {@code :grpc_round_trip} (in-process transport). The only
 * difference from that test is this line — a netty channel to a real address —
 * which is exactly the swap rfc-002 §Next calls for.
 */
public final class GrpcDial {
  public static void main(String[] args) throws Exception {
    String target = args.length > 0 ? args[0] : "127.0.0.1:50051";
    ManagedChannel channel = ManagedChannelBuilder.forTarget(target).usePlaintext().build();
    try {
      List<Triple> initial =
          List.of(
              edge("rc:RFC-0903", "rfc:dependsOn", "rc:RFC-0900"),
              edge("rc:RFC-0901", "rfc:dependsOn", "rc:RFC-0900"),
              edge("rc:RFC-0902", "rfc:dependsOn", "rc:RFC-0900"));
      List<String> frontier = List.of("rc:leafA", "rc:leafB", "rc:leafC");

      CrankOrchestrator orch = new CrankOrchestrator(initial, frontier);
      orch.run(new GrpcPredictor(channel), 10, 1.0, 0.6);
      List<EnergySnapshot> s = orch.series();

      System.out.printf(
          "dialed %s — cranked %d times over the network. E(G) series:%n", target, s.size());
      for (int i = 0; i < s.size(); i++) {
        EnergySnapshot e = s.get(i);
        System.out.printf(
            "  crank %d:  U=%d  L=%d  S=%d  R=%d   E=%.1f   tau=%.2f%n",
            i + 1,
            e.getUnderSpec(),
            e.getConnectivity(),
            e.getSymmetry(),
            e.getRedundancy(),
            CrankOrchestrator.energy(e),
            e.getTemperature());
      }

      boolean converged = orch.frontier().isEmpty();
      boolean descended =
          !s.isEmpty()
              && CrankOrchestrator.energy(s.get(s.size() - 1))
                  < CrankOrchestrator.energy(s.get(0));
      if (converged && descended) {
        System.out.println("OK — frontier converged and E(G) descended over the wire (Java ⇄ Rust).");
      } else {
        System.out.println("WARN — loop did not converge/descend as expected.");
        System.exit(1);
      }
    } finally {
      channel.shutdownNow();
    }
  }

  private static Triple edge(String s, String p, String o) {
    return Triple.newBuilder().setSubject(iri(s)).setPredicate(iri(p)).setObject(iri(o)).build();
  }

  private static Term iri(String v) {
    return Term.newBuilder().setIri(v).build();
  }
}
