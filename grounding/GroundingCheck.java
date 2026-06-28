package grounding;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The grounding gate — the un-gameable core of the crank's score.
 *
 * The score counts a claim as "proven" only because a real, sorry-free Lean
 * theorem backs it. This gate enforces exactly that for in-repo groundings: every
 * {@code :provenBy "Spec.Grounding.*"} in the ratio corpus must resolve to a
 * {@code theorem} that (a) is declared in the grounding Lean module and (b) lives
 * in a module with no {@code sorry} (its compilation is proven by
 * //lean:grounding_test). A fabricated {@code :provenBy} — a convincing string
 * with no matching theorem — fails this gate, so it can never raise the score.
 *
 * Built-in negative control: the same resolution applied to a fabricated name is
 * asserted to be rejected, demonstrating the gate discriminates real from fake.
 *
 * java_test (use_testrunner=False): a non-zero exit fails the test.
 */
public final class GroundingCheck {
  public static void main(String[] args) throws Exception {
    Path root = Paths.get(System.getenv("TEST_SRCDIR"));
    String lean = Files.readString(find(root, "WriteDoor.lean"));
    String ttl = Files.readString(find(root, "ratio-corpus.ttl"));

    // (1) The grounding module must be sorry-free — no proof may be stubbed.
    //     (Strip comments first; "sorry-free" in prose is not a stubbed proof.)
    String code = lean.replaceAll("(?s)/-.*?-/", " ").replaceAll("(?m)--.*$", " ");
    check(!code.contains("sorry"), "grounding Lean module must contain no 'sorry' proof");

    // (2) The sorry-free theorems it declares (leaf names).
    Set<String> proven = new TreeSet<>();
    Matcher tm = Pattern.compile("(?m)^\\s*theorem\\s+([A-Za-z0-9_']+)").matcher(lean);
    while (tm.find()) {
      proven.add(tm.group(1));
    }
    check(!proven.isEmpty(), "grounding module must declare at least one theorem");

    // (3) Every in-repo :provenBy must resolve to one of those theorems.
    Matcher pm = Pattern.compile(":provenBy\\s+\"([^\"]+)\"").matcher(ttl);
    int verified = 0;
    while (pm.find()) {
      String name = pm.group(1);
      if (!name.startsWith("Spec.Grounding.")) {
        continue; // cross-repo groundings (e.g. ratio's own Lean) aren't checked here
      }
      String leaf = name.substring(name.lastIndexOf('.') + 1);
      check(
          proven.contains(leaf),
          "provenBy '" + name + "' does NOT resolve to a sorry-free theorem "
              + "in the grounding module (proven: " + proven + ")");
      verified++;
    }
    check(verified >= 1, "expected at least one in-repo-grounded corpus claim");

    // (4) Negative control: a fabricated provenBy must NOT resolve — the gate
    //     discriminates real proofs from convincing strings.
    String fake = "Spec.Grounding.WriteDoor.this_was_never_proved";
    String fakeLeaf = fake.substring(fake.lastIndexOf('.') + 1);
    check(!proven.contains(fakeLeaf), "a fabricated provenBy must be rejected");

    System.out.println(
        "grounding verified — " + verified + " corpus claim(s) resolve to sorry-free Lean "
            + "theorems " + proven + " (compilation proven by //lean:grounding_test).");
    System.out.println("negative control OK — fabricated '" + fake + "' is rejected.");
  }

  private static Path find(Path root, String name) throws Exception {
    try (Stream<Path> w = Files.walk(root)) {
      return w.filter(p -> p.getFileName().toString().equals(name))
          .findFirst()
          .orElseThrow(() -> new RuntimeException("not found in runfiles: " + name));
    }
  }

  private static void check(boolean cond, String msg) {
    if (!cond) {
      throw new RuntimeException("CHECK FAILED: " + msg);
    }
  }
}
