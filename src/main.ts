// main.ts
//
// The single entry point for the whole RAG app. Instead of remembering which
// file to run, you run this with a "mode" argument:
//
//   npx tsx src/main.ts ingest   -> read ./documents/, embed, store in Qdrant
//   npx tsx src/main.ts chat     -> open the interactive question/answer loop
//
// It does two jobs before dispatching: load .env and confirm the API key is
// present, so the user gets one clear message instead of a deep library crash.

import "dotenv/config";

// We import the pipelines (not run them on import — both files only auto-run
// when executed directly, thanks to their "is this the main module?" guard).
import { ingest } from "./rag/ingest.js";
import { chat } from "./rag/chat.js";

async function main(): Promise<void> {
  // Fail early with a friendly message if the key is missing. (initSettings()
  // also checks this, but catching it here lets us print usage-style help.)
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "GEMINI_API_KEY is not set. Add it to your .env file before running.",
    );
    process.exit(1);
  }

  // The mode is the first argument after the script name.
  const mode = process.argv[2];

  switch (mode) {
    case "ingest":
      await ingest();
      break;
    case "chat":
      await chat();
      break;
    default:
      // No mode, or an unknown one: show how to use the tool and exit non-zero.
      console.error(
        "Usage:\n" +
          "  npx tsx src/main.ts ingest   (load documents into Qdrant)\n" +
          "  npx tsx src/main.ts chat     (ask questions interactively)",
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("[main] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
