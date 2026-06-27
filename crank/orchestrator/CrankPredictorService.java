package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.CrankPredictorGrpc;
import dev.fastverk.crank.v1.PredictRequest;
import dev.fastverk.crank.v1.PredictResponse;
import io.grpc.stub.StreamObserver;

/**
 * The server side of the contract: a gRPC service that delegates each Predict
 * call to a plain {@link CrankPredictor}. With {@link MockPredictor} behind it
 * this is a stand-in fleet endpoint for the round-trip test; the canonical fleet
 * is the Rust {@code agora_crank} tonic server (Vickrey auction → winning tool's
 * graph), which implements the same {@code fastverk.crank.v1.CrankPredictor}
 * service. Either side of the wire can be a worker — the contract is symmetric.
 */
public final class CrankPredictorService extends CrankPredictorGrpc.CrankPredictorImplBase {
  private final CrankPredictor delegate;

  public CrankPredictorService(CrankPredictor delegate) {
    this.delegate = delegate;
  }

  @Override
  public void predict(PredictRequest request, StreamObserver<PredictResponse> responseObserver) {
    responseObserver.onNext(delegate.predict(request));
    responseObserver.onCompleted();
  }
}
