package kg.reasoner.llm;

import java.io.IOException;
import java.nio.file.Path;

import kg.AionPaths;

/**
 * Centralized LLM-adapter selection. Resolves {@code LLM_PROVIDER}
 * env (or auto-detects), wraps the chosen provider with the on-disk
 * cache at {@code AionPaths.cacheDir()/llm}.
 *
 * Selection precedence:
 *   1. LLM_PROVIDER=anthropic        → AnthropicLlmAdapter (requires ANTHROPIC_API_KEY).
 *   2. LLM_PROVIDER=ollama           → OllamaLlmAdapter (uses OLLAMA_HOST or localhost).
 *   3. LLM_PROVIDER unset, ANTHROPIC_API_KEY set → Anthropic.
 *   4. LLM_PROVIDER unset, ANTHROPIC_API_KEY unset → Ollama.
 *
 * Read-through cache is enabled when the chosen provider can actually
 * make calls (Anthropic → API key set; Ollama → always, since localhost
 * Ollama doesn't need a key). When disabled, cache misses throw —
 * {@link kg.reasoner.llm.EmitsClassifierRule} catches per-orphan and
 * skips silently, so an empty cache is graceful.
 */
public final class LlmProviders {

    private LlmProviders() {}

    /** Resolve the configured adapter, wrapped with the system cache. */
    public static LlmAdapter resolve() {
        Path cacheDir = AionPaths.cacheDir().resolve("llm");
        return new CachedLlmAdapter(inner(), cacheDir, /*allowMisses=*/ liveProviderAvailable());
    }

    /** True if the chosen provider can make real network calls
     *  (so cache misses can read-through and write). False puts the
     *  CachedLlmAdapter in cache-only mode — misses throw. */
    public static boolean liveProviderAvailable() {
        return switch (provider()) {
            case ANTHROPIC -> haveAnthropicKey();
            case OLLAMA -> true;
        };
    }

    /** Active provider. */
    public static Provider provider() {
        String explicit = System.getenv("LLM_PROVIDER");
        if (explicit != null && !explicit.isBlank()) {
            String norm = explicit.trim().toLowerCase();
            if ("anthropic".equals(norm)) return Provider.ANTHROPIC;
            if ("ollama".equals(norm)) return Provider.OLLAMA;
            throw new IllegalArgumentException("LLM_PROVIDER must be 'anthropic' or 'ollama', got: " + explicit);
        }
        return haveAnthropicKey() ? Provider.ANTHROPIC : Provider.OLLAMA;
    }

    private static LlmAdapter inner() {
        Provider p = provider();
        if (p == Provider.ANTHROPIC) {
            if (!haveAnthropicKey()) {
                return task -> { throw new IOException(
                    "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset"); };
            }
            return new AnthropicLlmAdapter();
        }
        return new OllamaLlmAdapter();
    }

    private static boolean haveAnthropicKey() {
        String k = System.getenv("ANTHROPIC_API_KEY");
        return k != null && !k.isBlank();
    }

    public enum Provider { ANTHROPIC, OLLAMA }
}
