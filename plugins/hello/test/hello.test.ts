import { describe, expect, it } from 'vitest';
import { PluginHost, createServiceRegistry, type PluginContext, type ToolSpec } from '@sluice-dev/plugin-api';
import hello, { greeting } from '@sluice-dev/plugin-hello';

function ctx(config: Record<string, unknown> = {}): PluginContext & { out: string[] } {
  const out: string[] = [];
  const noop = () => {};
  return {
    out,
    apiVersion: '1.0.0',
    cwd: process.cwd(),
    env: {},
    stdout: { write: (t) => void out.push(t) },
    stderr: { write: noop },
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    config,
    sluiceConfig: undefined,
    services: createServiceRegistry(),
  };
}

describe('hello plugin', () => {
  it('registers with the host', () => {
    const host = new PluginHost();
    host.register(hello);
    expect(host.findCommand(['hello'])).toBeDefined();
    expect(host.findTool('sluice_hello')).toBeDefined();
  });
  it('command greets with args, options and config', async () => {
    const c = ctx({ defaultName: 'agent' });
    const cmd = hello.commands[0]!;
    expect(await cmd.run({ args: [], options: {} }, c)).toBe(0);
    expect(await cmd.run({ args: ['bob'], options: { shout: true } }, c)).toBe(0);
    expect(c.out).toEqual([greeting('agent') + '\n', greeting('bob', true) + '\n']);
  });
  it('tool returns structured content', async () => {
    const tool: ToolSpec = hello.tools[0]!;
    const res = await tool.run({ name: 'codex' }, ctx());
    expect(res).toEqual({ content: { greeting: greeting('codex') } });
  });
});
