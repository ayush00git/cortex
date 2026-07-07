// web/server.ts
//
// Serves the "brain" view — Cortex's ingested corpus rendered as a semantic
// network. Nodes are issues/PRs; edges are cosine similarity between their
// embeddings (the same vectors Qdrant stores for retrieval). This is a
// read-only visualiser: it never writes to Qdrant.
//
// Run with:  npm run web     (then open http://localhost:4545)
//
// No web framework — Node's built-in http server keeps the dependency list
// unchanged. The frontend (index.html) is a single self-contained file with a
// vanilla-canvas force-directed graph, so the whole thing works offline.

import "dotenv/config";

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { COLLECTION_NAME, QDRANT_URL } from "../rag/settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT ?? 4545);

// Tuning for the similarity graph. Each node links to at most NEIGHBORS others,
// keeping only edges at or above SIM_THRESHOLD so the graph shows real semantic
// clusters rather than a hairball. Raise the threshold for a sparser view.
const NEIGHBORS = 4;
const SIM_THRESHOLD = 0.72;
// Cosine similarity over every pair is O(docs² · 3072). Fine for a personal
// corpus; guard against a pathological run and surface it rather than hang.
const MAX_DOCS_FOR_EDGES = 2000;

interface QdrantPoint {
  payload: Record<string, unknown>;
  vector: number[];
}

interface GraphNode {
  id: string;            // file_name — stable doc identity
  type: "issue" | "pr";
  state: string;         // open | closed | merged
  title: string;
  number: number;
  owner: string;
  repo: string;
  author: string;
  url: string;
  createdAt?: string;
  updatedAt?: string;
  activity: number;      // comments + reviews — drives node size
}

interface GraphLink {
  source: string;
  target: string;
  weight: number;        // cosine similarity in [SIM_THRESHOLD, 1]
}

// ---------------------------------------------------------------------------
// Qdrant read
// ---------------------------------------------------------------------------

// Pull every point (payload + vector) via paginated scroll. An optional
// owner/repo filter scopes the brain to a single repo.
async function fetchAllPoints(
  owner?: string,
  repo?: string,
): Promise<QdrantPoint[]> {
  const client = new QdrantClient({ url: QDRANT_URL });

  const must: Array<Record<string, unknown>> = [];
  if (owner) must.push({ key: "owner", match: { value: owner } });
  if (repo) must.push({ key: "repo", match: { value: repo } });
  const filter = must.length ? { must } : undefined;

  const points: QdrantPoint[] = [];
  let offset: string | number | undefined | null = undefined;

  do {
    const res = await client.scroll(COLLECTION_NAME, {
      limit: 256,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: true,
      ...(filter ? { filter } : {}),
    });
    for (const p of res.points) {
      const vector = p.vector;
      if (Array.isArray(vector) && typeof vector[0] === "number") {
        points.push({ payload: (p.payload ?? {}) as Record<string, unknown>, vector: vector as number[] });
      }
    }
    offset = res.next_page_offset as string | number | null | undefined;
  } while (offset !== null && offset !== undefined);

  return points;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" ? v : fallback;

// One node per document. A document is chunked into several Qdrant points that
// all share a file_name; we mean-pool their vectors into a single doc-level
// vector so similarity is computed doc-to-doc, not chunk-to-chunk.
function buildNodes(points: QdrantPoint[]): {
  nodes: GraphNode[];
  vectors: Map<string, number[]>;
} {
  const byDoc = new Map<string, { payload: Record<string, unknown>; sum: number[]; count: number }>();

  for (const p of points) {
    const fileName = str(p.payload.file_name);
    if (!fileName) continue;

    let entry = byDoc.get(fileName);
    if (!entry) {
      entry = { payload: p.payload, sum: new Array(p.vector.length).fill(0), count: 0 };
      byDoc.set(fileName, entry);
    }
    for (let i = 0; i < p.vector.length; i++) entry.sum[i] += p.vector[i];
    entry.count += 1;
  }

  const nodes: GraphNode[] = [];
  const vectors = new Map<string, number[]>();

  for (const [fileName, { payload, sum, count }] of byDoc) {
    // Mean-pool then L2-normalise so a dot product equals cosine similarity.
    const mean = sum.map((x) => x / count);
    let norm = 0;
    for (const x of mean) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    vectors.set(fileName, mean.map((x) => x / norm));

    const type: "issue" | "pr" = str(payload.source) === "github_pr" ? "pr" : "issue";
    const activity =
      num(payload.comment_count) +
      num(payload.review_count) +
      num(payload.review_comment_count);

    nodes.push({
      id: fileName,
      type,
      state: str(payload.state, "unknown"),
      title: str(payload.title, fileName),
      number: num(payload.number),
      owner: str(payload.owner),
      repo: str(payload.repo),
      author: str(payload.author, "unknown"),
      url: str(payload.url),
      createdAt: str(payload.created_at) || undefined,
      updatedAt: str(payload.updated_at) || undefined,
      activity,
    });
  }

  return { nodes, vectors };
}

// Connect each node to its most similar neighbours. Edges are undirected and
// de-duplicated; a pair survives only if it clears SIM_THRESHOLD, which is what
// turns the cloud into visible clusters.
function buildLinks(nodes: GraphNode[], vectors: Map<string, number[]>): GraphLink[] {
  const ids = nodes.map((n) => n.id);
  if (ids.length > MAX_DOCS_FOR_EDGES) {
    console.warn(
      `[web] ${ids.length} docs exceeds MAX_DOCS_FOR_EDGES (${MAX_DOCS_FOR_EDGES}); ` +
        `skipping similarity edges to stay responsive.`,
    );
    return [];
  }

  const seen = new Set<string>();
  const links: GraphLink[] = [];

  for (let i = 0; i < ids.length; i++) {
    const vi = vectors.get(ids[i])!;
    // Score every other doc, keep the top NEIGHBORS above threshold.
    const scored: Array<{ id: string; sim: number }> = [];
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const vj = vectors.get(ids[j])!;
      let dot = 0;
      for (let k = 0; k < vi.length; k++) dot += vi[k] * vj[k];
      if (dot >= SIM_THRESHOLD) scored.push({ id: ids[j], sim: dot });
    }
    scored.sort((a, b) => b.sim - a.sim);

    for (const { id, sim } of scored.slice(0, NEIGHBORS)) {
      const key = ids[i] < id ? `${ids[i]}|${id}` : `${id}|${ids[i]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: ids[i], target: id, weight: Number(sim.toFixed(4)) });
    }
  }

  return links;
}

async function buildGraph(owner?: string, repo?: string) {
  const points = await fetchAllPoints(owner, repo);
  const { nodes, vectors } = buildNodes(points);
  const links = buildLinks(nodes, vectors);

  // Repo list powers the frontend filter chips.
  const repos = [...new Set(nodes.map((n) => `${n.owner}/${n.repo}`))].sort();

  return {
    nodes,
    links,
    meta: {
      docs: nodes.length,
      chunks: points.length,
      links: links.length,
      repos,
      collection: COLLECTION_NAME,
      simThreshold: SIM_THRESHOLD,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Read on each request so edits show up without a restart.
      const html = readFileSync(join(HERE, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url.pathname === "/api/graph") {
      const owner = url.searchParams.get("owner") ?? undefined;
      const repo = url.searchParams.get("repo") ?? undefined;
      const graph = await buildGraph(owner, repo);
      sendJSON(res, 200, graph);
      return;
    }

    if (url.pathname === "/api/health") {
      sendJSON(res, 200, { ok: true });
      return;
    }

    sendJSON(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[web] request failed:", message);
    sendJSON(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`[web] Cortex brain view running at http://localhost:${PORT}`);
  console.log(`[web] Reading collection "${COLLECTION_NAME}" from ${QDRANT_URL}`);
});
