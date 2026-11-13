/**
 * Sluice MCP server. Every plugin tool registered with the host becomes an MCP
 * tool, so any MCP-capable agent (Claude Code, Codex, Cursor, …) can use the
 * gate, inbox, leases, etc. Human-only actions (approving scenarios, answering
 * step-up approvals) are deliberately not exposed as tools.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createCliHost, CLI_VERSION, type HostIO } from '@sluice-dev/cli';

export async function createMcpServer(io: HostIO): Promise<Server> {
  const cli = await createCliHost(io);
  const server = new Server({ name: 'sluice', version: CLI_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: cli.host.tools().map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: { type: 'object', ...spec.inputSchema } as { type: 'object'; [k: string]: unknown },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const found = cli.host.findTool(req.params.name);
    if (!found) return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
    try {
      const ctx = cli.contextFor(cli.host.get(found.plugin)!);
      const result = await found.spec.run((req.params.arguments ?? {}) as Record<string, unknown>, ctx);
      return {
        content: [{ type: 'text', text: JSON.stringify(result.content, null, 2) }],
        structuredContent: (result.content && typeof result.content === 'object' && !Array.isArray(result.content)
          ? result.content
          : { result: result.content }) as Record<string, unknown>,
        isError: result.isError === true,
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true };
    }
  });
  return server;
}

export async function serve(io: HostIO, transport: Transport = new StdioServerTransport()): Promise<Server> {
  const server = await createMcpServer(io);
  await server.connect(transport);
  return server;
}
