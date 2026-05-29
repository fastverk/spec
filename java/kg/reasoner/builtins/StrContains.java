package kg.reasoner.builtins;

import org.apache.jena.graph.Node;
import org.apache.jena.reasoner.rulesys.RuleContext;
import org.apache.jena.reasoner.rulesys.builtins.BaseBuiltin;

/**
 * Jena rule builtin: {@code strContains(?haystack, ?needle)}.
 *
 * Returns true iff both args are literals and {@code haystack.contains(needle)}.
 * Custom builtin (vs built-in {@code regex}) because rule-level regex
 * doesn't accept a variable pattern in Jena's rule engine; with this we
 * can match a rule's free-text predicate against any of the dynamically-
 * bound diagnostic codes in the corpus.
 *
 * Example use in a rule file (see kg/rules/emits-from-text.rule):
 *
 *   [emitsFromText:
 *      (?rule rdf:type rfc:NormativeStatement)
 *      (?rule rfc:predicate ?text)
 *      (?diag rdf:type rfc:Diagnostic)
 *      (?diag rfc:code ?code)
 *      strContains(?text, ?code)
 *      -> (?rule rfc:emits ?diag)]
 */
public final class StrContains extends BaseBuiltin {

    @Override
    public String getName() { return "strContains"; }

    @Override
    public int getArgLength() { return 2; }

    @Override
    public boolean bodyCall(Node[] args, int length, RuleContext context) {
        checkArgs(length, context);
        Node hay = getArg(0, args, context);
        Node needle = getArg(1, args, context);
        if (!hay.isLiteral() || !needle.isLiteral()) return false;
        String h = hay.getLiteralLexicalForm();
        String n = needle.getLiteralLexicalForm();
        if (n.isEmpty()) return false;
        return h.contains(n);
    }
}
