package kg.reasoner.llm;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.nio.charset.StandardCharsets;

/**
 * One LLM call's input. Stable identity (sha-256) over (model,
 * systemPrompt, userPrompt, temperature, maxTokens) is what the
 * cache keys on, so unchanged inputs deterministically resolve to
 * the cached response.
 *
 * Records (immutable) so the cache key is just function-of-state.
 */
public final class LlmTask {

    public final String model;
    public final String systemPrompt;
    public final String userPrompt;
    /** Optional static prefix of the user prompt that is identical
     *  across many calls (e.g., universe types & predicates). When
     *  non-empty and the adapter supports it, this prefix is sent as
     *  a separate content block with Anthropic's `cache_control` set,
     *  letting the API charge ~10% the normal input rate on cache
     *  hits. When empty/null, the full user prompt is sent as today.
     *
     *  IMPORTANT: the full user prompt sent to the model is the
     *  concatenation `userPromptPrefix + userPrompt`. The split is
     *  purely a billing optimization; the model sees the same content. */
    public final String userPromptPrefix;
    public final double temperature;
    public final int maxTokens;
    /** Free-form name for logs/metrics; NOT in the cache key. */
    public final String label;

    public LlmTask(String model, String systemPrompt, String userPrompt,
                   double temperature, int maxTokens, String label) {
        this(model, systemPrompt, "", userPrompt, temperature, maxTokens, label);
    }

    public LlmTask(String model, String systemPrompt,
                   String userPromptPrefix, String userPrompt,
                   double temperature, int maxTokens, String label) {
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.userPromptPrefix = userPromptPrefix == null ? "" : userPromptPrefix;
        this.userPrompt = userPrompt;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.label = label;
    }

    /** sha-256 over the cache-relevant fields. The prefix is hashed
     *  separately from the dynamic user prompt so that two tasks with
     *  the same effective content but different splits remain
     *  *distinct* cache entries (defensive: a different split could
     *  produce different LLM behavior, though in practice it doesn't). */
    public String cacheKey() {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(("model=" + model + "\0").getBytes(StandardCharsets.UTF_8));
            md.update(("temp=" + temperature + "\0").getBytes(StandardCharsets.UTF_8));
            md.update(("max=" + maxTokens + "\0").getBytes(StandardCharsets.UTF_8));
            md.update(("sys=" + systemPrompt + "\0").getBytes(StandardCharsets.UTF_8));
            md.update(("upfx=" + userPromptPrefix + "\0").getBytes(StandardCharsets.UTF_8));
            md.update(("user=" + userPrompt + "\0").getBytes(StandardCharsets.UTF_8));
            byte[] hash = md.digest();
            StringBuilder hex = new StringBuilder(64);
            for (byte b : hash) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }
}
