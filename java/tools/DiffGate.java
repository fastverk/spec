package tools;

import com.google.devtools.build.runfiles.Runfiles;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;

/**
 * Byte-stable drift gate: compares a Bazel-generated artifact against its
 * committed copy in the source tree. The generic counterpart to
 * {@code //tools:update_artifact.sh} (which writes the artifact back) — run
 * this as a {@code java_test} via spec's {@code emit_diff_test} macro to
 * fail the build whenever the committed copy drifts from the emitter.
 *
 * <p>Args: {@code <generated_rlocation> <committed_rlocation> <update_target_label>}.
 * The two file args are {@code $(rlocationpath ...)} values resolved through the
 * Bazel runfiles library, so this works identically whether the inputs come from
 * the main repo or an external module — no hard-coded workspace-name probing.
 *
 * <p>Exit 0 when the files are byte-identical; exit 1 (with a remediation hint
 * naming the update target) otherwise.
 */
public final class DiffGate {
    private DiffGate() {}

    public static void main(String[] args) throws IOException {
        if (args.length != 3) {
            System.err.println(
                "usage: DiffGate <generated_rlocation> <committed_rlocation> <update_target_label>");
            System.exit(2);
        }
        Runfiles rf = Runfiles.create();
        Path generated = locate(rf, args[0]);
        Path committed = locate(rf, args[1]);
        String updateTarget = args[2];

        byte[] g = Files.readAllBytes(generated);
        byte[] c = Files.readAllBytes(committed);
        if (Arrays.equals(g, c)) {
            System.out.println("[diff_gate] " + args[1] + " matches the emitter.");
            return;
        }
        System.err.println("ERROR: " + args[1] + " is out of sync with the emitter.");
        System.err.println("       Run: bazel run " + updateTarget);
        printFirstDiff(c, g);
        System.exit(1);
    }

    private static Path locate(Runfiles rf, String rloc) {
        String p = rf.rlocation(rloc);
        if (p == null || !Files.exists(Paths.get(p))) {
            System.err.println("ERROR: could not locate runfile: " + rloc);
            System.exit(2);
        }
        return Paths.get(p);
    }

    private static void printFirstDiff(byte[] committed, byte[] generated) {
        List<String> c = splitLines(committed);
        List<String> g = splitLines(generated);
        int n = Math.min(c.size(), g.size());
        System.err.println("       First difference (committed '-' vs generated '+'):");
        for (int i = 0; i < n; i++) {
            if (!c.get(i).equals(g.get(i))) {
                int lo = Math.max(0, i - 2);
                for (int j = lo; j <= i; j++) {
                    System.err.println("       " + (j + 1) + "- " + c.get(j));
                    System.err.println("       " + (j + 1) + "+ " + g.get(j));
                }
                return;
            }
        }
        System.err.println(
            "       (one file is a prefix of the other: committed=" + c.size()
            + " lines, generated=" + g.size() + " lines)");
    }

    private static List<String> splitLines(byte[] b) {
        return Arrays.asList(new String(b, StandardCharsets.UTF_8).split("\n", -1));
    }
}
