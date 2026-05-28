package kg.reasoner.llm;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import kg.AionPaths;

/**
 * Wraps any {@link LlmAdapter} with a content-addressed on-disk cache.
 *
 * Cache key = {@code task.cacheKey()} (sha-256 over model + prompts +
 * temperature + maxTokens). Cache value = the response, serialized as
 * a tiny JSON document. Cache miss path:
 *
 *   - if {@code allowMisses == true}: delegate to the wrapped adapter,
 *     write the response to disk, return it.
 *   - if {@code allowMisses == false}: throw. Used in CI / PR-time
 *     pipelines where determinism matters and any new LLM input must
 *     be pre-cached by an author.
 *
 * Cache location defaults to {@code AionPaths.cacheDir() / "llm"}.
 * Override via {@code AION_CACHE_DIR}. The cache is per-author by
 * default (XDG/Library); a separate committed-cache layer (e.g.,
 * {@code kg/.llm-cache/}) can be loaded by configuring a different
 * cacheDir at construction time.
 */
public final class CachedLlmAdapter implements LlmAdapter {

    private final LlmAdapter inner;
    private final Path cacheDir;
    private final boolean allowMisses;

    public CachedLlmAdapter(LlmAdapter inner, Path cacheDir, boolean allowMisses) {
        this.inner = inner;
        this.cacheDir = cacheDir;
        this.allowMisses = allowMisses;
    }

    /** Default constructor: AionPaths.cacheDir()/llm, miss-on-write allowed. */
    public static CachedLlmAdapter defaultFor(LlmAdapter inner) {
        return new CachedLlmAdapter(inner, AionPaths.cacheDir().resolve("llm"), true);
    }

    @Override
    public LlmResponse complete(LlmTask task) throws IOException {
        Path file = cacheDir.resolve(task.cacheKey() + ".json");
        if (Files.exists(file)) {
            return decode(Files.readString(file, StandardCharsets.UTF_8));
        }
        if (!allowMisses) {
            throw new IOException("LLM cache miss for task '" + task.label
                + "' (key " + task.cacheKey().substring(0, 12) + "…). "
                + "PR-time runs require cached responses; have an author "
                + "run with allowMisses=true to populate, then commit "
                + cacheDir + ".");
        }
        LlmResponse resp = inner.complete(task);
        Files.createDirectories(cacheDir);
        Files.writeString(file, encode(resp), StandardCharsets.UTF_8);
        return resp;
    }

    /** Tiny hand-rolled JSON encoder — same convention as elsewhere in
     *  the codebase, no Jackson/etc. dep. Schema is fixed. */
    static String encode(LlmResponse r) {
        StringBuilder b = new StringBuilder();
        b.append("{\"text\":").append(jsonStr(r.text));
        b.append(",\"model\":").append(jsonStr(r.model));
        b.append(",\"inputTokens\":").append(r.inputTokens);
        b.append(",\"outputTokens\":").append(r.outputTokens);
        b.append("}");
        return b.toString();
    }

    static LlmResponse decode(String json) {
        // Minimal, position-tolerant decoder — only the four fields we emit.
        String text = readStringField(json, "\"text\":");
        String model = readStringField(json, "\"model\":");
        int inT = readIntField(json, "\"inputTokens\":");
        int outT = readIntField(json, "\"outputTokens\":");
        return new LlmResponse(text, model, inT, outT);
    }

    private static String readStringField(String json, String key) {
        int i = json.indexOf(key);
        if (i < 0) throw new RuntimeException("missing field: " + key);
        i += key.length();
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (json.charAt(i) != '"') throw new RuntimeException("expected '\"' after " + key);
        i++;
        StringBuilder out = new StringBuilder();
        while (i < json.length() && json.charAt(i) != '"') {
            char c = json.charAt(i);
            if (c == '\\' && i + 1 < json.length()) {
                char n = json.charAt(++i);
                switch (n) {
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case '"': out.append('"');  break;
                    case '\\': out.append('\\'); break;
                    case '/': out.append('/'); break;
                    case 'u':
                        out.append((char) Integer.parseInt(json.substring(i + 1, i + 5), 16));
                        i += 4;
                        break;
                    default: out.append(n);
                }
            } else {
                out.append(c);
            }
            i++;
        }
        return out.toString();
    }

    private static int readIntField(String json, String key) {
        int i = json.indexOf(key);
        if (i < 0) return 0;
        i += key.length();
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        int start = i;
        while (i < json.length() && (Character.isDigit(json.charAt(i)) || json.charAt(i) == '-')) i++;
        return Integer.parseInt(json.substring(start, i));
    }

    private static String jsonStr(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }
}
