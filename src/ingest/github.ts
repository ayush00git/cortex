// github.ts
//
// A "source" for the RAG pipeline: instead of reading local files, this fetches
// every issue in a GitHub repo - the issue's title + body AND all of its
// comments - and returns them as LlamaIndex Document objects. ingest.ts then
// chunks, embeds, and stores these exactly like it did for local docs.
//
// One Document == one issue (its body + every comment concatenated). Keeping a
// whole issue thread together means a retrieved chunk carries the surrounding
// discussion, not an isolated comment with no context.

import { Octokit } from "octokit";
import { Document } from "llamaindex";

// Builds the text body of one Document: the issue itself followed by its
// comments, each labelled with its author so the LLM can attribute who said
// what. Kept separate from the fetch logic to keep fetchRepoIssues readable.
function buildIssueText(
  title: string,
  body: string | null,
  comments: Array<{ author: string; body: string }>,
): string {
  const parts: string[] = [`# ${title}`, "", body?.trim() || "(no description)"];

  for (const comment of comments) {
    parts.push("", "---", `**${comment.author} commented:**`, "", comment.body.trim());
  }

  return parts.join("\n");
}

// Fetch all issues (open + closed) for owner/repo, each with its comments, as
// Document objects ready to hand to VectorStoreIndex.fromDocuments.
export async function fetchRepoIssues(
  owner: string,
  repo: string,
): Promise<Document[]> {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_ACCESS_TOKEN is not set. Add it to your .env file so we can call " +
        "the GitHub API (and avoid the low unauthenticated rate limit).",
    );
  }

  const octokit = new Octokit({ auth: token });

  console.log(`[github] Fetching issues for ${owner}/${repo} ...`);

  // paginate() walks every page of results for us, so we get ALL issues, not
  // just the first 30. state:"all" includes closed issues - past discussions
  // are often the most useful context for a RAG answer.
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });

  const documents: Document[] = [];

  for (const issue of issues) {
    // GitHub's issues API returns pull requests too (a PR is an issue under the
    // hood). Anything with a `pull_request` field is a PR - skip it; we only
    // want real issues.
    if (issue.pull_request) continue;

    // Fetch every comment on this issue (also paginated, in case a thread is
    // long). listComments returns them in chronological order.
    const rawComments = await octokit.paginate(
      octokit.rest.issues.listComments,
      { owner, repo, issue_number: issue.number, per_page: 100 },
    );

    const comments = rawComments.map((c) => ({
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
    }));

    const text = buildIssueText(issue.title, issue.body ?? null, comments);

    documents.push(
      new Document({
        text,
        // A stable id_ (the issue's API URL) lets DocStoreStrategy in ingest.ts
        // recognise this issue across re-runs: unchanged issues are skipped,
        // edited ones are re-embedded, deleted ones are removed. Without a
        // stable id every run would duplicate the data.
        id_: issue.url,
        metadata: {
          source: "github",
          owner,
          repo,
          issue_number: issue.number,
          title: issue.title,
          state: issue.state,
          author: issue.user?.login ?? "unknown",
          url: issue.html_url,
          comment_count: comments.length,
          // query.ts prints metadata.file_name as the "source" of an answer;
          // setting it to owner/repo#N keeps that display meaningful for issues.
          file_name: `${owner}/${repo}#${issue.number}`,
        },
      }),
    );

    console.log(
      `[github]   #${issue.number} "${issue.title}" (${comments.length} comment(s))`,
    );
  }

  console.log(`[github] Built ${documents.length} issue Document(s).`);
  return documents;
}

// Allow a quick standalone sanity check:
//   npx tsx src/ingest/github.ts <owner> <repo>
// Prints how many issues were fetched and the first document's preview, without
// touching Qdrant. Handy for verifying auth + the API shape before ingesting.
import "dotenv/config";
import { fileURLToPath } from "node:url";

const isRunDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (isRunDirectly) {
  const [owner, repo] = process.argv.slice(2);
  if (!owner || !repo) {
    console.error("Usage: npx tsx src/ingest/github.ts <owner> <repo>");
    process.exit(1);
  }

  fetchRepoIssues(owner, repo)
    .then((docs) => {
      console.log(`\nFetched ${docs.length} issue document(s).`);
      if (docs.length > 0) {
        console.log("\n=== First document preview ===");
        console.log("metadata:", docs[0].metadata);
        console.log("text:\n" + docs[0].getText().slice(0, 500));
      }
    })
    .catch((error) => {
      console.error("[github] Failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
