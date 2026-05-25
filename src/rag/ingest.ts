// ---------------------------------------------------------------------------
// ingest.ts
//
// WHAT THIS FILE DOES (the "write" half of RAG):
//   It reads every document in ./documents/, turns the text into vectors, and
//   stores those vectors in Qdrant. You run this ONCE up front (and again
//   whenever your documents change). After that, query.ts / chat.ts can answer
//   questions without ever re-reading the original files.
//
// THE PIPELINE, STEP BY STEP:
//   1. SimpleDirectoryReader  -> read files from disk into Document objects.
//   2. QdrantVectorStore      -> open a connection to our Qdrant collection.
//   3. VectorStoreIndex.fromDocuments(...) -> chunk + embed + store.
//
// Run it standalone with:  npx tsx src/rag/ingest.ts
// ---------------------------------------------------------------------------

// Load the .env file FIRST, before anything reads process.env. This single
// import has a side effect: it parses .env and populates process.env. It must
// be the very first import so the key is available by the time initSettings()
// runs.
import "dotenv/config";

// SimpleDirectoryReader walks a folder and reads supported files (txt, md, pdf,
// etc.). It converts each file into a "Document": an object holding the file's
// text plus metadata such as file_name and file_path. In other words, it is
// the bridge from "files on disk" to "data LlamaIndex understands".
import { SimpleDirectoryReader } from "@llamaindex/readers/directory";

// VectorStoreIndex is the high-level object that ties documents, embeddings,
// and a vector store together. storageContextFromDefaults bundles up which
// storage backends to use (here: our Qdrant store).
import { VectorStoreIndex, storageContextFromDefaults } from "llamaindex";

// QdrantVectorStore is the adapter that lets LlamaIndex read/write vectors in
// a running Qdrant database.
import { QdrantVectorStore } from "@llamaindex/qdrant";

// Our Gemini configuration + the shared constants from Step 1.
import {
  initSettings,
  COLLECTION_NAME,
  QDRANT_URL,
  DOCUMENTS_DIR,
} from "./settings.js";

// ---------------------------------------------------------------------------
// ingest(): the whole ingestion pipeline as one reusable function.
// We export it so main.ts can call it too (see Step 5).
// ---------------------------------------------------------------------------
export async function ingest(): Promise<void> {
  // Tell LlamaIndex to use Gemini (sets Settings.embedModel + Settings.llm).
  // Without this, the embedding step below would try to call OpenAI.
  initSettings();

  // --- STEP 1: load the documents from disk -------------------------------
  console.log(`[ingest] Reading documents from "${DOCUMENTS_DIR}" ...`);
  const reader = new SimpleDirectoryReader();
  const documents = await reader.loadData(DOCUMENTS_DIR);

  // Guard against the easy mistake of an empty folder. Embedding nothing would
  // create an empty index and confusing "no answer" results later.
  if (documents.length === 0) {
    throw new Error(
      `No documents found in "${DOCUMENTS_DIR}". Add some .txt or .md files and try again.`,
    );
  }
  console.log(`[ingest] Loaded ${documents.length} document(s).`);

  // --- STEP 2: connect to Qdrant ------------------------------------------
  // A "collection" in Qdrant is like a table in PostgreSQL: a named container
  // for many rows. Each row here will be one text chunk + its vector + the
  // chunk's metadata. We do NOT need to create the collection by hand: the
  // store auto-creates it on first insert, sized to match our vectors.
  console.log(
    `[ingest] Connecting to Qdrant at ${QDRANT_URL} (collection "${COLLECTION_NAME}") ...`,
  );
  const vectorStore = new QdrantVectorStore({
    url: QDRANT_URL,
    collectionName: COLLECTION_NAME,
  });

  // The storage context tells the index "store your vectors in THIS Qdrant
  // store" (instead of the default in-memory store, which vanishes on exit).
  const storageContext = await storageContextFromDefaults({ vectorStore });

  // --- STEP 3: chunk -> embed -> store ------------------------------------
  // VectorStoreIndex.fromDocuments() does three things under the hood:
  //   a) CHUNK:  split each document into smaller overlapping passages
  //              (chunks), because whole documents are usually too big and
  //              less precise to search over.
  //   b) EMBED:  send each chunk to Gemini's embedding model to get a vector.
  //              (This is the step that makes API calls; it can take a moment
  //              and is where free-tier rate limits would show up. The library
  //              retries automatically on rate-limit errors.)
  //   c) STORE:  write every (chunk text + vector + metadata) into Qdrant.
  //
  // logProgress: true prints a progress indicator so you can see it working.
  console.log("[ingest] Chunking, embedding with Gemini, and storing in Qdrant ...");
  await VectorStoreIndex.fromDocuments(documents, {
    storageContext,
    logProgress: true,
  });

  console.log(
    `[ingest] Done. Your documents are now searchable in the "${COLLECTION_NAME}" collection.`,
  );
}

// ---------------------------------------------------------------------------
// Run ingest() only when this file is executed DIRECTLY (npx tsx ingest.ts),
// not when it is imported by another file (like main.ts). This is the Node/ESM
// way of saying "if this is the main module".
// ---------------------------------------------------------------------------
import { fileURLToPath } from "node:url";

const isRunDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunDirectly) {
  // Top-level try/catch so any failure (bad key, Qdrant down, rate limit)
  // prints a clean message and exits with a non-zero code instead of an
  // unhandled-promise crash.
  ingest().catch((error) => {
    console.error("[ingest] Failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
