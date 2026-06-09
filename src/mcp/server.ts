import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchDocs } from "./tools/search_docs.js";

const server = new McpServer({ name: 'cortex', version: '1.0.0' });

// register tools with the mcp server
registerSearchDocs(server);

const transport = new StdioServerTransport();
await server.connect(transport);
