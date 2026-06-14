package tools;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import kg.reasoner.llm.FakeLlmAdapter;
import kg.reasoner.llm.LlmAdapter;
import kg.reasoner.llm.LlmProviders;
import kg.reasoner.llm.LlmResponse;
import kg.reasoner.llm.LlmTask;

/**
 * Generate a Conventional-Commit message from a staged git diff via the spec
 * LLM layer ({@link kg.reasoner.llm.LlmAdapter} + {@link LlmProviders}'s cache).
 *
 * Folded in from the (now-archived) `mattmarshall/scope` CLI — the one
 * genuinely-reusable ergonomics feature it had. The prompt is ported from
 * scope's `templates/git/commit_analysis.txt`; the LLM plumbing is spec's
 * (cached, provider-agnostic), not scope's curl-shelling.
 *
 * Run:  bazel run //java/tools:commit_msg_bin               # over `git diff --cached`
 *       bazel run //java/tools:commit_msg_bin -- --selftest # offline (FakeLlmAdapter)
 *
 * Model defaults to a fast tier; override with LLM_MODEL. Provider selection +
 * caching come from {@link LlmProviders} (ANTHROPIC_API_KEY / LLM_PROVIDER).
 */
public final class CommitMessageGen {

    private static final String DEFAULT_MODEL = "claude-haiku-4-5-20251001";

    private static final String SYSTEM_PROMPT = String.join("\n",
        "You analyze a git diff and produce a Conventional Commit message.",
        "Respond with ONLY a JSON object, nothing else, in this exact shape:",
        "{",
        "  \"commit_type\": \"one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert\",",
        "  \"scope\": \"optional component/module name, or empty\",",
        "  \"subject\": \"concise imperative-mood description (e.g. 'add', not 'added')\",",
        "  \"breaking_change\": true or false,",
        "  \"breaking_change_description\": \"description if breaking, else empty\"",
        "}",
        "Use feat for new features, fix for bug fixes, docs for documentation,",
        "refactor for behavior-preserving code changes, perf for performance,",
        "test for tests, build/ci for the build or CI, chore for chores.",
        "Set breaking_change=true if public APIs change incompatibly.",
        "Keep the subject clear, concise, and imperative. Output ONLY the JSON.");

    private CommitMessageGen() {}

    /** Build the Conventional-Commit message for {@code diff} (+ optional changed
     *  spec paths) using {@code llm}. Pure given the adapter — easy to test. */
    public static String generate(String diff, List<String> modifiedSpecs,
                                  LlmAdapter llm, String model) throws IOException {
        StringBuilder user = new StringBuilder();
        user.append("Changes (git diff):\n```\n").append(diff).append("\n```\n");
        if (modifiedSpecs != null && !modifiedSpecs.isEmpty()) {
            user.append("\nModified specification files:\n");
            for (String s : modifiedSpecs) user.append("- ").append(s).append("\n");
        }
        LlmTask task = new LlmTask(model, SYSTEM_PROMPT, user.toString(),
                                   /*temperature=*/ 0.0, /*maxTokens=*/ 512, "commit-msg");
        LlmResponse resp = llm.complete(task);

        String type = firstNonBlank(stringField(resp.text, "commit_type"), "chore");
        String scope = stringField(resp.text, "scope");
        String subject = firstNonBlank(stringField(resp.text, "subject"), "update");
        boolean breaking = boolField(resp.text, "breaking_change");
        String breakingDesc = stringField(resp.text, "breaking_change_description");

        StringBuilder out = new StringBuilder();
        out.append(type);
        if (scope != null && !scope.isBlank()) out.append('(').append(scope.trim()).append(')');
        if (breaking) out.append('!');
        out.append(": ").append(subject.trim());
        if (breaking && breakingDesc != null && !breakingDesc.isBlank()) {
            out.append("\n\nBREAKING CHANGE: ").append(breakingDesc.trim());
        }
        return out.toString();
    }

    // ── lenient field extraction (spec hand-parses LLM output; no JSON dep) ──

    /** Extract a string value for {@code "field": "..."} (first match). */
    static String stringField(String json, String field) {
        int k = json.indexOf('"' + field + '"');
        if (k < 0) return "";
        int colon = json.indexOf(':', k + field.length() + 2);
        if (colon < 0) return "";
        int i = colon + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length() || json.charAt(i) != '"') return "";
        StringBuilder sb = new StringBuilder();
        for (i++; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '\\' && i + 1 < json.length()) { sb.append(json.charAt(++i)); continue; }
            if (c == '"') break;
            sb.append(c);
        }
        return sb.toString();
    }

    /** Extract a boolean for {@code "field": true|false}. */
    static boolean boolField(String json, String field) {
        int k = json.indexOf('"' + field + '"');
        if (k < 0) return false;
        int colon = json.indexOf(':', k + field.length() + 2);
        if (colon < 0) return false;
        return json.regionMatches(true, skipWs(json, colon + 1), "true", 0, 4);
    }

    private static int skipWs(String s, int i) {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        return i;
    }

    private static String firstNonBlank(String a, String b) {
        return (a != null && !a.isBlank()) ? a : b;
    }

    private static String model() {
        String m = System.getenv("LLM_MODEL");
        return (m != null && !m.isBlank()) ? m.trim() : DEFAULT_MODEL;
    }

    private static String gitDiffCached() throws IOException, InterruptedException {
        Process p = new ProcessBuilder("git", "diff", "--cached").redirectErrorStream(false).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        p.waitFor();
        return out;
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("--selftest")) {
            System.exit(selfTest() ? 0 : 1);
            return;
        }
        String diff = gitDiffCached();
        if (diff.isBlank()) {
            System.err.println("No staged changes. Stage with `git add` first.");
            System.exit(2);
            return;
        }
        System.out.println(generate(diff, new ArrayList<>(), LlmProviders.resolve(), model()));
    }

    /** Offline verification of parse + format via FakeLlmAdapter (no network). */
    static boolean selfTest() throws IOException {
        FakeLlmAdapter fake = new FakeLlmAdapter().defaultResponse(
            "{\"commit_type\":\"feat\",\"scope\":\"kernel\",\"subject\":\"add balance check\","
            + "\"breaking_change\":true,\"breaking_change_description\":\"renames the API\"}");
        String msg = generate("some diff", List.of("specs/x.md"), fake, "fake-model");
        String expected = "feat(kernel)!: add balance check\n\nBREAKING CHANGE: renames the API";
        boolean ok = msg.equals(expected);
        System.out.println(ok ? "selftest OK: " + msg.replace("\n", "\\n")
                              : "selftest FAIL\n  got:      " + msg + "\n  expected: " + expected);
        return ok;
    }
}
