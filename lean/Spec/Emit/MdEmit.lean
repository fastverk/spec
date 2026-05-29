/-
Spec.Emit.MdEmit — Markdown (CommonMark) string-emission helpers.

Sibling of `Spec.Emit.TtlEmit`. Pure `String` concatenation; the
output targets mdbook's CommonMark dialect (the renderer the
rest of `docs/` is built on).

Surface:
  - heading at any level
  - bullet list
  - paragraph
  - inline link `[text](url)`
  - bold / italic
  - inline `code`
  - fenced code block with language
  - table (header row + body rows)
-/

namespace Spec.Emit.MdEmit

/-- A heading: `# Title` for level 1, `## Subtitle` for level 2, etc.
    Includes the trailing blank line CommonMark needs to start a new
    block, so the heading composes cleanly with whatever follows. -/
def heading (level : Nat) (text : String) : String :=
  String.ofList (List.replicate level '#') ++ " " ++ text ++ "\n\n"

/-- An unordered bullet list. One item per element; trailing
    newline closes the list. -/
def bulletList (items : List String) : String :=
  String.intercalate "\n" (items.map ("- " ++ ·)) ++ "\n"

/-- A paragraph followed by a blank line. -/
def para (s : String) : String := s ++ "\n\n"

/-- Inline link. -/
def link (text : String) (url : String) : String :=
  "[" ++ text ++ "](" ++ url ++ ")"

/-- Bold inline. -/
def bold (s : String) : String := "**" ++ s ++ "**"

/-- Italic inline. -/
def italic (s : String) : String := "*" ++ s ++ "*"

/-- Inline code span. Backticks bracket the code; for code
    containing backticks the caller picks a longer fence — we keep
    this helper simple (one backtick). -/
def code (s : String) : String := "`" ++ s ++ "`"

/-- Fenced code block. ```lang\n<body>\n```\n -/
def codeBlock (lang : String) (body : String) : String :=
  "```" ++ lang ++ "\n" ++ body ++ (if body.endsWith "\n" then "" else "\n") ++ "```\n"

/-- A simple GFM-style table. `header` is the column headings;
    `rows` is the body. Header/body cells use ` | ` separators; the
    delimiter row uses the compact `|---|---|` form (no inner
    spaces) to match Kg2md's output style. -/
def table (header : List String) (rows : List (List String)) : String :=
  let pipe := fun (cells : List String) => "| " ++ String.intercalate " | " cells ++ " |"
  let dashesRow := "|" ++ String.intercalate "" (header.map (fun _ => "---|"))
  String.intercalate "\n" ([pipe header, dashesRow] ++ rows.map pipe) ++ "\n"

/-- Horizontal rule. -/
def hrule : String := "\n---\n\n"

end Spec.Emit.MdEmit
