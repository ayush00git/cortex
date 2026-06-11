// Internal freshness checker — not exposed as an MCP tool. Called by ask_cortex.

import { QdrantClient } from "@qdrant/js-client-rest";
import { Octokit } from "octokit";
import { COLLECTION_NAME, QDRANT_URL } from "../../rag/settings.js";
import type { SourceMeta } from "./search.js";

function getOctokit(): Octokit {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) throw new Error("GITHUB_ACCESS_TOKEN is not set — add it to .env.");
  return new Octokit({ auth: token });
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export interface FreshnessResult {
  file_name: string;
  currentState: string;
  ingestedAt: string;
  syncedLabel: string;
  hasNewActivity: boolean;
  isOpen: boolean;
}

export async function checkFreshness(source: SourceMeta): Promise<FreshnessResult | null> {
  const qdrant = new QdrantClient({ url: QDRANT_URL });
  const octokit = getOctokit();
  const { owner, repo, number, type, file_name } = source;

  // Pull ingested_at from Qdrant if not already on the source metadata.
  let ingestedAt = source.ingested_at;
  if (!ingestedAt) {
    const result = await qdrant.scroll(COLLECTION_NAME, {
      filter: { must: [{ key: "file_name", match: { value: file_name } }] },
      limit: 1,
      with_payload: ["ingested_at"],
      with_vector: false,
    });
    ingestedAt = (result.points[0]?.payload as Record<string, unknown>)?.ingested_at as string | undefined;
  }

  if (!ingestedAt) return null;

  let currentState: string;
  let currentUpdatedAt: string;

  if (type === "issue") {
    const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
    currentState = data.state;
    currentUpdatedAt = data.updated_at;
  } else {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
    currentState = data.merged_at ? "merged" : data.state;
    currentUpdatedAt = data.updated_at;
  }

  const syncedDaysAgo = daysAgo(ingestedAt);
  return {
    file_name,
    currentState,
    ingestedAt,
    syncedLabel:
      syncedDaysAgo === 0 ? "today" :
      syncedDaysAgo === 1 ? "1 day ago" :
      `${syncedDaysAgo} days ago`,
    hasNewActivity: new Date(currentUpdatedAt) > new Date(ingestedAt),
    isOpen: currentState === "open",
  };
}
