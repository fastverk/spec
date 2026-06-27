package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.PredictRequest;
import dev.fastverk.crank.v1.PredictResponse;

/**
 * Java form of the {@code crank.proto} {@code CrankPredictor} service — the
 * predict step's contract. The generated gRPC stub (java_grpc_library, when the
 * transport is wired) implements this over the wire to the agora fleet
 * (in-process or RunPod); the in-process {@link MockPredictor} implements it for
 * the orchestrator loop demo. Either way the orchestrator depends only on this
 * interface, never on a concrete transport.
 */
public interface CrankPredictor {
  PredictResponse predict(PredictRequest request);
}
