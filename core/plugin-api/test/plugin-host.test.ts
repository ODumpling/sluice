import { describe, expect, it } from 'vitest';
import {
  PLUGIN_API_VERSION,
  PluginHost,
  PluginLoadError,
  createServiceRegistry,
  definePlugin,
  isApiCompatible,
  pluginFromModule,
} from '@sluice-dev/plugin-api';

const base = { version: '1.0.0', apiVersion: '^1.0.0' };

describe('isApiCompatible', () => {
  it('accepts caret ranges within the same major', () => {
    expect(isApiCompatible('^1.0.0', '1.0.0')).toBe(true);
    expect(isApiCompatible('^1.0.0', '1.4.2')).toBe(true);
    expect(isApiCompatible('^1.2.0', '1.1.9')).toBe(false);
    expect(isApiCompatible('^1.0.0', '2.0.0')).toBe(false);
  });
  it('accepts major-only and exact forms', () => {
    expect(isApiCompatible('1', '1.9.0')).toBe(true);
    expect(isApiCompatible('1.x', '1.9.0')).toBe(true);
    expect(isApiCompatible('2', '1.9.0')).toBe(false);
    expect(isApiCompatible('1.0.0', '1.0.0')).toBe(true);
    expect(isApiCompatible('1.0.1', '1.0.0')).toBe(false);
  });
  it('rejects garbage', () => {
    expect(isApiCompatible('latest', '1.0.0')).toBe(false);
  });
  it('current host version is compatible with ^1.0.0', () => {
    expect(isApiCompatible('^1.0.0', PLUGIN_API_VERSION)).toBe(true);
  });
});

describe('PluginHost', () => {
  it('registers commands and tools', () => {
    const host = new PluginHost();
    host.register(
      definePlugin({
        ...base,
        name: 'demo',
        commands: [{ path: ['demo', 'run'], summary: 'x', run: () => 0 }],
        tools: [{ name: 'sluice_demo', description: 'd', inputSchema: {}, run: () => ({ content: 1 }) }],
      }),
    );
    expect(host.findCommand(['demo', 'run'])?.plugin).toBe('demo');
    expect(host.findTool('sluice_demo')?.plugin).toBe('demo');
    expect(host.list().map((p) => p.name)).toEqual(['demo']);
  });

  it('rejects incompatible API versions', () => {
    const host = new PluginHost({ hostVersion: '1.0.0' });
    expect(() => host.register({ ...base, name: 'future', apiVersion: '^2.0.0' })).toThrow(PluginLoadError);
  });

  it('rejects duplicate plugins, command conflicts and tool conflicts atomically', () => {
    const host = new PluginHost();
    host.register({ ...base, name: 'a', commands: [{ path: ['x'], summary: '', run: () => 0 }] });
    expect(() => host.register({ ...base, name: 'a' })).toThrow(/registered twice/);
    expect(() =>
      host.register({
        ...base,
        name: 'b',
        tools: [{ name: 'sluice_b', description: '', inputSchema: {}, run: () => ({ content: null }) }],
        commands: [{ path: ['x'], summary: '', run: () => 0 }],
      }),
    ).toThrow(/conflicts with a/);
    // atomic: b's tool must not have been registered
    expect(host.findTool('sluice_b')).toBeUndefined();
    expect(host.get('b')).toBeUndefined();
  });

  it('validates names and paths', () => {
    const host = new PluginHost();
    expect(() => host.register({ ...base, name: 'Bad Name' })).toThrow(/invalid plugin name/);
    expect(() => host.register({ ...base, name: 'p', version: 'one' })).toThrow(/invalid version/);
    expect(() =>
      host.register({ ...base, name: 'p', commands: [{ path: ['Gate'], summary: '', run: () => 0 }] }),
    ).toThrow(/invalid command path/);
    expect(() =>
      host.register({
        ...base,
        name: 'p',
        tools: [{ name: 'Bad-Tool', description: '', inputSchema: {}, run: () => ({ content: 0 }) }],
      }),
    ).toThrow(/invalid tool name/);
  });

  it('activates plugins in registration order', async () => {
    const order: string[] = [];
    const host = new PluginHost();
    for (const n of ['one', 'two']) host.register({ ...base, name: n, activate: () => void order.push(n) });
    await host.activateAll(() => ({}) as never);
    expect(order).toEqual(['one', 'two']);
  });
});

describe('services & module loading', () => {
  it('service registry provides, gets and requires', () => {
    const s = createServiceRegistry();
    s.provide('inbox', { n: 1 });
    expect(s.get<{ n: number }>('inbox')?.n).toBe(1);
    expect(() => s.provide('inbox', {})).toThrow();
    expect(() => s.require('missing')).toThrow(/not provided/);
  });
  it('pluginFromModule accepts default or named export', () => {
    const p = { ...base, name: 'm' };
    expect(pluginFromModule({ default: p }, 'x')).toBe(p);
    expect(pluginFromModule({ plugin: p }, 'x')).toBe(p);
    expect(() => pluginFromModule({}, 'x')).toThrow(PluginLoadError);
  });
});
