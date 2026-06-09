// ingest.ts
//
// The "write" half of RAG: fetch every issue and PR from a GitHub repo, turn
// the text into vectors, and store them in Qdrant. Run once up front (and again
// whenever you want to pick up new issues/PRs). After this, query.ts / chat.ts
// answer questions without hitting GitHub again.

import "dotenv/config";

import {
  VectorStoreIndex,
  storageContextFromDefaults,
  DocStoreStrategy,
} from "llamaindex";
import { QdrantVectorStore } from "@llamaindex/qdrant";
import {
  initSettings,
  COLLECTION_NAME,
  QDRANT_URL,
  STORAGE_DIR,
} from "./settings.js";
import { fetchRepoIssues, fetchRepoPulls } from "../ingest/github.js";

export async function ingest(owner: string, repo: string): Promise<void> {
  // Sets Settings.embedModel + Settings.llm to Gemini; without it the embed
  // step below would try to call OpenAI.
  initSettings();

  // Fetch issues and PRs in parallel — they're independent API calls and
  // parallelising them cuts wall-clock time roughly in half for large repos.
  const [issueDocs, pullDocs] = await Promise.all([
    fetchRepoIssues(owner, repo),
    fetchRepoPulls(owner, repo),
  ]);

  const documents = [...issueDocs, ...pullDocs];

  if (documents.length === 0) {
    throw new Error(
      `No issues or PRs found for ${owner}/${repo}. ` +
        "Check the repo name and that your token has the right permissions.",
    );
  }

  console.log(
    `[ingest] ${documents.length} document(s) total ` +
      `(${issueDocs.length} issues, ${pullDocs.length} PRs).`,
  );

  // The store auto-creates the collection on first insert, sized to our vectors.
  console.log(
    `[ingest] Connecting to Qdrant at ${QDRANT_URL} (collection "${COLLECTION_NAME}") ...`,
  );
  const vectorStore = new QdrantVectorStore({
    url: QDRANT_URL,
    collectionName: COLLECTION_NAME,
  });

  // Routes vectors to Qdrant, and persists the docstore (the per-document hash
  // record) to STORAGE_DIR. The persisted docstore is what makes re-runs
  // incremental: on the next run it is reloaded and used to tell which
  // documents are unchanged.
  const storageContext = await storageContextFromDefaults({
    vectorStore,
    persistDir: STORAGE_DIR,
  });

  // fromDocuments does three things: chunk each document into passages, embed
  // each chunk via Gemini (the API calls happen here), and store every
  // (chunk + vector + metadata) row in Qdrant.
  //
  // docStoreStrategy makes this idempotent: documents whose hash already exists
  // in the docstore are skipped, changed ones are re-embedded with old vectors
  // deleted first, and removed documents have their vectors cleaned up. The
  // stable id_ set on each Document in github.ts is what ties the hash record
  // to the right Qdrant rows across runs.
  console.log("[ingest] Chunking, embedding with Gemini, and storing in Qdrant ...");
  await VectorStoreIndex.fromDocuments(documents, {
    storageContext,
    logProgress: true,
    docStoreStrategy: DocStoreStrategy.UPSERTS_AND_DELETE,
  });

  console.log(
    `[ingest] Done. ${owner}/${repo} is now searchable in the "${COLLECTION_NAME}" collection.`,
  );
}

import { fileURLToPath } from "node:url";

const isRunDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunDirectly) {
  const [owner, repo] = process.argv.slice(2);
  if (!owner || !repo) {
    console.error("Usage: npx tsx src/rag/ingest.ts <owner> <repo>");
    process.exit(1);
  }

  ingest(owner, repo).catch((error) => {
    console.error("[ingest] Failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
