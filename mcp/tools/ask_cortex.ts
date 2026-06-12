// ask_cortex — the single entry-point tool for querying ingested repos.
// Orchestrates server-side: verifies the repo is ingested, runs semantic
// search, then automatically checks freshness on every open issue/PR in the
// results and appends staleness warnings. The AI client never needs to call
// search_docs or check_freshness directly.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QdrantClient } from "@qdrant/js-client-rest";
import { COLLECTION_NAME, QDRANT_URL } from "../../rag/settings.js";
import { search } from "../internal/search.js";
import { checkFreshness } from "../internal/freshness.js";
import { detectMissingDocs } from "../internal/missing.js";
import { summarize } from "../internal/summarize.js";

async function isIngested(owner: string, repo: string): Promise<boolean> {
  const client = new QdrantClient({ url: QDRANT_URL });
  const result = await client.scroll(COLLECTION_NAME, {
    filter: {
      must: [
        { key: "owner", match: { value: owner } },
        { key: "repo", match: { value: repo } },
      ],
    },
    limit: 1,
    with_payload: false,
    with_vector: false,
  });
  return result.points.length > 0;
}

export function registerAskCortex(server: McpServer) {
  server.registerTool(
    "ask_cortex",
    {
      title: "Ask Cortex",
      description:
        "Ask any question about a GitHub repo's issues and PRs. " +
        "If the repo is not ingested, call ingest_docs first.",
      inputSchema: z.object({
        question: z.string().describe("The question to answer using the repo's issues and PRs"),
        owner: z.string().describe("GitHub username or org that owns the repo"),
        repo: z.string().describe("Repository name"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ question, owner, repo }) => {
      // Gate: verify the repo is ingested before doing anything else.
      const ingested = await isIngested(owner, repo);
      if (!ingested) {
        return {
          content: [{
            type: "text",
            text:
              `${owner}/${repo} has not been ingested yet. ` +
              `Call ingest_docs with owner="${owner}" and repo="${repo}" first, then ask again.`,
          }],
        };
      }

      // Semantic search and missing-docs detection run together — they hit
      // different systems (Qdrant+Gemini vs the GitHub API) and neither depends
      // on the other, so parallelising keeps the detection latency hidden behind
      // the search. Detection failures must never sink the answer, so a failed
      // GitHub lookup degrades to "no missing info" rather than throwing.
      const [{ answer, sources }, missingResult] = await Promise.all([
        search(question),
        detectMissingDocs(owner, repo).catch(() => null),
      ]);

      // Freshness checks and summarization both depend on the search result but
      // not on each other — freshness hits the GitHub API per open source while
      // summarize makes one Gemini call — so we overlap them. summarize returns
      // null for short answers or on any error, so it never blocks the response.
      const openSources = sources.filter(s => s.state === "open");
      const [freshnessResults, tldr] = await Promise.all([
        Promise.all(openSources.map(checkFreshness)),
        summarize(question, answer),
      ]);

      // Build the source lines with created/updated timestamps.
      const sourceLines = sources.map(s => {
        const parts = [`- ${s.file_name}`];
        if (s.created_at) parts.push(`created: ${s.created_at}`);
        if (s.updated_at) parts.push(`updated: ${s.updated_at}`);
        return parts.join(" | ");
      });

      // Build freshness warnings for stale open items.
      const warnings: string[] = [];
      for (const fr of freshnessResults) {
        if (!fr) continue;
        if (fr.isOpen && fr.hasNewActivity) {
          warnings.push(
            `⚠ ${fr.file_name} is still open and has new activity on GitHub since it was last synced ${fr.syncedLabel}. ` +
            `Ask the user whether they'd like to re-sync the latest updates into Cortex; ` +
            `if they agree, call ingest_docs with since="${fr.ingestedAt}" to update only the changed items.`,
          );
        } else if (fr.isOpen && !fr.hasNewActivity) {
          warnings.push(`✓ ${fr.file_name} is open and up to date (synced ${fr.syncedLabel}).`);
        }
      }

      // Missing-docs notice: issues/PRs created after the last ingest aren't in
      // Qdrant at all, so the answer above was produced without them. Surface
      // them, then frame the fix as a re-sync offer the agent puts to the user
      // rather than a bare command — the user just says yes, and the agent runs
      // the ingest. The `since` mechanics stay as an internal hint for the agent
      // so the re-sync only pulls the new items, not the whole repo.
      const missing = missingResult?.missing ?? [];
      let missingNotice = "";
      if (missing.length > 0) {
        const one = missing.length === 1;
        const itemLines = missing.map(
          (m) => `- ${m.file_name} — "${m.title}" (created ${m.created_at})`,
        );
        missingNotice =
          `\n⚠ ${missing.length} new ${one ? "item has" : "items have"} been opened on GitHub since ` +
          `${owner}/${repo} was last synced, so the answer above doesn't include ${one ? "it" : "them"}:\n` +
          itemLines.join("\n") +
          `\n\nAsk the user whether they'd like to re-sync the latest updates into Cortex. ` +
          `If they agree, add ${one ? "it" : "them"} by calling ingest_docs with owner="${owner}", ` +
          `repo="${repo}", since="${missingResult!.latestIngestedAt}", then answer again.`;
      }

      // Lead with the TL;DR (when one was produced) so the conclusion is the
      // first thing the caller sees, with the full answer right below it.
      const sections: string[] = [];
      if (tldr) {
        sections.push("TL;DR:\n" + tldr + "\n");
      }
      sections.push(answer);
      if (sourceLines.length > 0) {
        sections.push("\nSources:\n" + sourceLines.join("\n"));
      }
      if (warnings.length > 0) {
        sections.push("\nFreshness:\n" + warnings.join("\n"));
      }
      if (missingNotice) {
        sections.push("\nMissing:\n" + missingNotice.trimStart());
      }

      return {
        content: [{ type: "text", text: sections.join("") }],
      };
    },
  );
}
