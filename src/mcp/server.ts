import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchDocs } from "./tools/search_docs.js";
import { registerIngestDocs } from "./tools/ingest_docs.js";
import { registerListSources } from "./tools/list_sources.js";
import { registerDeleteDocs } from "./tools/delete_docs.js";

const server = new McpServer({ name: 'cortex', version: '1.0.0' });

// register tools with the mcp server
registerSearchDocs(server);
registerIngestDocs(server);
registerListSources(server);
registerDeleteDocs(server);

// stdio transport mechanism is used
const transport = new StdioServerTransport();
await server.connect(transport);
