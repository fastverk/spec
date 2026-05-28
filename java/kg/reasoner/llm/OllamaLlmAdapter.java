package kg.reasoner.llm;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * {@link LlmAdapter} that calls a local (or remote) Ollama server via
 * {@code /api/chat}. No SDK dependency — Java's built-in HttpClient
 * plus a tiny hand-rolled JSON encoder, matching {@link AnthropicLlmAdapter}'s
 * shape so the two are interchangeable behind {@link CachedLlmAdapter}.
 *
 * Configuration:
 *   OLLAMA_HOST  base URL, default {@code http://localhost:11434}.
 *
 * Models are user-pulled via {@code ollama pull gemma3:4b} (etc.); the
 * adapter doesn't auto-pull. {@link LlmTask#model} is passed verbatim.
 *
 * Why local: smaller models (gemma3:1b/4b, Llama-3-8B-class) at ~$0
 * per call, which makes wide-grain inference (one call per orphan
 * diagnostic, ~600 calls/run) cheap to iterate on. Determinism is
 * achieved the same way as for hosted providers — wrap with
 * {@link CachedLlmAdapter}.
 */
public final class OllamaLlmAdapter implements LlmAdapter {

    private static final String DEFAULT_HOST = "http://localhost:11434";

    private final URI endpoint;
    private final HttpClient http;

    public OllamaLlmAdapter() { this(envHost()); }

    public OllamaLlmAdapter(String host) {
        if (host == null || host.isBlank()) host = DEFAULT_HOST;
        this.endpoint = URI.create(host + "/api/chat");
        this.http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    }

    private static String envHost() {
        String h = System.getenv("OLLAMA_HOST");
        return (h == null || h.isBlank()) ? DEFAULT_HOST : h;
    }

    @Override
    public LlmResponse complete(LlmTask task) throws IOException {
        String body = encodeRequest(task);
        HttpRequest req = HttpRequest.newBuilder()
            .uri(endpoint)
            .header("content-type", "application/json")
            .timeout(Duration.ofMinutes(5))
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> resp;
        try {
            resp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while awaiting Ollama response", e);
        }
        if (resp.statusCode() >= 400) {
            throw new IOException("Ollama API " + resp.statusCode() + ": "
                + truncate(resp.body(), 500));
        }
        return parseResponse(resp.body(), task.model);
    }

    static String encodeRequest(LlmTask t) {
        StringBuilder b = new StringBuilder();
        b.append("{");
        b.append("\"model\":").append(jsonStr(t.model));
        b.append(",\"stream\":false");
        b.append(",\"options\":{");
        b.append("\"temperature\":").append(t.temperature);
        b.append(",\"num_predict\":").append(t.maxTokens);
        b.append("}");
        b.append(",\"messages\":[");
        boolean wroteSystem = false;
        if (t.systemPrompt != null && !t.systemPrompt.isEmpty()) {
            b.append("{\"role\":\"system\",\"content\":").append(jsonStr(t.systemPrompt)).append("}");
            wroteSystem = true;
        }
        if (wroteSystem) b.append(",");
        b.append("{\"role\":\"user\",\"content\":").append(jsonStr(t.userPrompt)).append("}");
        b.append("]}");
        return b.toString();
    }

    /** Pull {@code message.content} plus {@code prompt_eval_count} /
     *  {@code eval_count} (Ollama's input/output token counters). */
    static LlmResponse parseResponse(String json, String model) {
        String text = readNestedText(json);
        int inT = readIntField(json, "\"prompt_eval_count\":");
        int outT = readIntField(json, "\"eval_count\":");
        return new LlmResponse(text, model, inT, outT);
    }

    private static String readNestedText(String json) {
        int messageIdx = json.indexOf("\"message\":");
        if (messageIdx < 0) throw new RuntimeException("response has no message");
        int textIdx = json.indexOf("\"content\":", messageIdx);
        if (textIdx < 0) throw new RuntimeException("response message has no content");
        textIdx += "\"content\":".length();
        while (textIdx < json.length() && Character.isWhitespace(json.charAt(textIdx))) textIdx++;
        if (json.charAt(textIdx) != '"') throw new RuntimeException("expected string after content");
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
