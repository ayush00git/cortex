// ingest.ts
//
// The "write" half of RAG: read ./documents/, turn the text into vectors, and
// store them in Qdrant. Run once up front (and again whenever docs change).
// After this, query.ts / chat.ts answer questions without re-reading the files.
//
// Run with:  npx tsx src/rag/ingest.ts

// Side-effect import: parses .env into process.env. Must be first so the key is
// available before initSettings() reads it.
import "dotenv/config";

// Reads a folder into Document objects (text + metadata like file_name).
import { SimpleDirectoryReader } from "@llamaindex/readers/directory";
// DocStoreStrategy controls what happens when we ingest a document we've seen
// before. UPSERTS_AND_DELETE = skip unchanged docs, re-embed changed ones, and
// delete the vectors of docs that were removed from ./documents/.
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
  DOCUMENTS_DIR,
  STORAGE_DIR,
} from "./settings.js";

export async function ingest(): Promise<void> {
  // Sets Settings.embedModel + Settings.llm to Gemini; without it the embed
  // step below would try to call OpenAI.
  initSettings();

  console.log(`[ingest] Reading documents from "${DOCUMENTS_DIR}" ...`);
  const reader = new SimpleDirectoryReader();
  const documents = await reader.loadData(DOCUMENTS_DIR);

  if (documents.length === 0) {
    throw new Error(
      `No documents found in "${DOCUMENTS_DIR}". Add some .txt or .md files and try again.`,
    );
  }
  console.log(`[ingest] Loaded ${documents.length} document(s).`);

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
  // (chunk + vector + metadata) row in Qdrant. logProgress prints a counter.
  //
  // docStoreStrategy makes this idempotent: documents whose hash already exists
  // in the docstore are skipped (not re-embedded), changed documents are
  // re-embedded with their old vectors deleted first, and documents removed
  // from disk have their vectors deleted. So running ingest twice no longer
  // duplicates data. NOTE: granularity is per-document - any change to a
  // document re-embeds all of its chunks, not just the edited lines.
  console.log("[ingest] Chunking, embedding with Gemini, and storing in Qdrant ...");
  await VectorStoreIndex.fromDocuments(documents, {
    storageContext,
    logProgress: true,
    docStoreStrategy: DocStoreStrategy.UPSERTS_AND_DELETE,
  });

  console.log(
    `[ingest] Done. Your documents are now searchable in the "${COLLECTION_NAME}" collection.`,
  );
}

// Run ingest() only when executed directly (npx tsx ingest.ts), not when
// imported by main.ts. This is the Node/ESM "is this the main module?" check.
import { fileURLToPath } from "node:url";

const isRunDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunDirectly) {
  ingest().catch((error) => {
    console.error("[ingest] Failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
