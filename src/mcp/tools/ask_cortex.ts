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

      // Semantic search.
      const { answer, sources } = await search(question);

      // Run freshness checks on all open sources in parallel.
      const openSources = sources.filter(s => s.state === "open");
      const freshnessResults = await Promise.all(openSources.map(checkFreshness));

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
            `Call ingest_docs with since="${fr.ingestedAt}" to re-sync only the updated items.`,
          );
        } else if (fr.isOpen && !fr.hasNewActivity) {
          warnings.push(`✓ ${fr.file_name} is open and up to date (synced ${fr.syncedLabel}).`);
        }
      }

      const sections: string[] = [answer];
      if (sourceLines.length > 0) {
        sections.push("\nSources:\n" + sourceLines.join("\n"));
      }
      if (warnings.length > 0) {
        sections.push("\nFreshness:\n" + warnings.join("\n"));
      }

      return {
        content: [{ type: "text", text: sections.join("") }],
      };
    },
  );
}
