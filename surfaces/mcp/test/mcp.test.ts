import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@sluice-dev/mcp';

async function connect(cwd: string) {
  const server = await createMcpServer({ cwd, env: {}, stdout: { write: () => {} }, stderr: { write: () => {} } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(b);
  return client;
}

describe('MCP server', () => {
  it('lists plugin tools and calls them', async () => {
    const client = await connect(mkdtempSync(join(tmpdir(), 'sluice-mcp-')));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('sluice_hello');
    expect(names).toContain('sluice_gate_propose_scenarios');
    expect(names).not.toContain('sluice_gate_approve'); // humans approve, not agents
    const res = await client.callTool({ name: 'sluice_hello', arguments: { name: 'codex' } });
    expect(res.structuredContent).toEqual({ greeting: expect.stringContaining('Hello, codex!') });
  });

  it('agents can propose scenarios but they arrive unapproved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sluice-mcp-'));
    writeFileSync(join(dir, 'sluice.yaml'), 'version: 1\n');
    const client = await connect(dir);
    const { GateStore } = await import('@sluice-dev/plugin-gate');
    new GateStore(dir).writeTicket({ id: 'T-1', title: 't', spec: 's' });
    const res = await client.callTool({
      name: 'sluice_gate_propose_scenarios',
      arguments: {
        ticket: 'T-1',
        scenarios: [
          {
            id: 'health',
            title: 'health is ok',
            steps: [{ http: { method: 'GET', path: '/health' }, expect: { status: 200 } }],
          },
        ],
      },
    });
    expect(res.isError).toBe(false);
    const status = await client.callTool({ name: 'sluice_gate_status', arguments: { ticket: 'T-1' } });
    expect((status.structuredContent as { scenarios: { status: string }[] }).scenarios[0]!.status).toBe('unapproved');
    const bad = await client.callTool({
      name: 'sluice_gate_propose_scenarios',
      arguments: {
        ticket: 'T-1',
        scenarios: [{ id: 'x', title: 'no checks', steps: [{ http: { method: 'GET', path: '/' } }] }],
      },
    });
    expect(bad.isError).toBe(true);
    await expect(client.callTool({ name: 'nope', arguments: {} })).resolves.toMatchObject({ isError: true });
  });
});
