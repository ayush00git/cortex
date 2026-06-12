// Internal answer summarizer — not exposed as an MCP tool. Called by ask_cortex.
//
// search() already returns a grounded answer, but when several issue/PR threads
// match a question that answer can run several paragraphs deep, and the caller
// has to read all of it to get the gist. This condenses a long answer into a
// short TL;DR that ask_cortex prepends, so the conclusion is graspable at a
// glance and the detail is there only if needed.
//
// It reuses the Gemini LLM that initSettings() already wired into the global
// Settings during search(), rather than standing up a second model. To stay
// cheap and unobtrusive it only fires for answers past a length threshold, and
// it fails safe — any error returns null so the real answer is never lost.

import { Settings } from "llamaindex";

// Answers shorter than this are already their own summary; condensing them
// burns an LLM round trip for no benefit, so we skip below the threshold.
const MIN_CHARS_TO_SUMMARIZE = 600;

export async function summarize(
  question: string,
  answer: string,
): Promise<string | null> {
  if (answer.trim().length < MIN_CHARS_TO_SUMMARIZE) return null;

  const prompt =
    "Condense the following answer into a TL;DR of at most 3 sentences. " +
    "Keep only the conclusion and the facts that matter most to the question; " +
    "add nothing that isn't already in the answer, and don't restate the question.\n\n" +
    `Question: ${question}\n\n` +
    `Answer:\n${answer}\n\n` +
    "TL;DR:";

  try {
    // Settings.llm is set by initSettings() inside search(); since summarize is
    // only ever called after a search in the same request, it's configured here.
    const response = await Settings.llm.complete({ prompt });
    const tldr = response.text.trim();
    return tldr.length > 0 ? tldr : null;
  } catch {
    // A summarization failure must never sink the underlying answer.
    return null;
  }
}
