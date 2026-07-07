// Internal search helper — not exposed as an MCP tool. Called by ask_cortex.

import { createQueryEngine, type RepoScope } from "../../rag/query.js";

export interface SourceMeta {
  file_name: string;
  owner: string;
  repo: string;
  number: number;
  type: "issue" | "pr";
  state: string;
  created_at?: string;
  updated_at?: string;
  ingested_at?: string;
}

export interface SearchResult {
  answer: string;
  sources: SourceMeta[];
}

export async function search(question: string, scope?: RepoScope): Promise<SearchResult> {
  // scope restricts retrieval to a single repo; ask_cortex always passes it so
  // an answer is grounded only in the repo the caller asked about.
  const queryEngine = await createQueryEngine(scope);
  const response = await queryEngine.query({ query: question });
  const answer = String(response.message.content);

  const seen = new Map<string, SourceMeta>();
  for (const s of response.sourceNodes ?? []) {
    const m = s.node.metadata as Record<string, unknown>;
    const file_name = m.file_name as string | undefined;
    if (!file_name || seen.has(file_name)) continue;

    const parts = file_name.split("/");
    // file_name: owner/repo/issues/N  or  owner/repo/pull/N
    if (parts.length !== 4) continue;

    seen.set(file_name, {
      file_name,
      owner: parts[0],
      repo: parts[1],
      type: parts[2] === "issues" ? "issue" : "pr",
      number: Number(parts[3]),
      state: (m.state as string) ?? "unknown",
      created_at: m.created_at as string | undefined,
      updated_at: m.updated_at as string | undefined,
      ingested_at: m.ingested_at as string | undefined,
    });
  }

  return { answer, sources: [...seen.values()] };
}
