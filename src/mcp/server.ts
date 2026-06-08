import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'cortex', version: '1.0.0' });

server.registerTool(
    'ping-pong',
    {
        title: "ping-pong",
        description: "ping pong demo tool",
    },
    async () => ({
        content: [{ type: 'text', text: `cc return ping pong` }]
    })
);


const transport = new StdioServerTransport();
await server.connect(transport);
