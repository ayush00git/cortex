// ingest_docs tool - lets an AI client ingest a repo on demand instead of
// requiring a pre-seeded Qdrant collection. Supports full ingest and partial
// re-sync (via `since`) for targeted updates identified by check_freshness.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ingest } from "../../rag/ingest.js";

export function registerIngestDocs(server: McpServer) {
  server.registerTool(
    "ingest_docs",
    {
      title: "Ingest GitHub repo",
      description:
        "Fetches issues and pull requests from a GitHub repo and stores them in Qdrant. " +
        "For a first-time ingest or full re-sync, omit `since`. " +
        "When check_freshness identifies stale items, pass their `ingested_at` value as `since` " +
        "to re-sync only the issues/PRs updated after that timestamp — much faster than a full re-ingest. " +
        "Once done, call search_docs to answer the original question.",
      inputSchema: z.object({
        owner: z.string().describe("GitHub username or org that owns the repo"),
        repo: z.string().describe("Repository name"),
        since: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp. When provided, only issues and PRs updated after this time " +
            "are re-fetched. Pass the `ingested_at` value returned by check_freshness.",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ owner, repo, since }) => {
      try {
        await ingest(owner, repo, since);
        const scope = since ? `items updated since ${since}` : "all issues and PRs";
        return {
          content: [
            {
              type: "text",
              text: `Ingestion complete for ${owner}/${repo} (${scope}). You can now call search_docs to answer the question.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Ingestion failed for ${owner}/${repo}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
