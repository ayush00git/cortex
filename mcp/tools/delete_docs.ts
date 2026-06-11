// delete_docs tool — removes all Qdrant points belonging to a specific repo.
// Useful when a repo's data is stale and needs a clean re-ingest.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QdrantClient } from "@qdrant/js-client-rest";
import { COLLECTION_NAME, QDRANT_URL } from "../../rag/settings.js";

export function registerDeleteDocs(server: McpServer) {
  server.registerTool(
    "delete_docs",
    {
      title: "Delete repo docs",
      description:
        "Deletes all ingested issues and PRs for a given GitHub repo from Qdrant. Use before re-ingesting a repo to avoid stale data.",
      inputSchema: z.object({
        owner: z.string().describe("GitHub username or org that owns the repo"),
        repo: z.string().describe("Repository name"),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ owner, repo }) => {
      const client = new QdrantClient({ url: QDRANT_URL });

      // Delete all points whose payload matches owner + repo exactly.
      // This is a single API call — Qdrant handles the filtering internally.
      await client.delete(COLLECTION_NAME, {
        filter: {
          must: [
            { key: "owner", match: { value: owner } },
            { key: "repo", match: { value: repo } },
          ],
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `Deleted all documents for ${owner}/${repo} from the "${COLLECTION_NAME}" collection.`,
          },
        ],
      };
    },
  );
}
