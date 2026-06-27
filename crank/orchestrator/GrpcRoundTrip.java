package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.EnergySnapshot;
import dev.fastverk.crank.v1.Term;
import dev.fastverk.crank.v1.Triple;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import java.util.List;

/**
 * Proves the orchestrator dials a REAL gRPC endpoint. It stands up an in-process
 * gRPC server bound to {@link CrankPredictorService} (delegating to the
 * {@link MockPredictor} fleet), opens a {@link ManagedChannel}, wraps it as a
 * {@link GrpcPredictor}, and runs the full crank loop THROUGH the blocking stub
 * — every crank marshals a {@code PredictRequest} and unmarshals a
 * {@code PredictResponse} across the contract's {@code MethodDescriptor}. The
 * loop must converge and E(G) descend exactly as the in-process run does,
 * confirming the transport is transparent: the loop code is byte-identical to
 * {@link CrankCheck}, only the predictor changed.
 *
 * <p>In-process transport (not netty) keeps the test hermetic and port-free.
 * Pointing the channel at a netty address (the agora_crank server, in-process or
 * RunPod) is the only change for a live fleet.
 *
 * <p>java_test with use_testrunner=False: a non-zero exit fails the test.
 */
public final class GrpcRoundTrip {
  public static void main(String[] args) throws Exception {
    String name = InProcessServerBuilder.generateName();
    Server server =
        InProcessServerBuilder.forName(name)
            .addService(new CrankPredictorService(new MockPredictor()))
            .build()
            .start();
    ManagedChannel channel = InProcessChannelBuilder.forName(name).build();

    try {
      List<Triple> initial =
          List.of(
              edge("rc:RFC-0903", "rfc:dependsOn", "rc:RFC-0900"),
              edge("rc:RFC-0901", "rfc:dependsOn", "rc:RFC-0900"),
              edge("rc:RFC-0902", "rfc:dependsOn", "rc:RFC-0900"));
      List<String> frontier = List.of("rc:leafA", "rc:leafB", "rc:leafC");

      CrankOrchestrator orch = new CrankOrchestrator(initial, frontier);
      // The crank now predicts over gRPC instead of in-process — same loop.
      orch.run(new GrpcPredictor(channel), 10, 1.0, 0.6);
      List<EnergySnapshot> s = orch.series();

      check(s.size() == 3, "expected 3 cranks over gRPC, got " + s.size());
      check(orch.frontier().isEmpty(), "frontier should be empty (converged) over gRPC");
      double e0 = CrankOrchestrator.energy(s.get(0));
      double eN = CrankOrchestrator.energy(s.get(s.size() - 1));
      check(eN < e0, "E(G) should descend over gRPC: e0=" + e0 + " eN=" + eN);

      System.out.println(
          "gRPC round-trip OK — orchestrator dialed CrankPredictorService over a real channel");
      System.out.println("(in-process transport, real PredictRequest/PredictResponse marshalling). E(G) series:");
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
    } finally {
      channel.shutdownNow();
      server.shutdownNow();
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
