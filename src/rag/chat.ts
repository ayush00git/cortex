// chat.ts
//
// An interactive version of query.ts: instead of answering one question and
// exiting, it keeps a prompt open and answers question after question until
// you type "exit". The query engine is built ONCE before the loop, so every
// question reuses the same Qdrant connection instead of reconnecting.
//
// Run with:  npx tsx src/rag/chat.ts

import "dotenv/config";

// readline/promises is the async flavour of Node's built-in line reader: it
// lets us `await rl.question(...)` instead of nesting callbacks.
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Reuse the exact same engine setup as query.ts (connect to Qdrant, configure
// Gemini, similarityTopK). No duplication: if Step 3(query.ts) changes, chat follows.
import { createQueryEngine } from "./query.js";

async function chat(): Promise<void> {
  console.log("[chat] Connecting to Qdrant and configuring Gemini ...");
  const queryEngine = await createQueryEngine();

  const rl = readline.createInterface({ input, output });
  console.log('\nChat ready. Ask a question, or type "exit" to quit.\n');

  try {
    // Infinite loop; exit on "exit", or on Ctrl+D / piped EOF (which closes
    // stdin and makes rl.question() reject — we treat that as "exit" too).
    while (true) {
      let question: string;
      try {
        question = (await rl.question("You: ")).trim();
      } catch {
        console.log("\nGoodbye.");
        break;
      }

      if (question.toLowerCase() === "exit") {
        console.log("Goodbye.");
        break;
      }

      // Ignore empty input (user just pressed Enter) without burning an API call.
      if (question === "") continue;

      // Wrap each question so one failure (rate limit, transient network) prints
      // a message and lets the user keep chatting, instead of killing the loop.
      try {
        const response = await queryEngine.query({ query: question });
        console.log(`\nseam-ai: ${response.message.content}`);

        const sources = response.sourceNodes ?? [];
        if (sources.length > 0) {
          const fileNames = new Set(
            sources.map((s) => s.node.metadata.file_name ?? "unknown"),
          );
          console.log(`Sources: ${[...fileNames].join(", ")}`);
        }
        console.log("");
      } catch (error) {
        console.error(
          `\n[chat] Error answering that one: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    }
  } finally {
    // Always close the readline interface so the process can exit cleanly,
    // even if something above threw.
    rl.close();
  }
}

import { fileURLToPath } from "node:url";

const isRunDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunDirectly) {
  chat().catch((error) => {
    console.error("[chat] Failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

// Exported so main.ts (Step 5) can launch chat mode.
export { chat };
