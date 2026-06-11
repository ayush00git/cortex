// check_freshness tool — given a specific issue or PR, checks whether the
// ingested snapshot is stale. Uses the GitHub `since` parameter to detect
// any activity after `ingested_at`, then reports the lag to the AI client
// so it can prompt the user to re-sync if warranted.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Octokit } from "octokit";
import { COLLECTION_NAME, QDRANT_URL } from "../../rag/settings.js";

function getOctokit(): Octokit {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) throw new Error("GITHUB_ACCESS_TOKEN is not set — add it to .env.");
  return new Octokit({ auth: token });
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function registerCheckFreshness(server: McpServer) {
  server.registerTool(
    "check_freshness",
    {
      title: "Check issue/PR freshness",
      description:
        "Checks whether the ingested snapshot of a specific GitHub issue or PR is stale. " +
        "Call this whenever search_docs returns an open issue or PR and the user might be " +
        "acting on it — it tells the user how long ago it was synced and whether GitHub has " +
        "newer activity, then offers to re-sync.",
      inputSchema: z.object({
        owner: z.string().describe("GitHub username or org that owns the repo"),
        repo: z.string().describe("Repository name"),
        number: z.number().int().positive().describe("Issue or PR number"),
        type: z.enum(["issue", "pr"]).describe("Whether this is an issue or a pull request"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ owner, repo, number, type }) => {
      const qdrant = new QdrantClient({ url: QDRANT_URL });
      const octokit = getOctokit();

      // Look up the ingested snapshot from Qdrant by file_name.
      const file_name =
        type === "issue"
          ? `${owner}/${repo}/issues/${number}`
          : `${owner}/${repo}/pull/${number}`;

      const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
        filter: { must: [{ key: "file_name", match: { value: file_name } }] },
        limit: 1,
        with_payload: ["state", "ingested_at", "updated_at"],
        with_vector: false,
      });

      const point = scrollResult.points[0];
      if (!point) {
        return {
          content: [{
            type: "text",
            text: `No ingested snapshot found for ${file_name}. Run ingest_docs first.`,
          }],
        };
      }

      const payload = point.payload as Record<string, unknown>;
      const ingestedAt = payload.ingested_at as string | undefined;
      const storedState = payload.state as string | undefined;

      if (!ingestedAt) {
        return {
          content: [{
            type: "text",
            text: `Snapshot for ${file_name} exists but has no ingested_at timestamp. Re-ingest to fix.`,
          }],
        };
      }

      // Use GitHub's `since` parameter to check for any activity after ingested_at.
      // For issues: issues.listForRepo with since + filter by number.
      // For PRs: pulls don't support `since`, so we fetch the PR directly and
      // compare updated_at ourselves.
      let currentState: string;
      let currentUpdatedAt: string;
      let hasNewActivity: boolean;

      if (type === "issue") {
        const { data: issue } = await octokit.rest.issues.get({
          owner, repo, issue_number: number,
        });
        currentState = issue.state;
        currentUpdatedAt = issue.updated_at;
        hasNewActivity = new Date(issue.updated_at) > new Date(ingestedAt);
      } else {
        const { data: pr } = await octokit.rest.pulls.get({
          owner, repo, pull_number: number,
        });
        currentState = pr.merged_at ? "merged" : pr.state;
        currentUpdatedAt = pr.updated_at;
        hasNewActivity = new Date(pr.updated_at) > new Date(ingestedAt);
      }

      const syncedDaysAgo = daysAgo(ingestedAt);
      const syncedLabel =
        syncedDaysAgo === 0 ? "today" :
        syncedDaysAgo === 1 ? "1 day ago" :
        `${syncedDaysAgo} days ago`;

      const isOpen = currentState === "open";

      // Build the response message.
      const lines: string[] = [
        `**${file_name}**`,
        `- Current state: \`${currentState}\``,
        `- Last synced: ${syncedLabel} (${ingestedAt})`,
        `- GitHub last updated: ${currentUpdatedAt}`,
        `- New activity since last sync: ${hasNewActivity ? "yes" : "no"}`,
      ];

      if (isOpen && hasNewActivity) {
        lines.push(
          "",
          `This ${type} is still **open** and has new activity since it was last synced ${syncedLabel}. ` +
          `Would you like to re-sync \`${owner}/${repo}\` to get the latest updates?`,
        );
      } else if (isOpen && !hasNewActivity) {
        lines.push(
          "",
          `This ${type} is still **open** but has no new activity since it was synced ${syncedLabel}. The snapshot is up to date.`,
        );
      } else {
        lines.push(
          "",
          `This ${type} is **${currentState}** — no re-sync needed unless you want to refresh the full repo.`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );
}
