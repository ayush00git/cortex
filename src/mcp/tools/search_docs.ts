import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createQueryEngine } from "../../rag/query.js";

export function registerSearchDocs(server: McpServer) {
  server.registerTool(
    "search_docs",
    {
      title: "Search GitHub docs",
      description: "Semantic search over ingested GitHub issues and PRs. Returns an answer grounded in the repo's issues and pull requests, with the source issue/PR numbers cited.",
      inputSchema: z.object({
        question: z.string().describe("The question to be answered using the ingested GitHub issues and PRs"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      const queryEngine = await createQueryEngine();
      const response = await queryEngine.query({ query: question });

      const answer = String(response.message.content);

      // Collect unique source file_names from the retrieved chunks so the
      // caller knows which issues/PRs the answer was grounded in.
      const sources = response.sourceNodes ?? [];
      const sourceNames = [
        ...new Set(sources.map((s) => s.node.metadata.file_name ?? "unknown")),
      ];

      const text =
        answer +
        (sourceNames.length > 0
          ? "\n\nSources:\n" + sourceNames.map((n) => `- ${n}`).join("\n")
          : "");

      return {
        content: [{ type: "text", text }],
      };
    },
  );
}
