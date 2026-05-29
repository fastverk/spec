package kg.edit;

import java.util.regex.Pattern;

/**
 * Resolves the short, human-typed handles that {@code kg_edit} accepts
 * on the command line into the IRIs / SPARQL fragments needed downstream.
 *
 * Handle shapes recognized:
 *   RFC-NNNN          → IRI rfc:RFC-NNNN
 *   M{NN}xxx          → SPARQL fragment matching ?d a rfc:Diagnostic ; rfc:code "..."
 *   KP-NNN or KPNNN   → IRI kp:KP-NNN
 *   bare term name    → SPARQL fragment matching ?t a rfc:Term ; rfc:name "..."
 *   <full IRI>        → IRI used as-is (must be wrapped in angle brackets when typed)
 *
 * Resolution returns either a concrete IRI or a "where-clause fragment"
 * for queries that need to bind by literal property value.
 */
public final class Handles {

    public static final String RFC_PREFIX = "https://aion.savvi.io/rfc/";
    public static final String RFC_ONT_PREFIX = "https://aion.savvi.io/ontology/rfc#";
    public static final String KP_PREFIX = "https://aion.savvi.io/kp/";

    private static final Pattern RFC_PAT  = Pattern.compile("RFC-\\d{4}");
    private static final Pattern DIAG_PAT = Pattern.compile("[A-Z]\\d{4,6}");
    private static final Pattern KP_PAT   = Pattern.compile("KP-?\\d+");
    private static final Pattern IRI_PAT  = Pattern.compile("<[^>]+>");

    private Handles() {}

    public enum Kind { RFC, DIAGNOSTIC, KP, TERM, IRI, UNKNOWN }

    public static Kind classify(String handle) {
        if (handle == null || handle.isEmpty()) return Kind.UNKNOWN;
        if (IRI_PAT.matcher(handle).matches()) return Kind.IRI;
        if (RFC_PAT.matcher(handle).matches()) return Kind.RFC;
        if (DIAG_PAT.matcher(handle).matches()) return Kind.DIAGNOSTIC;
        if (KP_PAT.matcher(handle).matches()) return Kind.KP;
        // Anything else is treated as a term name (free-text).
        return Kind.TERM;
    }

    /** Return a Turtle-style IRI string ({@code <...>} or {@code prefix:local})
     *  when the handle directly names a subject. Returns null for handles
     *  that need a literal-property lookup (DIAGNOSTIC, TERM). */
    public static String toIri(String handle) {
        return switch (classify(handle)) {
            case IRI -> handle;
            case RFC -> "<" + RFC_PREFIX + handle + ">";
            case KP -> {
                String num = handle.startsWith("KP-") ? handle.substring(3) : handle.substring(2);
                yield "<" + KP_PREFIX + "KP-" + num + ">";
            }
            default -> null;
        };
    }

    /** Build a single-line SPARQL pattern that binds {@code ?subject} to
     *  whatever the handle refers to. Caller wraps in WHERE { ... }. */
    public static String bindPattern(String handle, String subjectVar) {
        Kind k = classify(handle);
        return switch (k) {
            case IRI, RFC, KP -> "BIND(" + toIri(handle) + " AS " + subjectVar + ")";
            case DIAGNOSTIC -> subjectVar + " a <" + RFC_ONT_PREFIX + "Diagnostic> ; "
                + "<" + RFC_ONT_PREFIX + "code> \"" + escape(handle) + "\" .";
            case TERM -> subjectVar + " a <" + RFC_ONT_PREFIX + "Term> ; "
                + "<" + RFC_ONT_PREFIX + "name> \"" + escape(handle) + "\" .";
            case UNKNOWN -> throw new IllegalArgumentException("could not classify handle: " + handle);
        };
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
