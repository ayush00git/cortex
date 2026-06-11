// search_docs tool - lets the AI client perform semantic search over stored github issues/pulls
// in the qdrant db. requires documents to be pre-seeded in qdrant before replying to the query.
// run `npx tsx src/main.ts ingest <owner> <repo>` to ingest the documents first.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createQueryEngine } from "../../rag/query.js";

export function registerSearchDocs(server: McpServer) {
  server.registerTool(
    "search_docs",
    {
      title: "Search GitHub docs",
      description:
        "Semantic search over ingested GitHub issues and PRs. Returns an answer grounded in the repo's issues and pull requests, with the source issue/PR numbers cited.",
      inputSchema: z.object({
        question: z
          .string()
          .describe("The question to be answered using the ingested GitHub issues and PRs"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      const queryEngine = await createQueryEngine();
      const response = await queryEngine.query({ query: question });

      const answer = String(response.message.content);

      // Collect unique sources from the retrieved chunks. Dedupe by file_name
      // and include created_at / updated_at so the AI can reason about recency
      // when the question asks about "latest" or "recent" activity.
      const sources = response.sourceNodes ?? [];
      const seen = new Map<string, { created_at?: string; updated_at?: string }>();
      for (const s of sources) {
        const meta = s.node.metadata as Record<string, unknown>;
        const name = (meta.file_name as string) ?? "unknown";
        if (!seen.has(name)) {
          seen.set(name, {
            created_at: meta.created_at as string | undefined,
            updated_at: meta.updated_at as string | undefined,
          });
        }
      }

      const sourceLines = [...seen.entries()].map(([name, { created_at, updated_at }]) => {
        const parts = [`- ${name}`];
        if (created_at) parts.push(`created: ${created_at}`);
        if (updated_at) parts.push(`updated: ${updated_at}`);
        return parts.join(" | ");
      });

      const text =
        answer +
        (sourceLines.length > 0
          ? "\n\nSources:\n" + sourceLines.join("\n")
          : "");

      return {
        content: [{ type: "text", text }],
      };
    },
  );
}
