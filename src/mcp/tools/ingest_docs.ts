// ingest_docs tool - lets an AI client ingest a repo on demand instead of
// requiring a pre-seeded Qdrant collection. After ingestion completes it
// signals the client to call search_docs to answer the original question.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ingest } from "../../rag/ingest.js";

export function registerIngestDocs(server: McpServer) {
  server.registerTool(
    "ingest_docs",
    {
      title: "Ingest GitHub repo",
      description:
        "Fetches all issues and pull requests from a GitHub repo and stores them in Qdrant so they can be searched. Call this when search_docs returns no results or the user asks about a repo that hasn't been ingested yet. Once done, call search_docs to answer the original question.",
      inputSchema: z.object({
        owner: z.string().describe("GitHub username or org that owns the repo"),
        repo: z.string().describe("Repository name"),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ owner, repo }) => {
      try {
        await ingest(owner, repo);
        return {
          content: [
            {
              type: "text",
              text: `Ingestion complete for ${owner}/${repo}. You can now call search_docs to answer the question.`,
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
