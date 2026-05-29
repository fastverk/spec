package kg.edit;

import java.io.PrintStream;
import java.util.List;
import java.util.Map;

/**
 * Dual-mode output: human (default) or JSON (for agent consumption,
 * via {@code --json}).
 *
 * Every kg_edit subcommand writes one {@link Result} at the end; the
 * caller chooses the format. JSON shape is intentionally flat and stable:
 * agents that script over kg_edit shouldn't have to special-case per
 * subcommand.
 *
 * Schema (every subcommand):
 *   {
 *     "subcommand": "search",
 *     "args": { ... },
 *     "results": [ {...}, ... ],
 *     "messages": ["..."],   // human-facing notes
 *     "exit": 0
 *   }
 */
public final class Output {

    public enum Mode { HUMAN, JSON }

    private Output() {}

    /** A single command's structured output. */
    public static record Result(
        String subcommand,
        Map<String, Object> args,
        List<Map<String, Object>> rows,
        List<String> messages,
        int exitCode
    ) {}

    public static void write(Result r, Mode mode, PrintStream out) {
        switch (mode) {
            case JSON -> out.println(toJson(r));
            case HUMAN -> writeHuman(r, out);
        }
    }

    // -----------------------------------------------------------------------
    // Human renderer — concise, scannable, no prefixes per row
    // -----------------------------------------------------------------------

    private static void writeHuman(Result r, PrintStream out) {
        for (String m : r.messages) out.println(m);
        if (!r.rows.isEmpty()) {
            // Use the first row's keys as the column order.
            List<String> cols = List.copyOf(r.rows.get(0).keySet());
            // Compute column widths (cap to 60 to keep lines bounded).
            int[] widths = new int[cols.size()];
            for (int i = 0; i < cols.size(); i++) widths[i] = Math.min(60, cols.get(i).length());
            for (Map<String, Object> row : r.rows) {
                for (int i = 0; i < cols.size(); i++) {
                    Object v = row.get(cols.get(i));
                    if (v != null) widths[i] = Math.min(60, Math.max(widths[i], String.valueOf(v).length()));
                }
            }
            StringBuilder header = new StringBuilder();
            for (int i = 0; i < cols.size(); i++) {
                if (i > 0) header.append("  ");
                header.append(padRight(cols.get(i), widths[i]));
            }
            out.println(header);
            StringBuilder rule = new StringBuilder();
            for (int i = 0; i < cols.size(); i++) {
                if (i > 0) rule.append("  ");
                rule.append("-".repeat(widths[i]));
            }
            out.println(rule);
            for (Map<String, Object> row : r.rows) {
                StringBuilder line = new StringBuilder();
                for (int i = 0; i < cols.size(); i++) {
                    if (i > 0) line.append("  ");
                    String v = row.get(cols.get(i)) == null ? "" : String.valueOf(row.get(cols.get(i)));
                    line.append(padRight(truncate(v, 60), widths[i]));
                }
                out.println(line);
            }
            out.println();
            out.println(r.rows.size() + " result(s).");
        }
    }

    private static String padRight(String s, int width) {
        return s + " ".repeat(Math.max(0, width - s.length()));
    }

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    // -----------------------------------------------------------------------
    // JSON encoder (tiny, no external dep)
    // -----------------------------------------------------------------------

    public static String toJson(Result r) {
        StringBuilder b = new StringBuilder();
        b.append("{\"subcommand\":").append(jsonStr(r.subcommand));
        b.append(",\"args\":").append(jsonValue(r.args));
        b.append(",\"results\":").append(jsonValue(r.rows));
        b.append(",\"messages\":").append(jsonValue(r.messages));
        b.append(",\"exit\":").append(r.exitCode);
        b.append("}");
        return b.toString();
    }

    static String jsonValue(Object v) {
        if (v == null) return "null";
        if (v instanceof String s) return jsonStr(s);
        if (v instanceof Boolean b) return b.toString();
        if (v instanceof Number n) return n.toString();
        if (v instanceof Map<?, ?> m) {
            StringBuilder b = new StringBuilder("{");
            boolean first = true;
            for (var e : m.entrySet()) {
                if (!first) b.append(',');
                first = false;
                b.append(jsonStr(String.valueOf(e.getKey()))).append(':').append(jsonValue(e.getValue()));
            }
            return b.append('}').toString();
        }
        if (v instanceof List<?> list) {
            StringBuilder b = new StringBuilder("[");
            boolean first = true;
            for (Object item : list) {
                if (!first) b.append(',');
                first = false;
                b.append(jsonValue(item));
            }
            return b.append(']').toString();
        }
        return jsonStr(v.toString());
    }

    static String jsonStr(String s) {
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
