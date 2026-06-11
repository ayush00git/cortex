// list_sources tool — lets an AI client see all repos and documents currently
// stored in Qdrant, grouped by repo, before deciding whether to call
// ingest_docs or go straight to search_docs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { COLLECTION_NAME, QDRANT_URL } from "../../rag/settings.js";

export function registerListSources(server: McpServer) {
  server.registerTool(
    "list_sources",
    {
      title: "List ingested sources",
      description:
        "Returns all repos and document sources currently stored in Qdrant. Use this to check whether a repo has already been ingested before calling ingest_docs, or to show the user what's searchable.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const client = new QdrantClient({ url: QDRANT_URL });

      // Scroll through every point collecting file_name from the payload.
      // We only need the payload (no vectors) and paginate in batches of 100
      // until Qdrant signals there are no more pages (next_page_offset is null).
      const fileNames = new Set<string>();
      let offset: string | number | null = null;

      do {
        const result = await client.scroll(COLLECTION_NAME, {
          limit: 100,
          with_payload: ["file_name"],
          with_vector: false,
          ...(offset !== null ? { offset } : {}),
        });

        for (const point of result.points) {
          const name = (point.payload as Record<string, unknown>)?.file_name;
          if (typeof name === "string") fileNames.add(name);
        }

        const next = result.next_page_offset;
        offset = typeof next === "string" || typeof next === "number" ? next : null;
      } while (offset !== null);

      if (fileNames.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No sources found in Qdrant. Run ingest_docs to ingest a GitHub repo first.",
            },
          ],
        };
      }

      // Group by "owner/repo" prefix so the output is easy to scan.
      const grouped = new Map<string, string[]>();
      for (const name of [...fileNames].sort()) {
        // file_name format: "owner/repo/issues/N" or "owner/repo/pull/N"
        const parts = name.split("/");
        const repoKey = parts.slice(0, 2).join("/");
        if (!grouped.has(repoKey)) grouped.set(repoKey, []);
        grouped.get(repoKey)!.push(name);
      }

      const lines: string[] = [`${fileNames.size} source(s) across ${grouped.size} repo(s):\n`];
      for (const [repo, sources] of grouped) {
        lines.push(`${repo} (${sources.length})`);
        for (const s of sources) lines.push(`  - ${s}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );
}
