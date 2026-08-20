import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'

const server = new McpServer({
  name: 'alice-mcp-test-server',
  version: '1.0.0',
})

server.registerTool('echo', {
  description: 'Echo text and report whether the configured test secret reached the MCP child process.',
  inputSchema: {
    text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ text }) => ({
  content: [{
    type: 'text',
    text: `echo:${text};secret:${process.env.MCP_TEST_SECRET === 'mcp-secret-value' ? 'yes' : 'no'}`,
  }],
  structuredContent: {
    echoed: text,
    secretConfigured: process.env.MCP_TEST_SECRET === 'mcp-secret-value',
  },
}))

server.registerTool('mutate', {
  description: 'A fake destructive tool used to verify Alice autonomous policy.',
  inputSchema: {
    value: z.string().optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async ({ value }) => ({
  content: [{ type: 'text', text: `mutated:${value || ''}` }],
}))

await server.connect(new StdioServerTransport())
