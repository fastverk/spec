/-
Spec.Emit.TtlEmit — TTL (Turtle) string-emission helpers.

Phase 1 of the dep-graph inversion: when the spec graph is emitted
*from* Lean rather than authored *into* Lean from TTL, this module
is the serializer. Pure `String` concatenation; no external libraries.

The Turtle spec we target is the W3C Turtle 1.1 subset our consumers
already use:
  - `@prefix` declarations
  - absolute IRIs in `<...>`
  - prefix-namespaced predicates (`:foo`, `rfc:bar`)
  - typed/plain string literals in `"..."` with the standard backslash
    escapes
  - predicate-object lists separated by ` ; ` and terminated by ` .`
  - boolean literals (`true`, `false`) — bare, no quotes

We emit one triple-block per top-level subject; pretty-printing is
fixed (4-space property indent, one property per line) so output is
byte-stable.
-/

namespace Spec.Emit.TtlEmit

/-- Escape a string for Turtle's `"..."` literal syntax. Implements
    the standard escapes from the Turtle 1.1 grammar:
      \\, \", \n, \r, \t — and leaves other characters untouched.
    UTF-8 passes through; consumers (Jena) handle it natively. -/
def escapeStringLit (s : String) : String :=
  s.foldl (init := "") fun acc c =>
    match c with
    | '\\' => acc ++ "\\\\"
    | '"'  => acc ++ "\\\""
    | '\n' => acc ++ "\\n"
    | '\r' => acc ++ "\\r"
    | '\t' => acc ++ "\\t"
    | _    => acc ++ s!"{c}"

/-- A Turtle-side value: a quoted string literal, a multi-line
    triple-quoted string (for SPARQL fragments and other prose
    where preserving newlines matters), an absolute IRI in angle
    brackets, a bare boolean, a prefix-qualified IRI
    (e.g. `:Axiom`), a blank-node reference (`_:b13`), or a typed
    boolean literal (`"true"^^xsd:boolean`). -/
inductive Value where
  | str       (s : String) : Value
  | strML     (s : String) : Value  -- emitted as `"""..."""`; caller embeds newlines/indentation
  | iri       (iri : String) : Value
  | bool      (b : Bool) : Value
  | qname     (qname : String) : Value
  /-- A blank-node reference, emitted as `_:<id>`. -/
  | bnode     (id : String) : Value
  /-- An xsd-typed boolean literal — needed because some corpus
      datasets serialize `:isAxiom "true"^^xsd:boolean` rather than
      the bare `true` keyword. -/
  | typedBool (b : Bool) : Value
  /-- Comma-separated list of values sharing a single predicate
      (TTL's `:foo a, b, c` syntax). -/
  | list      (vs : List Value) : Value
  deriving Repr

partial def emitValue : Value → String
  | .str s     => "\"" ++ escapeStringLit s ++ "\""
  | .strML s   => "\"\"\"" ++ s ++ "\"\"\""
  | .iri iri   => "<" ++ iri ++ ">"
  | .bool true => "true"
  | .bool false => "false"
  | .qname qn  => qn
  | .bnode id  => "_:" ++ id
  | .typedBool true  => "\"true\"^^<http://www.w3.org/2001/XMLSchema#boolean>"
  | .typedBool false => "\"false\"^^<http://www.w3.org/2001/XMLSchema#boolean>"
  | .list vs   => String.intercalate ", " (vs.map emitValue)

/-- A single (predicate, value) pair to emit on one indented line of
    a subject's predicate-object list. -/
structure TtlProp where
  predicate : String  -- e.g. ":name", "rfc:isAxiom", "a"
  value : Value
  deriving Repr

/-- Render one property line: `    <predicate> <value>` (no terminator —
    the caller emits the ` ;` or ` .` separator). -/
def emitTtlProp (p : TtlProp) : String :=
  "    " ++ p.predicate ++ " " ++ emitValue p.value

/-- Render a complete subject-block: one IRI followed by its
    predicate-object list, formatted with `;` separators on every
    property line except the last (which gets `.`). The final line
    ends with `\n` so blocks concatenate cleanly. -/
def emitSubject (subjectIri : String) (props : List TtlProp) : String :=
  let lines := props.zipIdx.map fun (p, i) =>
    let terminator := if i + 1 = props.length then " ." else " ;"
    emitTtlProp p ++ terminator
  "<" ++ subjectIri ++ ">\n" ++ String.intercalate "\n" lines ++ "\n"

/-- Like `emitSubject` but with a prefix-qualified subject (e.g.
    `rfc:M06020`) rather than an absolute IRI in `<...>`. -/
def emitQNameSubject (qname : String) (props : List TtlProp) : String :=
  let lines := props.zipIdx.map fun (p, i) =>
    let terminator := if i + 1 = props.length then " ." else " ;"
    emitTtlProp p ++ terminator
  qname ++ "\n" ++ String.intercalate "\n" lines ++ "\n"

/-- Like `emitSubject` but with a blank-node subject (`_:bN`). -/
def emitBnodeSubject (id : String) (props : List TtlProp) : String :=
  let lines := props.zipIdx.map fun (p, i) =>
    let terminator := if i + 1 = props.length then " ." else " ;"
    emitTtlProp p ++ terminator
  "_:" ++ id ++ "\n" ++ String.intercalate "\n" lines ++ "\n"

/-- Emit a `@prefix name: <iri> .` declaration line. -/
def emitPrefix (name : String) (iri : String) : String :=
  "@prefix " ++ name ++ ": <" ++ iri ++ "> ."

/-- Emit a full prefix block (one declaration per line, blank line at end). -/
def emitPrefixes (prefixes : List (String × String)) : String :=
  String.intercalate "\n" (prefixes.map (fun (n, i) => emitPrefix n i)) ++ "\n\n"

end Spec.Emit.TtlEmit
