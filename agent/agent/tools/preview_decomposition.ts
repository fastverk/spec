import { defineTool } from "eve/tools";
import { z } from "zod";

// ⛔ THE SAME MODULE THE CONSOLE'S PREVIEW USES, AND THE SAME RULE THE CORPUS
// DECOMPOSER USES. Not a description of the rule, not a re-implementation of it
// in a prompt — the function itself, imported across the package boundary.
//
// A model asked to "find the marked terms" will get it right most of the time
// and confidently wrong on the cases that matter: a bolded clause of five words,
// a surface marked both ways, an odd number of backticks. Those are exactly the
// cases where the author needs the truth, and exactly the cases where a plausible
// answer is worse than no answer.
//
// conformance/decomposition_cases.json is executed against both this rule and
// tools/import/decompose.py on every PR, so this tool cannot drift from the
// thing that will actually decompose the corpus.
import { MAX_TERM_WORDS, advise, droppedEmphasis, extract } from "../../../console/lib/decompose";

export default defineTool({
  description:
    "Decompose a requirement's text under the real corpus rule and return the terms it " +
    "produces, the bolded spans that get dropped for being too long, and whether it " +
    "decomposes to nothing. Call this before saying anything about what a sentence " +
    "decomposes to — do not reason it out yourself.",
  inputSchema: z.object({
    predicate: z
      .string()
      .describe("The requirement text, including its `code span` and **emphasis** markup."),
  }),
  async execute({ predicate }) {
    const terms = extract(predicate);
    return {
      terms,
      dropped_emphasis: droppedEmphasis(predicate),
      max_term_words: MAX_TERM_WORDS,
      advice: advise(predicate),
      // Said explicitly, because "no terms" is the answer a model is most likely
      // to soften into something more encouraging.
      decomposes_to_nothing: terms.length === 0,
    };
  },
});
