package kg.reasoner.llm;

import java.util.HashMap;
import java.util.Map;

/**
 * Deterministic test adapter — no network, no API key. Returns canned
 * responses keyed by user-prompt prefix (or a default if no match).
 *
 * Usage in a test:
 *   FakeLlmAdapter fake = new FakeLlmAdapter();
 *   fake.respondTo("classify diagnostic", "M36010 emitted by rule R1");
 *   LlmAdapter cached = new CachedLlmAdapter(fake, tmpCacheDir, true);
 *
 * Useful for verifying adapter wiring, cache behavior, and downstream
 * inference without invoking any real model.
 */
public final class FakeLlmAdapter implements LlmAdapter {

    private final Map<String, String> canned = new HashMap<>();
    private String defaultResponse = "(fake response)";
    private int callCount = 0;

    public FakeLlmAdapter respondTo(String userPromptPrefix, String response) {
        canned.put(userPromptPrefix, response);
        return this;
    }

    public FakeLlmAdapter defaultResponse(String response) {
        this.defaultResponse = response;
        return this;
    }

    public int callCount() { return callCount; }

    @Override
    public LlmResponse complete(LlmTask task) {
        callCount++;
        for (var e : canned.entrySet()) {
            if (task.userPrompt.startsWith(e.getKey())) {
                return new LlmResponse(e.getValue(), task.model, 0, 0);
            }
        }
        return new LlmResponse(defaultResponse, task.model, 0, 0);
    }
}
