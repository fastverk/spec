package kg.reasoner.llm;

/**
 * One LLM call's output. Minimal — just what kg_reasoner consumers
 * need to ingest. Wider provider-specific metadata stays in the
 * provider-specific adapter.
 */
public final class LlmResponse {

    public final String text;
    public final String model;
    public final int inputTokens;
    public final int outputTokens;

    public LlmResponse(String text, String model, int inputTokens, int outputTokens) {
        this.text = text;
        this.model = model;
        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
    }
}
