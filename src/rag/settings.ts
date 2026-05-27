// settings.ts
//
// LlamaIndex defaults to OpenAI for everything. We use Gemini instead, so we
// override two global settings before doing anything else:
//   - Settings.embedModel : turns text into a vector (a list of numbers that
//                           captures meaning) so similar text can be found.
//   - Settings.llm        : reads the retrieved text and writes the answer.

import { Settings } from "llamaindex";
import {
  Gemini,
  GeminiEmbedding,
  GEMINI_MODEL,
  GEMINI_EMBEDDING_MODEL,
} from "@llamaindex/google";

// Defined once and imported everywhere, so ingest and query can never point at
// different Qdrant collections. A Qdrant "collection" is like a table: a named
// bucket whose rows are (chunk text + vector + metadata).
export const COLLECTION_NAME = "seam-ai";
export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
export const DOCUMENTS_DIR = "./documents";

// Call once at the start of an entry point, AFTER .env is loaded.
export function initSettings(): void {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to your .env file and make sure your " +
        "entry point imports 'dotenv/config' at the top.",
    );
  }

  // The installed @llamaindex/google enum predates "gemini-embedding-001", but
  // the string is passed straight to the Gemini API and works at runtime; the
  // cast only satisfies TypeScript. Small embedBatchSize stays gentle on the
  // free-tier rate limit (the library also auto-retries HTTP 429s).
  Settings.embedModel = new GeminiEmbedding({
    apiKey,
    model: "gemini-embedding-001" as GEMINI_EMBEDDING_MODEL,
    embedBatchSize: 10,
  });

  // Low temperature keeps answers focused and factual rather than creative.
  Settings.llm = new Gemini({
    apiKey,
    model: GEMINI_MODEL.GEMINI_2_5_FLASH_LITE,
    temperature: 0.1,
  });

  console.log("[settings] Gemini configured as embed model + LLM.");
}
