package kg.reasoner.llm;

import java.io.IOException;

/**
 * Pluggable LLM backend. Single method: take a task, return a response.
 *
 * Implementations should be deterministic when wrapped by {@link CachedLlmAdapter}
 * — the wrapper ensures repeat calls with the same {@link LlmTask} return
 * cached output, so PR-time inference is reproducible.
 *
 * Concrete impls in this package:
 *   - AnthropicLlmAdapter     — calls api.anthropic.com
 *   - FakeLlmAdapter          — deterministic for tests; no network
 *   - CachedLlmAdapter        — wraps any adapter with on-disk cache
 *   - CacheOnlyLlmAdapter     — fails on cache miss (CI mode)
 *
 * Future impls: OllamaLlmAdapter (local small models), OpenRouterLlmAdapter,
 * etc. — all behind the same SPI.
 */
public interface LlmAdapter {

    /** Run one LLM call. Throws on network / auth / parse errors. */
    LlmResponse complete(LlmTask task) throws IOException;
}
