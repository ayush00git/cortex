import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAskCortex } from "./tools/ask_cortex.js";
import { registerIngestDocs } from "./tools/ingest_docs.js";
import { registerListSources } from "./tools/list_sources.js";
import { registerDeleteDocs } from "./tools/delete_docs.js";

const server = new McpServer({ name: 'cortex', version: '1.0.0' });

// Public tools — search_docs and check_freshness are internal to ask_cortex.
registerAskCortex(server);
registerIngestDocs(server);
registerListSources(server);
registerDeleteDocs(server);

// stdio transport mechanism is used
const transport = new StdioServerTransport();
await server.connect(transport);
