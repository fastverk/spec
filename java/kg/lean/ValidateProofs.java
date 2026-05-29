package kg.lean;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Post-processes {@code Proofs.lean} after a {@link GenerateProofs}
 * run. Compiles the file with Lean; for any theorem whose proof
 * doesn't type-check, rewrites it to a {@code sorry} placeholder so
 * the rest of the file still compiles.
 *
 * Pattern: each theorem is wrapped in a parseable block. When Lean
 * reports an error at line N, find the theorem block containing
 * line N and replace its proof with sorry.
 *
 * Usage:
 *   bazel run //kg/java/lean:validate_proofs -- <path-to-Proofs.lean> <lean-binary-path>
 *
 * Lean binary must be on PATH or supplied as second arg.
 */
public final class ValidateProofs {

    public static void main(String[] args) throws IOException, InterruptedException {
        Path file = null;
        String leanBin = "lean";
        int maxIter = 100;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--max-iter".equals(a)) maxIter = Integer.parseInt(args[++i]);
            else if (file == null) file = Paths.get(a);
            else leanBin = a;
        }
        if (file == null) {
            System.err.println(
                "usage: validate_proofs <path-to-Proofs.lean> [lean-bin] [--max-iter N]");
            System.exit(2);
        }
        Result r = run(file, leanBin, maxIter);
        if (!r.ok) System.exit(1);
    }

    /** Outcome of a validate run. */
    public record Result(boolean ok, int patched, int iterations, String diagnosticTail) {}

    /** Library entry point — called both from {@link #main} and from
     *  {@code GenerateProofs} when {@code --validate} is set. Iterates
     *  compile → patch → recompile until either zero errors or no
     *  progress (the natural terminator). The iteration limit is a
     *  safety net against pathological loops. The workspace root is
     *  derived from the file path when null (assumes file lives in the
     *  Aion repo). */
    public static Result run(Path file, String leanBin, int maxIter)
            throws IOException, InterruptedException {
        return run(file, leanBin, maxIter, null);
    }

    public static Result run(Path file, String leanBin, int maxIter, Path workspace)
            throws IOException, InterruptedException {
        int patched = 0;
        for (int iter = 0; iter < maxIter; iter++) {
            CompileResult r = compileLean(file, leanBin, workspace);
            if (r.errorLines.isEmpty()) {
                System.err.printf("[validate_proofs] OK after %d iter(s); patched %d theorem(s)%n",
                    iter, patched);
                return new Result(true, patched, iter, "");
            }
            int p = patchFailingTheorems(file, r.errorLines);
            patched += p;
            if (p == 0) {
                System.err.println("[validate_proofs] no progress; remaining errors:");
                System.err.println(r.stderr);
                return new Result(false, patched, iter, r.stderr);
            }
            System.err.printf("[validate_proofs] iter %d: patched %d theorem(s) (cumulative %d)%n",
                iter + 1, p, patched);
        }
        System.err.println("[validate_proofs] exceeded iteration limit");
        return new Result(false, patched, maxIter, "iteration limit");
    }

    record CompileResult(boolean ok, List<Integer> errorLines, String stderr) {}

    private static CompileResult compileLean(Path file, String leanBin, Path workspaceArg)
            throws IOException, InterruptedException {
        // Stage the file under a tmp root so Lean's --root resolves.
        Path tmp = Files.createTempDirectory("lean-validate");
        Path target = tmp.resolve("Aion/Derivations/Proofs.lean");
        Files.createDirectories(target.getParent());
        Files.copy(file, target);

        // Resolve workspace root: explicit arg if given, otherwise walk
        // up from the file. The walk-up only works when the file lives
        // inside the workspace (true for committed Proofs.lean, false
        // for /tmp output from generate_proofs).
        Path workspace = workspaceArg;
        if (workspace == null) {
            Path w = file.toAbsolutePath();
            while (w != null && !Files.exists(w.resolve("MODULE.bazel"))) {
                w = w.getParent();
            }
            if (w == null) throw new IOException(
                "workspace root not found by walking up from " + file
                + "; pass workspace explicitly via run(file, leanBin, maxIter, workspace)");
            workspace = w;
        }
        Path leanRoot = workspace.resolve("kg/lean");
        copyTree(leanRoot.resolve("Aion/Spec"), tmp.resolve("Aion/Spec"));
        copyTree(leanRoot.resolve("Aion/Logic"), tmp.resolve("Aion/Logic"));

        // Compile each dep first (Lean wants .olean before import).
        runLean(leanBin, tmp, "Aion/Spec/Universe.lean");
        runLean(leanBin, tmp, "Aion/Spec/Predicates.lean");
        runLean(leanBin, tmp, "Aion/Spec/Kernel.lean");
        runLean(leanBin, tmp, "Aion/Spec/Axioms.lean");
        runLean(leanBin, tmp, "Aion/Logic/Core.lean");
        runLean(leanBin, tmp, "Aion/Logic/InferenceRulesProofs.lean");

        ProcessBuilder pb = new ProcessBuilder(leanBin, "--root=" + tmp,
            "Aion/Derivations/Proofs.lean");
        pb.directory(tmp.toFile());
        pb.environment().put("LEAN_PATH", tmp.toString());
        pb.redirectErrorStream(true);
        Process p = pb.start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        p.waitFor();

        // Lean 4.29 error format: "/path/.../Proofs.lean:LINE:COL: error(lean.X): …"
        // Older format: "…: error: …" — match both with optional `(...)`.
        Pattern errPattern = Pattern.compile(
            "(?m)^[^\\s].*?Proofs\\.lean:(\\d+):\\d+:\\s*error(?:\\([^)]*\\))?:");
        Matcher m = errPattern.matcher(out);
        Set<Integer> lines = new LinkedHashSet<>();
        while (m.find()) lines.add(Integer.parseInt(m.group(1)));

        return new CompileResult(lines.isEmpty(), new ArrayList<>(lines), out);
    }

    private static void runLean(String leanBin, Path root, String relPath)
            throws IOException, InterruptedException {
        Path src = root.resolve(relPath);
        Path olean = Paths.get(src.toString().replace(".lean", ".olean"));
        ProcessBuilder pb = new ProcessBuilder(leanBin, "--root=" + root, "-o", olean.toString(), src.toString());
        pb.directory(root.toFile());
        pb.environment().put("LEAN_PATH", root.toString());
        pb.redirectErrorStream(true);
        Process p = pb.start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        int rc = p.waitFor();
        if (rc != 0) {
            throw new IOException("lean dep compile failed for " + relPath + ":\n" + out);
        }
    }

    private static void copyTree(Path src, Path dst) throws IOException {
        if (!Files.isDirectory(src)) return;
        Files.walk(src).forEach(s -> {
            try {
                Path rel = src.relativize(s);
                Path d = dst.resolve(rel);
                if (Files.isDirectory(s)) Files.createDirectories(d);
                else { Files.createDirectories(d.getParent()); Files.copy(s, d); }
            } catch (IOException ignored) {}
        });
    }

    /** Read the Lean file as lines; for each error line, find the
     *  containing theorem block (between two `theorem deriv_` headers)
     *  and replace its body with `:= by sorry`. */
    private static int patchFailingTheorems(Path file, List<Integer> errorLines) throws IOException {
        List<String> lines = new ArrayList<>(Files.readAllLines(file, StandardCharsets.UTF_8));
        // Find theorem starts (1-indexed line numbers).
        List<int[]> blocks = new ArrayList<>();  // {startLine, endLine, theoremNameIdx}
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i).startsWith("theorem deriv_")) {
                blocks.add(new int[] { i + 1, -1, i });
            }
        }
        // Determine end line of each block (start of next block or EOF).
        for (int j = 0; j < blocks.size(); j++) {
            int end = (j + 1 < blocks.size())
                ? blocks.get(j + 1)[0] - 1
                : lines.size();
            blocks.get(j)[1] = end;
        }

        Set<Integer> patchedBlocks = new LinkedHashSet<>();
        for (int errLine : errorLines) {
            for (int j = 0; j < blocks.size(); j++) {
                int[] b = blocks.get(j);
                if (errLine >= b[0] && errLine <= b[1]) {
                    patchedBlocks.add(j);
                    break;
                }
            }
        }

        if (patchedBlocks.isEmpty()) return 0;

        // Replace each patched block body with sorry. Theorem block
        // structure (per emitTheorem in GenerateProofs):
        //   theorem deriv_HASH :
        //       <prop> := by
        //     <proof>
        //
        // Patch keeps the signature and replaces everything after `by` with sorry.
        // Process bottom-up so line-number shifts don't invalidate earlier
        // blocks' coordinates.
        List<Integer> ordered = new ArrayList<>(patchedBlocks);
        ordered.sort((a, b) -> Integer.compare(b, a));
        int actualPatches = 0;
        for (int j : ordered) {
            int[] b = blocks.get(j);
            // If the theorem already has `sorry` and STILL errors, the
            // problem is in the prop itself (not the proof). Replace the
            // whole theorem with a deferred-style stub that always compiles.
            if (alreadySorried(lines, b)) {
                stubReplace(lines, b);
                actualPatches++;
                continue;
            }
            String header = lines.get(b[2]);  // "theorem deriv_HASH :"
            // Find `:= by` in the lines after header.
            int byLine = -1;
            for (int k = b[2]; k < b[1]; k++) {
                if (lines.get(k).contains(":= by")) { byLine = k; break; }
            }
            if (byLine < 0) {
                // Theorem has no `:= by` line — likely a malformed prop.
                // Replace the whole theorem with a deferred stub.
                stubReplace(lines, b);
                actualPatches++;
                continue;
            }
            // The block boundary (b[1]) is "line before next theorem", which
            // includes the next theorem's preamble (blank line, `-- ` comments,
            // `opaque th_HASH : Prop` declaration). Find the actual end of
            // THIS theorem's body: the last line of contiguous proof tactics
            // starting at byLine+1.
            int bodyEnd = byLine;
            for (int k = byLine + 1; k < b[1]; k++) {
                String t = lines.get(k);
                if (t.isBlank()) break;                       // blank → next section
                if (t.startsWith("-- ")) break;               // comment → next theorem's preamble
                if (t.trim().startsWith("opaque th_")) break; // next theorem's th_ binding
                if (t.startsWith("theorem ")) break;          // next theorem header (should be caught by b[1] but be defensive)
                bodyEnd = k;
            }
            for (int k = bodyEnd; k > byLine; k--) {
                lines.remove(k);
            }
            lines.add(byLine + 1, "  sorry  -- LLM-proposed proof failed to type-check; reverted");
            actualPatches++;
        }

        Files.writeString(file, String.join("\n", lines) + "\n", StandardCharsets.UTF_8);
        return actualPatches;
    }

    /** Replace an entire theorem block (header + prop + body) with a
     *  deferred-style stub. Used when the prop itself is malformed
     *  (Lean can't elaborate it as a Prop) and sorry-substitution on
     *  the body alone won't fix it. The trailing comment-and-opaque
     *  preamble of the next theorem is preserved. */
    private static void stubReplace(List<String> lines, int[] block) {
        // Extract theorem hash from header: "theorem deriv_HASH :" or
        // "theorem deriv_HASH : ... := by sorry".
        String header = lines.get(block[2]);
        int prefixLen = "theorem deriv_".length();
        int spaceIdx = header.indexOf(' ', prefixLen);
        if (spaceIdx < 0) spaceIdx = header.length();
        String hash = header.substring(prefixLen, spaceIdx).replaceAll("[^A-Za-z0-9_]", "");
        // Find the contiguous run of theorem lines; preserve trailing
        // preamble of next theorem.
        int bodyEnd = block[2];
        for (int k = block[2] + 1; k < block[1]; k++) {
            String t = lines.get(k);
            if (t.isBlank()) break;
            if (t.startsWith("-- ")) break;
            if (t.trim().startsWith("opaque th_")) break;
            bodyEnd = k;
        }
        for (int k = bodyEnd; k >= block[2]; k--) {
            lines.remove(k);
        }
        lines.add(block[2], "theorem deriv_" + hash + " : th_" + hash + " := by sorry");
        lines.add(block[2], "opaque th_" + hash + " : Prop");
    }

    /** True if any line in the block already contains a bare `sorry` —
     *  meaning the theorem is either a deferred one-liner or was patched
     *  in a prior iteration. Re-patching such theorems either no-ops or
     *  (worse) breaks the one-liner by appending invalid syntax. */
    private static boolean alreadySorried(List<String> lines, int[] block) {
        for (int k = block[2]; k < block[1]; k++) {
            String t = lines.get(k).trim();
            if (t.equals("sorry") || t.startsWith("sorry ")
                || t.startsWith("sorry-") || t.endsWith(":= by sorry")) {
                return true;
            }
        }
        return false;
    }
}
