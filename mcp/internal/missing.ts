// Internal missing-docs detector — not exposed as an MCP tool. Called by ask_cortex.
//
// freshness.ts answers "did GitHub change a doc we already have?" by comparing
// updated_at against ingested_at. It is structurally blind to the opposite gap:
// issues and PRs *created* on GitHub after the last ingestion never made it into
// Qdrant at all, so there is no stored point to compare against and semantic
// search can never surface them. This module closes that gap. We read the newest
// ingested_at for the repo out of Qdrant, ask GitHub for anything created after
// it, and report what the brain is missing so ask_cortex can warn the agent.

import { QdrantClient } from "@qdrant/js-client-rest";
import { Octokit } from "octokit";
import { COLLECTION_NAME, QDRANT_URL } from "../../rag/settings.js";

function getOctokit(): Octokit {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) throw new Error("GITHUB_ACCESS_TOKEN is not set — add it to .env.");
  return new Octokit({ auth: token });
}

export interface MissingDoc {
  file_name: string;
  type: "issue" | "pr";
  number: number;
  title: string;
  created_at: string;
}

export interface MissingDocsResult {
  latestIngestedAt: string;
  missing: MissingDoc[];
}

// Find the most recent ingested_at across every stored chunk for this repo.
// Each issue/PR is chunked into multiple points, all sharing the same
// ingested_at, so we scroll the repo's points (payload-only, no vectors) and
// keep the maximum. Qdrant has no index on ingested_at, so we compute it
// client-side; the repos this serves are small enough that paging through is
// cheap relative to the GitHub round trips that follow.
async function latestIngestedAt(
  qdrant: QdrantClient,
  owner: string,
  repo: string,
): Promise<string | null> {
  let offset: string | number | Record<string, unknown> | null | undefined = undefined;
  let latest: string | null = null;

  do {
    const result = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          { key: "owner", match: { value: owner } },
          { key: "repo", match: { value: repo } },
        ],
      },
      limit: 256,
      offset,
      with_payload: ["ingested_at"],
      with_vector: false,
    });

    for (const point of result.points) {
      const ingestedAt = (point.payload as Record<string, unknown>)?.ingested_at as
        | string
        | undefined;
      if (ingestedAt && (latest === null || ingestedAt > latest)) {
        latest = ingestedAt;
      }
    }

    offset = result.next_page_offset;
  } while (offset !== null && offset !== undefined);

  return latest;
}

// Any GitHub item with created_at strictly after latestIngestedAt cannot be in
// Qdrant: a stored doc's ingested_at is always later than its own created_at,
// and latestIngestedAt is the max of all stored ingested_at values, so anything
// created after it post-dates every ingest run. That makes created_at the sound
// test for "missing" — items that merely changed are left to freshness.ts.
export async function detectMissingDocs(
  owner: string,
  repo: string,
): Promise<MissingDocsResult | null> {
  const qdrant = new QdrantClient({ url: QDRANT_URL });
  const latest = await latestIngestedAt(qdrant, owner, repo);

  // No ingested_at anywhere means nothing has been ingested (or the metadata is
  // missing) — there is no baseline to detect "new since" against, so bail.
  if (!latest) return null;

  const octokit = getOctokit();
  const latestDate = new Date(latest);

  // Issues: `since` filters by updated_at, so it returns both new issues and
  // touched old ones. We narrow to created_at > latest to keep only genuinely
  // new ones, and skip pull_request entries (pulls.list covers those).
  const issueItems = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    since: latest,
    per_page: 100,
  });

  const missing: MissingDoc[] = [];

  for (const issue of issueItems) {
    if (issue.pull_request) continue;
    if (new Date(issue.created_at) <= latestDate) continue;
    missing.push({
      file_name: `${owner}/${repo}/issues/${issue.number}`,
      type: "issue",
      number: issue.number,
      title: issue.title,
      created_at: issue.created_at,
    });
  }

  // PRs: pulls.list has no `since`, but sort=updated desc lets us stop paging
  // once a page falls entirely behind the cutoff (mirrors fetchRepoPulls).
  const prItems = await octokit.paginate(
    octokit.rest.pulls.list,
    { owner, repo, state: "all", sort: "updated", direction: "desc", per_page: 100 },
    (response, done) => {
      const page = response.data.filter((pr) => new Date(pr.updated_at) > latestDate);
      if (page.length < response.data.length) done();
      return page;
    },
  );

  for (const pr of prItems) {
    if (new Date(pr.created_at) <= latestDate) continue;
    missing.push({
      file_name: `${owner}/${repo}/pull/${pr.number}`,
      type: "pr",
      number: pr.number,
      title: pr.title,
      created_at: pr.created_at,
    });
  }

  // Newest first so the most relevant additions lead the warning.
  missing.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return { latestIngestedAt: latest, missing };
}
