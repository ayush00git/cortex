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
import { VectorStoreIndex, storageContextFromDefaults } from "llamaindex";
import { QdrantVectorStore } from "@llamaindex/qdrant";
import {
  initSettings,
  COLLECTION_NAME,
  QDRANT_URL,
  DOCUMENTS_DIR,
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

  // Routes the index's vectors to Qdrant instead of the default in-memory store
  // (which would vanish on exit).
  const storageContext = await storageContextFromDefaults({ vectorStore });

  // fromDocuments does three things: chunk each document into passages, embed
  // each chunk via Gemini (the API calls happen here), and store every
  // (chunk + vector + metadata) row in Qdrant. logProgress prints a counter.
  console.log("[ingest] Chunking, embedding with Gemini, and storing in Qdrant ...");
  await VectorStoreIndex.fromDocuments(documents, {
    storageContext,
    logProgress: true,
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
