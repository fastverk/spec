package kg.reasoner.llm;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Concrete {@link LlmAdapter} that calls api.anthropic.com.
 *
 * Reads API key from {@code ANTHROPIC_API_KEY} env var. Wrap with
 * {@link CachedLlmAdapter} for determinism — every call hits the
 * network otherwise.
 *
 * Single-purpose, no Anthropic SDK dependency. Java's built-in
 * {@link java.net.http.HttpClient} + a tiny hand-rolled JSON encoder
 * keeps the supply chain shallow.
 */
public final class AnthropicLlmAdapter implements LlmAdapter {

    private static final URI API_URI = URI.create("https://api.anthropic.com/v1/messages");
    private static final String DEFAULT_VERSION = "2023-06-01";

    private final String apiKey;
    private final String version;
    private final HttpClient http;

    public AnthropicLlmAdapter() { this(envApiKey(), DEFAULT_VERSION); }

    public AnthropicLlmAdapter(String apiKey, String version) {
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException(
                "ANTHROPIC_API_KEY is required (set env var or pass apiKey explicitly).");
        }
        this.apiKey = apiKey;
        this.version = version;
        this.http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .build();
    }

    private static String envApiKey() { return System.getenv("ANTHROPIC_API_KEY"); }

    @Override
    public LlmResponse complete(LlmTask task) throws IOException {
        String body = encodeRequest(task);
        HttpRequest req = HttpRequest.newBuilder()
            .uri(API_URI)
            .header("x-api-key", apiKey)
            .header("anthropic-version", version)
            .header("content-type", "application/json")
            .timeout(Duration.ofMinutes(2))
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build();

        int maxAttempts = 6;
        long baseBackoffMs = 1000;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            HttpResponse<String> resp;
            try {
                resp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted while awaiting Anthropic response", e);
            }
            int status = resp.statusCode();
            if (status < 400) return parseResponse(resp.body(), task.model);
            boolean retryable = (status == 429 || status == 503 || status == 529 || (status >= 500 && status < 600));
            if (!retryable || attempt == maxAttempts) {
                throw new IOException("Anthropic API " + status + ": "
                    + truncate(resp.body(), 500));
            }
            long sleepMs = retryAfterMs(resp).orElse(baseBackoffMs * (1L << (attempt - 1))
                + (long) (Math.random() * 250));
            try { Thread.sleep(sleepMs); }
            catch (InterruptedException e) { Thread.currentThread().interrupt();
                throw new IOException("interrupted during retry backoff", e); }
        }
        throw new IOException("unreachable");
    }

    private static java.util.Optional<Long> retryAfterMs(HttpResponse<String> resp) {
        return resp.headers().firstValue("retry-after").map(v -> {
            try { return Long.parseLong(v.trim()) * 1000L; }
            catch (NumberFormatException nfe) { return null; }
        }).filter(java.util.Objects::nonNull);
    }

    static String encodeRequest(LlmTask t) {
        StringBuilder b = new StringBuilder();
        b.append("{");
        b.append("\"model\":").append(jsonStr(t.model));
        b.append(",\"max_tokens\":").append(t.maxTokens);
        b.append(",\"temperature\":").append(t.temperature);
        if (t.systemPrompt != null && !t.systemPrompt.isEmpty()) {
            b.append(",\"system\":").append(jsonStr(t.systemPrompt));
        }
        boolean hasPrefix = t.userPromptPrefix != null && !t.userPromptPrefix.isEmpty();
        b.append(",\"messages\":[{\"role\":\"user\",\"content\":");
        if (hasPrefix) {
            // Send the user message as a list of two text blocks: the
            // static prefix marked with cache_control:ephemeral, then
            // the dynamic suffix without it. Anthropic charges ~10% the
            // normal input rate on cache hits for the prefix tokens.
            // Cache lifetime: ~5 minutes after last hit.
            b.append("[")
             .append("{\"type\":\"text\",\"text\":").append(jsonStr(t.userPromptPrefix))
             .append(",\"cache_control\":{\"type\":\"ephemeral\"}},")
             .append("{\"type\":\"text\",\"text\":").append(jsonStr(t.userPrompt))
             .append("}]");
        } else {
            b.append(jsonStr(t.userPrompt));
        }
        b.append("}]");
        b.append("}");
        return b.toString();
    }

    /** Pull the first {@code content[].text} entry plus usage tokens.
     *  Tolerant decoder — same approach as CachedLlmAdapter — only the
     *  fields we care about. */
    static LlmResponse parseResponse(String json, String fallbackModel) {
        String text = readNestedText(json);
        int inT = readIntField(json, "\"input_tokens\":");
        int outT = readIntField(json, "\"output_tokens\":");
        return new LlmResponse(text, fallbackModel, inT, outT);
    }

    private static String readNestedText(String json) {
        // Find "content":[ ... {"text":"..."} ...]
        int contentIdx = json.indexOf("\"content\":");
        if (contentIdx < 0) throw new RuntimeException("response has no content");
        int textIdx = json.indexOf("\"text\":", contentIdx);
        if (textIdx < 0) throw new RuntimeException("response content has no text");
        textIdx += "\"text\":".length();
        while (textIdx < json.length() && Character.isWhitespace(json.charAt(textIdx))) textIdx++;
        if (json.charAt(textIdx) != '"') throw new RuntimeException("expected string after text");
        textIdx++;
        StringBuilder out = new StringBuilder();
        while (textIdx < json.length() && json.charAt(textIdx) != '"') {
            char c = json.charAt(textIdx);
            if (c == '\\' && textIdx + 1 < json.length()) {
                char n = json.charAt(++textIdx);
                switch (n) {
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    case '/' -> out.append('/');
                    case 'u' -> {
                        out.append((char) Integer.parseInt(json.substring(textIdx + 1, textIdx + 5), 16));
                        textIdx += 4;
                    }
                    default -> out.append(n);
                }
            } else {
                out.append(c);
            }
            textIdx++;
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
        if (start == i) return 0;
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

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
