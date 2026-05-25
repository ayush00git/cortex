// ---------------------------------------------------------------------------
// settings.ts
//
// WHAT THIS FILE DOES:
//   LlamaIndex has a global "Settings" object that the rest of the framework
//   reads from. By default it expects an OpenAI API key. We are using Google's
//   Gemini instead, so BEFORE we do anything else we must replace two settings:
//
//     1. Settings.embedModel - the "embedding model". It converts a piece of
//        text into a vector: a long list of numbers (e.g. [0.013, -0.21, ...])
//        that represents the *meaning* of that text. Similar meanings produce
//        vectors that are close together. This is what makes semantic search
//        possible. We use it both when storing documents and when searching.
//
//     2. Settings.llm - the "large language model". This is the model that
//        actually reads the relevant text we found and writes a human-readable
//        answer to the user's question.
//
//   WHY WE HAVE TO DO THIS:
//     LlamaIndex defaults to OpenAI for both of the above. If we never set
//     these, the library would try to call OpenAI and fail (no OpenAI key).
//     So configuring Gemini here is a required first step for everything else.
// ---------------------------------------------------------------------------

// "Settings" is the global configuration object provided by the core library.
import { Settings } from "llamaindex";

// Gemini       -> the chat/generation model (writes answers).
// GeminiEmbedding -> the embedding model (text -> vectors).
// GEMINI_MODEL -> an enum of known model names, so we get type-safety + autocomplete.
// GEMINI_EMBEDDING_MODEL -> the enum type for embedding model names.
import {
  Gemini,
  GeminiEmbedding,
  GEMINI_MODEL,
  GEMINI_EMBEDDING_MODEL,
} from "@llamaindex/google";

// ---------------------------------------------------------------------------
// Shared constants.
//
// We define these ONCE here and import them everywhere else. This guarantees
// the ingestion step and the query step always talk to the exact same Qdrant
// collection.
// ---------------------------------------------------------------------------

// A Qdrant "collection" is like a table in PostgreSQL: a named bucket that
// holds many rows. Here each "row" is a chunk of text plus its vector.
export const COLLECTION_NAME = "seam-ai";

// Where Qdrant is listening. We read it from the .env file if present,
// otherwise fall back to the standard local Docker port.
export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";

// The folder our source documents live in.
export const DOCUMENTS_DIR = "./documents";

// ---------------------------------------------------------------------------
// initSettings(): call this once, at the start of any entry point, AFTER the
// .env file has been loaded. It wires Gemini into LlamaIndex's global Settings.
// ---------------------------------------------------------------------------
export function initSettings(): void {
  // Read the key from the environment. Your entry point must load .env (via
  // `import "dotenv/config"`) BEFORE calling this, or this will be undefined.
  const apiKey = process.env.GEMINI_API_KEY;

  // Fail loudly and clearly if the key is missing. A good error message now
  // saves a confusing crash deep inside the library later.
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to your .env file (see .env.example) " +
        "and make sure your entry point imports 'dotenv/config' at the top.",
    );
  }

  // -- Embedding model --------------------------------------------------------
  // NOTE on the model name: the installed @llamaindex/google version ships an
  // older enum that does not yet list "gemini-embedding-001" (Google's current
  // embedding model). The library passes whatever string we give straight to
  // the Gemini API, so the newer model works fine at runtime. We cast the
  // string to the enum type only to satisfy TypeScript.
  //
  // embedBatchSize controls how many text chunks are sent per API call. We keep
  // it modest (10) to stay gentle on the Gemini free-tier rate limits. The
  // library also automatically retries on HTTP 429 ("rate limit") errors.
  Settings.embedModel = new GeminiEmbedding({
    apiKey,
    model: "gemini-embedding-001" as GEMINI_EMBEDDING_MODEL,
    embedBatchSize: 10,
  });

  // -- Generation model (LLM) -------------------------------------------------
  // gemini-2.5-flash-lite is fast and available on the free tier.
  // temperature 0.1 = low randomness, so answers stay focused and factual
  // (good for a question-answering bot that should stick to the documents).
  Settings.llm = new Gemini({
    apiKey,
    model: GEMINI_MODEL.GEMINI_2_5_FLASH_LITE,
    temperature: 0.1,
  });

  console.log("[settings] Gemini configured as embed model + LLM.");
}
