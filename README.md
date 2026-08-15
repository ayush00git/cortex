# seam-ai

A small RAG (Retrieval-Augmented Generation) pipeline built with **LlamaIndex TypeScript**, **Qdrant** as the vector store, and **Google Gemini** for both embeddings and answer generation.

You ingest local documents once, then ask questions against them from the CLI or an interactive chat.

## Prerequisites

- Node.js (run via `tsx`, already a dev dependency)
- Qdrant running locally (Docker, port 6333)
- A Gemini API key

```bash
# Qdrant with a persistent volume (see "Gotchas" for why the volume matters)
docker run -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` in the project root:

   ```
   GEMINI_API_KEY="your_key_here"
   QDRANT_URL="http://localhost:6333"
   ```

3. Put the documents you want to search in `./documents/` (`.txt` / `.md`).

## Usage

```bash
# 1. Load documents into Qdrant (run once, and again when documents change)
npx tsx src/main.ts ingest

# 2. Ask questions interactively (type "exit" to quit)
npx tsx src/main.ts chat

# Single one-off question (no chat loop)
npx tsx src/rag/query.ts "your question here"
```

## How it works

```
documents/ ──▶ ingest ──▶ [chunk ▶ embed (Gemini) ▶ store] ──▶ Qdrant ("seam-ai")
                                                                   │
question ──▶ embed (Gemini) ──▶ search Qdrant ──▶ Gemini writes answer ──▶ you
```

| File | Responsibility |
| --- | --- |
| `src/rag/settings.ts` | Configure Gemini + shared constants (collection name, URLs) |
| `src/rag/ingest.ts` | Read documents, chunk, embed, store in Qdrant (idempotent) |
| `src/rag/query.ts` | Connect to the existing collection and answer one question |
| `src/rag/chat.ts` | Interactive question/answer loop, reuses `query.ts` |
| `src/main.ts` | Entry point: dispatches `ingest` or `chat` |

## Key design points

### Gemini instead of OpenAI

LlamaIndex reads its models from a global `Settings` object that defaults to OpenAI. `initSettings()` overrides two fields so the whole framework uses Gemini:

- `Settings.embedModel` → `GeminiEmbedding` (`gemini-embedding-001`) — turns text into vectors.
- `Settings.llm` → `Gemini` (`gemini-2.5-flash-lite`) — generates the answers.

Setting these once means every downstream call (ingest and query) uses Gemini automatically.

### Qdrant collection

All vectors live in one collection, `seam-ai` (`gemini-embedding-001` produces 3072-dim vectors, cosine distance). A collection is like a database table; the store auto-creates it on first insert. Both ingest and query import the collection name from `settings.ts`, so they can never drift apart.

### Idempotent ingestion (`DocStoreStrategy`)

`ingest.ts` uses `VectorStoreIndex.fromDocuments(...)` with `docStoreStrategy: DocStoreStrategy.UPSERTS_AND_DELETE` and a docstore persisted to `./storage`.

- The docstore records a hash per document and is reloaded on each run.
- Re-running `ingest` skips unchanged documents (no re-embedding), re-embeds changed ones (old vectors deleted first), and removes vectors for documents deleted from disk.
- Result: running `ingest` repeatedly does **not** duplicate data.

Granularity is **per-document**. Because the markdown reader splits each `.md` into roughly per-section documents, you effectively get per-section granularity — but editing one line still re-embeds that whole section.

## Gotchas

- **API key variable name.** `@llamaindex/google` defaults to reading `GOOGLE_API_KEY`; this project uses `GEMINI_API_KEY` and passes it explicitly. Keep the name as `GEMINI_API_KEY`.
- **Qdrant persistence.** Without a mounted volume, Qdrant loses all data when the container restarts and you must re-ingest. Use the `-v` flag shown above.
- **Embedding model must match.** Ingest and query must use the same embedding model (they both go through `settings.ts`), or vector dimensions won't line up.

## Stack

- `llamaindex`, `@llamaindex/google`, `@llamaindex/qdrant`, `@llamaindex/readers`
- `@qdrant/js-client-rest`
- `dotenv`, `tsx`, `typescript`

## Roadmap

- Content-Defined Chunking (CDC) for sub-document incremental updates — design in `cdc.html`.
