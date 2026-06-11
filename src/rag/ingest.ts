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

export async function ingest(owner: string, repo: string, since?: string): Promise<void> {
  // Sets Settings.embedModel + Settings.llm to Gemini; without it the embed
  // step below would try to call OpenAI.
  initSettings();

  // Fetch issues and PRs in parallel — they're independent API calls and
  // parallelising them cuts wall-clock time roughly in half for large repos.
  // When `since` is provided only items updated after that timestamp are fetched,
  // scoping the run to the stale documents identified by check_freshness.
  const [issueDocs, pullDocs] = await Promise.all([
    fetchRepoIssues(owner, repo, since),
    fetchRepoPulls(owner, repo, since),
  ]);

  const documents = [...issueDocs, ...pullDocs];

  if (documents.length === 0) {
    throw new Error(
      since
        ? `No issues or PRs updated since ${since} for ${owner}/${repo}.`
        : `No issues or PRs found for ${owner}/${repo}. ` +
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

  const storageContext = await storageContextFromDefaults({
    vectorStore,
    persistDir: STORAGE_DIR,
  });

  // Full ingest: UPSERTS_AND_DELETE keeps Qdrant in sync with the repo by
  // removing vectors for documents no longer in the batch.
  // Partial re-sync (since provided): UPSERTS only — we're touching a subset
  // of documents so we must not delete the ones we didn't fetch.
  const docStoreStrategy = since
    ? DocStoreStrategy.UPSERTS
    : DocStoreStrategy.UPSERTS_AND_DELETE;

  console.log("[ingest] Chunking, embedding with Gemini, and storing in Qdrant ...");
  await VectorStoreIndex.fromDocuments(documents, {
    storageContext,
    logProgress: true,
    docStoreStrategy,
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
