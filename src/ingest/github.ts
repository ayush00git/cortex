// Two source fetchers for the RAG pipeline — issues and PRs are kept separate
// so callers can run either independently (important for large repos where
// fetching both serially would be slow). Both return Document[] that ingest.ts
// chunks, embeds, and stores in Qdrant.
//
// Granularity: one Document per issue / PR, with all comments and reviews
// concatenated into the text so a retrieved chunk carries full thread context.

import { Octokit } from "octokit";
import { Document } from "llamaindex";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOctokit(): Octokit {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) {
    throw new Error("GITHUB_ACCESS_TOKEN is not set — add it to .env.");
  }
  return new Octokit({ auth: token });
}

function buildIssueText(
  title: string,
  body: string | null,
  comments: Array<{ author: string; body: string }>,
): string {
  const parts = [`# ${title}`, "", body?.trim() || "(no description)"];
  for (const c of comments) {
    parts.push("", "---", `**${c.author} commented:**`, "", c.body.trim());
  }
  return parts.join("\n");
}

function buildPRText(
  title: string,
  body: string | null,
  comments: Array<{ author: string; body: string }>,
  reviewComments: Array<{ author: string; path: string; body: string }>,
  reviews: Array<{ author: string; state: string; body: string }>,
): string {
  const parts = [`# ${title}`, "", body?.trim() || "(no description)"];

  if (comments.length > 0) {
    parts.push("", "## Conversation");
    for (const c of comments) {
      parts.push("", `**${c.author} commented:**`, "", c.body.trim());
    }
  }

  if (reviewComments.length > 0) {
    parts.push("", "## Code review comments");
    for (const rc of reviewComments) {
      parts.push("", `**${rc.author}** on \`${rc.path}\`:`, "", rc.body.trim());
    }
  }

  if (reviews.length > 0) {
    parts.push("", "## Reviews");
    for (const r of reviews) {
      parts.push("", `**${r.author}** [${r.state}]:`, "", r.body.trim() || "(no summary)");
    }
  }

  return parts.join("\n");
}

// Returns the last review state per reviewer, which represents their current
// standing after any re-reviews (e.g. CHANGES_REQUESTED → APPROVED after fixes).
function deriveReviewerSummary(
  rawReviews: Array<{ user?: { login?: string } | null; state: string }>,
): { approvedBy: string[]; changesRequestedBy: string[]; reviewedBy: string[] } {
  const latestByUser = new Map<string, string>();
  for (const r of rawReviews) {
    const login = r.user?.login;
    if (login && r.state !== "PENDING") {
      latestByUser.set(login, r.state);
    }
  }

  const approvedBy: string[] = [];
  const changesRequestedBy: string[] = [];
  const reviewedBy: string[] = [];

  for (const [login, state] of latestByUser) {
    reviewedBy.push(login);
    if (state === "APPROVED") approvedBy.push(login);
    if (state === "CHANGES_REQUESTED") changesRequestedBy.push(login);
  }

  return { approvedBy, changesRequestedBy, reviewedBy };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchRepoIssues(
  owner: string,
  repo: string,
): Promise<Document[]> {
  const octokit = getOctokit();
  console.log(`[github:issues] Fetching issues for ${owner}/${repo} ...`);

  const items = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });

  const documents: Document[] = [];

  for (const issue of items) {
    // issues.listForRepo also returns PRs — skip them, fetchRepoPulls covers those.
    if (issue.pull_request) continue;

    const rawComments = await octokit.paginate(
      octokit.rest.issues.listComments,
      { owner, repo, issue_number: issue.number, per_page: 100 },
    );

    const comments = rawComments.map((c) => ({
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
    }));

    documents.push(
      new Document({
        text: buildIssueText(issue.title, issue.body ?? null, comments),
        // Stable id_ lets DocStoreStrategy skip unchanged issues on re-runs.
        id_: issue.url,
        metadata: {
          source: "github_issue",
          owner,
          repo,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          author: issue.user?.login ?? "unknown",
          url: issue.html_url,
          comment_count: comments.length,
          file_name: `${owner}/${repo}/issues/${issue.number}`,
        },
      }),
    );

    console.log(
      `[github:issues]   #${issue.number} "${issue.title}" (${comments.length} comment(s))`,
    );
  }

  console.log(`[github:issues] Built ${documents.length} issue Document(s).`);
  return documents;
}

export async function fetchRepoPulls(
  owner: string,
  repo: string,
): Promise<Document[]> {
  const octokit = getOctokit();
  console.log(`[github:pulls] Fetching pull requests for ${owner}/${repo} ...`);

  // pulls.list returns only PRs (no issues mixed in), so no filtering needed.
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });

  const documents: Document[] = [];

  for (const pr of prs) {
    // Three layers of discussion on a PR:
    // 1. Conversation thread (same as issue comments)
    const rawComments = await octokit.paginate(
      octokit.rest.issues.listComments,
      { owner, repo, issue_number: pr.number, per_page: 100 },
    );

    // 2. Inline review comments tied to specific diff lines
    const rawReviewComments = await octokit.paginate(
      octokit.rest.pulls.listReviewComments,
      { owner, repo, pull_number: pr.number, per_page: 100 },
    );

    // 3. Formal review submissions (approve / request-changes / comment)
    const rawReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });

    const comments = rawComments.map((c) => ({
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
    }));

    const reviewComments = rawReviewComments.map((rc) => ({
      author: rc.user?.login ?? "unknown",
      path: rc.path,
      body: rc.body,
    }));

    // Exclude PENDING (never submitted) and bare COMMENTED reviews with no body
    // — they add noise without substance.
    const reviews = rawReviews
      .filter((r) => r.state !== "PENDING" && (r.body?.trim() || r.state !== "COMMENTED"))
      .map((r) => ({
        author: r.user?.login ?? "unknown",
        state: r.state,
        body: r.body ?? "",
      }));

    // Structured reviewer metadata: who was asked, who acted, who approved.
    // requested_reviewers on an open PR = still waiting; empty once everyone acts.
    const requestedReviewers = pr.requested_reviewers?.map((u) => u.login) ?? [];
    const { approvedBy, changesRequestedBy, reviewedBy } =
      deriveReviewerSummary(rawReviews);

    // merged_at non-null means the PR landed; the API reports state as "closed"
    // for both merged and abandoned PRs, so we disambiguate here.
    const prState = pr.merged_at ? "merged" : pr.state;

    documents.push(
      new Document({
        text: buildPRText(pr.title, pr.body ?? null, comments, reviewComments, reviews),
        id_: pr.url,
        metadata: {
          source: "github_pr",
          owner,
          repo,
          number: pr.number,
          title: pr.title,
          state: prState,
          author: pr.user?.login ?? "unknown",
          url: pr.html_url,
          base_branch: pr.base.ref,
          head_branch: pr.head.ref,
          draft: pr.draft ?? false,
          // Reviewer fields
          requested_reviewers: requestedReviewers,
          reviewed_by: reviewedBy,
          approved_by: approvedBy,
          changes_requested_by: changesRequestedBy,
          // Counts
          comment_count: comments.length,
          review_comment_count: reviewComments.length,
          review_count: reviews.length,
          file_name: `${owner}/${repo}/pull/${pr.number}`,
        },
      }),
    );

    console.log(
      `[github:pulls]   #${pr.number} "${pr.title}" [${prState}]` +
        ` — approved by: [${approvedBy.join(", ") || "none"}]` +
        ` | requested: [${requestedReviewers.join(", ") || "none"}]`,
    );
  }

  console.log(`[github:pulls] Built ${documents.length} PR Document(s).`);
  return documents;
}

// ---------------------------------------------------------------------------
// Standalone CLI — verify auth and document shape without touching Qdrant
//   npx tsx src/ingest/github.ts <owner> <repo> [issues|pulls|both]
// ---------------------------------------------------------------------------
import "dotenv/config";
import { fileURLToPath } from "node:url";

const isRunDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunDirectly) {
  const [owner, repo, mode = "both"] = process.argv.slice(2);
  if (!owner || !repo) {
    console.error(
      "Usage: npx tsx src/ingest/github.ts <owner> <repo> [issues|pulls|both]",
    );
    process.exit(1);
  }

  (async () => {
    const issueDocs =
      mode === "issues" || mode === "both"
        ? await fetchRepoIssues(owner, repo)
        : [];
    const pullDocs =
      mode === "pulls" || mode === "both"
        ? await fetchRepoPulls(owner, repo)
        : [];

    const all = [...issueDocs, ...pullDocs];
    console.log(
      `\nTotal: ${all.length} document(s) (${issueDocs.length} issues, ${pullDocs.length} PRs).`,
    );
    if (all.length > 0) {
      console.log("\n=== First document preview ===");
      console.log("metadata:", all[0].metadata);
      console.log("text:\n" + all[0].getText().slice(0, 500));
    }
  })().catch((error) => {
    console.error(
      "[github] Failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
