// main.ts
//
// Single entry point for the RAG app:
//
//   npx tsx src/main.ts ingest <owner> <repo>   -> fetch GitHub issues + PRs, embed, store in Qdrant
//   npx tsx src/main.ts chat                    -> open the interactive question/answer loop

import "dotenv/config";

import { ingest } from "./rag/ingest.js";
import { chat } from "./rag/chat.js";

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Add it to your .env file before running.");
    process.exit(1);
  }

  const [mode, owner, repo] = process.argv.slice(2);

  switch (mode) {
    case "ingest":
      if (!owner || !repo) {
        console.error("Usage: npx tsx src/main.ts ingest <owner> <repo>");
        process.exit(1);
      }
      await ingest(owner, repo);
      break;
    case "chat":
      await chat();
      break;
    default:
      console.error(
        "Usage:\n" +
          "  npx tsx src/main.ts ingest <owner> <repo>   (fetch GitHub issues + PRs and store in Qdrant)\n" +
          "  npx tsx src/main.ts chat                    (ask questions interactively)",
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("[main] Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
