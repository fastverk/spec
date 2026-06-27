package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.CrankPredictorGrpc;
import dev.fastverk.crank.v1.PredictRequest;
import dev.fastverk.crank.v1.PredictResponse;
import io.grpc.Channel;

/**
 * The gRPC client adapter: a {@link CrankPredictor} backed by the generated
 * {@link CrankPredictorGrpc} blocking stub over a {@link Channel}. This is the
 * one-line swap that turns the in-process {@link MockPredictor} into a real
 * fleet call — {@link CrankOrchestrator} is unchanged because it dials only the
 * {@link CrankPredictor} interface, never a transport. Point the channel at the
 * agora endpoint (the Rust {@code agora_crank} tonic server — in-process or
 * RunPod — which speaks the same {@code fastverk.crank.v1} contract) and the
 * crank cranks over the network.
 */
public final class GrpcPredictor implements CrankPredictor {
  private final CrankPredictorGrpc.CrankPredictorBlockingStub stub;

  public GrpcPredictor(Channel channel) {
    this.stub = CrankPredictorGrpc.newBlockingStub(channel);
  }

  @Override
  public PredictResponse predict(PredictRequest request) {
    return stub.predict(request);
  }
}
