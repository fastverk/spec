package kg.gate;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import org.apache.jena.rdf.model.Model;

/**
 * The gate plane, held warm.
 *
 * <p>{@link GateCli} answers one question and exits, which is right for CI and
 * wrong for anything asking repeatedly: the corpus is re-parsed from Turtle on
 * every invocation. This holds one {@link Model} for the process's life and
 * answers over it.
 *
 * <h2>Where this runs</h2>
 *
 * <p>A third container in the `plugin-spec` pod, beside `spec-server` and
 * `git-sync`, reached on LOOPBACK. It binds 127.0.0.1 and nothing else: the
 * front door is the Rust process, which already holds the fleet's auth and the
 * ALB's target group. RFC-006 §3 has the argument; the short version is that a
 * JVM listening on 0.0.0.0 inside a pod is one NetworkPolicy mistake from being
 * an unauthenticated gate service.
 *
 * <h2>HTTP, not gRPC, on this hop</h2>
 *
 * <p>⚠ Deliberate. gRPC's value is on the internet-facing hop, where the console
 * needs a typed contract across a network it does not control. Between two
 * containers sharing a network namespace it buys a code generator and a
 * dependency tree. `derivation.proto` remains the schema of record and these
 * payloads are its JSON projection — same field names, so putting gRPC here
 * later is a serializer swap.
 *
 * <h2>Additions only, and why that is not a gap</h2>
 *
 * <p>⛔ `/preflight` takes Turtle to ADD and has no removal channel. That covers
 * the entire op vocabulary, and it is checkable rather than assumed:
 * `tools/proposals/materialize.py` contains no `.remove(` at all — every one of
 * the 17 constructors materializes as APPENDED triples. Even `retractTerm`,
 * which reads like a deletion, emits `au:demotedBy` plus an `rdfs:comment`; the
 * corpus records that a term was withdrawn rather than forgetting it was ever
 * there, which is the same append-only stance the proposal log takes.
 *
 * <p>If an op ever removes a triple, this endpoint becomes silently wrong rather
 * than loudly incomplete — it would preflight a proposal minus its deletions and
 * report the result as the proposal's. So: the day `materialize.py` grows a
 * `.remove(`, this needs a removal channel, and that sentence is the whole
 * warning.
 */
public final class GateServer {

    private final Model corpus;
    private final List<String> gateSpecs;

    GateServer(Model corpus, List<String> gateSpecs) {
        this.corpus = corpus;
        this.gateSpecs = gateSpecs;
    }

    public static void main(String[] argv) throws Exception {
        List<String> gateSpecs = new ArrayList<>();
        List<Path> corpusFiles = new ArrayList<>();
        int port = 8081;
        for (String a : argv) {
            if (a.startsWith("--gate=")) {
                gateSpecs.add(a.substring("--gate=".length()));
            } else if (a.startsWith("--port=")) {
                port = Integer.parseInt(a.substring("--port=".length()));
            } else if (a.startsWith("--")) {
                System.err.println("unknown flag: " + a);
                System.exit(2);
            } else {
                corpusFiles.add(Path.of(a));
            }
        }
        if (gateSpecs.isEmpty() || corpusFiles.isEmpty()) {
            System.err.println(
                "usage: gate_binary [--port=N] --gate=NAME=QUERY.rq [...] CORPUS.ttl [...]");
            System.exit(2);
        }

        // ⛔ Parsed once, at startup, and never reloaded. A corpus that changed
        // under a running process would make two answers to the same question
        // differ with nothing to say why — and the corpus only changes when a
        // promotion PR merges, which redeploys this anyway.
        Model corpus = GateCli.load(corpusFiles);
        GateServer server = new GateServer(corpus, gateSpecs);

        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        http.createContext("/healthz", ex -> server.respond(ex, 200, "{\"ok\":true}"));
        http.createContext("/gates", server::handleGates);
        http.createContext("/preflight", server::handlePreflight);
        http.setExecutor(null);
        http.start();
        System.err.println("gate_binary listening on 127.0.0.1:" + port
                           + " over " + gateSpecs.size() + " gate(s)");
    }

    void handleGates(HttpExchange ex) throws IOException {
        try {
            respond(ex, 200, GateCli.toJson(GateCli.runAll(gateSpecs, corpus)));
        } catch (Exception e) {
            respond(ex, 500, err(e));
        }
    }

    void handlePreflight(HttpExchange ex) throws IOException {
        try {
            if (!"POST".equals(ex.getRequestMethod())) {
                respond(ex, 405, "{\"error\":\"POST Turtle to preflight\"}");
                return;
            }
            String turtle = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (turtle.isBlank()) {
                // ⛔ Not an empty delta. A preflight of nothing is not a
                // measurement, and answering "admissible" to it would tell a
                // caller their proposal is safe when no proposal arrived.
                respond(ex, 400, "{\"error\":\"empty body — a preflight of nothing "
                                 + "is not a result\"}");
                return;
            }
            List<GateCli.GateResult> baseline = GateCli.runAll(gateSpecs, corpus);

            // ⛔ PURE. A COPY of the corpus takes the additions; the warm model is
            // never mutated. Adding to `corpus` here would make every later
            // request answer over a graph nobody promoted — a proposal becoming
            // the corpus by side effect, which is invariant ② failing silently
            // and permanently for the life of the process.
            Model proposed = GateCli.copyWith(corpus, turtle);
            List<GateCli.GateResult> after = GateCli.runAll(gateSpecs, proposed);
            respond(ex, 200, GateCli.toDeltaJson(baseline, after));
        } catch (Exception e) {
            respond(ex, 400, err(e));
        }
    }

    static String err(Exception e) {
        String m = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        return "{\"error\":\"" + GateCli.esc(m) + "\"}";
    }

    void respond(HttpExchange ex, int code, String body) throws IOException {
        byte[] out = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("content-type", "application/json");
        ex.sendResponseHeaders(code, out.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(out);
        }
    }
}
