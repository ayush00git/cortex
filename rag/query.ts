// query.ts
//
// The "read" half of RAG: ask a question and get an answer grounded in the
// documents we ingested. This does NOT re-read ./documents/ or re-embed
// anything; it connects to the vectors already stored in Qdrant by ingest.ts.
//
// How a query engine answers a question, end to end:
//   1. embed the question into a vector (same Gemini model used for ingest)
//   2. search Qdrant for the chunks whose vectors are closest (most similar)
//   3. paste those chunks into a prompt as context
//   4. send that prompt to Gemini, which writes the final answer
//
// Retriever vs query engine: a *retriever* only does steps 1-2 (it finds the
// relevant chunks and stops). A *query engine* wraps a retriever and also does
// steps 3-4, producing an actual written answer.
//
// Run with:  npx tsx src/rag/query.ts "your question here"

import "dotenv/config";

import { VectorStoreIndex } from "llamaindex";
import type { MetadataFilters } from "@llamaindex/core/vector-store";
import { QdrantVectorStore } from "@llamaindex/qdrant";
import { initSettings, COLLECTION_NAME, QDRANT_URL } from "./settings.js";

// Scopes retrieval to a single repo. All repos share one Qdrant collection, so
// without this filter a question about owner/repo can retrieve chunks from a
// *different* repo and blend them into one answer. Callers that legitimately
// want cross-repo search (e.g. the standalone CLI) omit it.
export interface RepoScope {
  owner: string;
  repo: string;
}

// Builds the pre-retrieval metadata filter for a repo scope. owner AND repo
// must both match — the fields are stamped on every Document at ingest time.
function repoFilters({ owner, repo }: RepoScope): MetadataFilters {
  return {
    filters: [
      { key: "owner", value: owner, operator: "==" },
      { key: "repo", value: repo, operator: "==" },
    ],
    condition: "and",
  };
}

// Builds a query engine bound to the existing Qdrant collection. Exported so
// chat.ts (Step 4) can reuse the exact same setup instead of duplicating it.
// Pass a RepoScope to restrict retrieval to one repo; omit it to search across
// every ingested repo.
export async function createQueryEngine(scope?: RepoScope) {
  // Sets Settings.embedModel + Settings.llm to Gemini. The embed model MUST be
  // the same one used during ingest, or the question's vector would have a
  // different size/space than the stored vectors and the search would break.
  initSettings();

  const vectorStore = new QdrantVectorStore({
    url: QDRANT_URL,
    collectionName: COLLECTION_NAME,
  });

  // fromVectorStore connects to vectors that already exist (read-only), unlike
  // fromDocuments which embeds and writes new ones.
  const index = await VectorStoreIndex.fromVectorStore(vectorStore);

  // similarityTopK = how many of the closest chunks to feed the LLM as context.
  // More context can mean better answers but more tokens; 3 is a sensible start.
  // preFilters runs in Qdrant *before* the vector search, so topK is measured
  // against this repo's chunks only rather than the whole collection.
  return index.asQueryEngine({
    similarityTopK: 3,
    ...(scope ? { preFilters: repoFilters(scope) } : {}),
  });
}

export async function query(question: string): Promise<void> {
  const queryEngine = await createQueryEngine();

  console.log(`[query] Question: ${question}`);
  const response = await queryEngine.query({ query: question });

  console.log("\n=== Answer ===");
  console.log(response.message.content);

  // sourceNodes are the actual chunks the retriever pulled from Qdrant. Showing
  // their file names lets you see WHERE the answer came from (and spot when the
  // model is answering from the wrong document).
  const sources = response.sourceNodes ?? [];
  if (sources.length > 0) {
    console.log("\n=== Sources ===");
    // Dedupe: several chunks often come from the same file.
    const fileNames = new Set(
      sources.map((s) => s.node.metadata.file_name ?? "unknown"),
    );
    for (const name of fileNames) {
      console.log(` - ${name}`);
    }
  }
}

import { fileURLToPath } from "node:url";

const isRunDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunDirectly) {
  // The question is everything after "npx tsx src/rag/query.ts".
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('Usage: npx tsx src/rag/query.ts "your question here"');
    process.exit(1);
  }

  query(question).catch((error) => {
    console.error("[query] Failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
