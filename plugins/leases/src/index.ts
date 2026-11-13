import { dirname } from 'node:path';
import { findConfigFile } from '@sluice-dev/config';
import { definePlugin, type PluginContext } from '@sluice-dev/plugin-api';
import { git } from '@sluice-dev/sandbox';
import { openWorkspace } from '@sluice-dev/work';
import { LeaseManager, analyzeChange, syncLeases, type Notifier } from './leases.js';
import { SymbolIndex } from './symbols.js';

export * from './leases.js';
export * from './symbols.js';

function root(ctx: PluginContext): string {
  const f = findConfigFile(ctx.cwd);
  return f ? dirname(f) : ctx.cwd;
}

async function withLeases<T>(ctx: PluginContext, fn: (m: LeaseManager) => Promise<T>): Promise<T> {
  const ws = await openWorkspace(root(ctx), (ctx.sluiceConfig?.work as { url?: string } | undefined)?.url);
  try {
    return await fn(await LeaseManager.open(ws.db));
  } finally {
    await ws.close();
  }
}

export default definePlugin({
  name: '@sluice-dev/plugin-leases',
  version: '0.2.0',
  apiVersion: '^1.0.0',
  description:
    'Symbol-level leases via a multi-language symbol index (TypeScript language service; Go and C# via tree-sitter); interface-change broadcast',
  commands: [
    {
      path: ['lease', 'symbols'],
      summary: 'List indexed symbols (and with --refs, who references a symbol)',
      options: [{ flags: '--refs <symbol>', description: 'show references/dependents of path#Name' }],
      run({ options }, ctx) {
        const idx = SymbolIndex.build(root(ctx));
        if (typeof options.refs === 'string') {
          for (const r of idx.references(options.refs)) ctx.stdout.write(`${r.file}:${r.line}\n`);
          for (const d of idx.dependents(options.refs)) ctx.stdout.write(`dependent ${d.id}\n`);
        } else
          for (const s of idx.symbols())
            ctx.stdout.write(`${s.id} ${s.kind}${s.exported ? ' exported' : ''} ${s.startLine}-${s.endLine}\n`);
        return 0;
      },
    },
    {
      path: ['lease', 'sync'],
      summary: 'Lease every symbol a branch touches for a task; fails on conflicts; broadcasts interface changes',
      options: [
        { flags: '--agent <name>', description: 'agent', required: true },
        { flags: '--task <id>', description: 'task', required: true },
        { flags: '--base <ref>', description: 'base ref', default: 'main' },
        { flags: '--head <ref>', description: 'head ref', default: 'HEAD' },
        { flags: '--ttl <seconds>', description: 'lease ttl', default: '3600' },
      ],
      run({ options }, ctx) {
        return withLeases(ctx, async (m) => {
          const top = (await git(['rev-parse', '--show-toplevel'], root(ctx))).trim();
          const r = await syncLeases(m, {
            repo: top,
            base: String(options.base),
            head: String(options.head),
            agent: String(options.agent),
            task: String(options.task),
            ttlSec: Number(options.ttl),
            notifier: ctx.services.get<Notifier>('inbox'),
          });
          if (r.conflicts.length) {
            for (const c of r.conflicts)
              ctx.stdout.write(`CONFLICT ${c.symbol} is leased by ${c.heldBy} for ${c.task}\n`);
            return 1;
          }
          ctx.stdout.write(`leased ${r.leases.map((l) => l.symbol).join(', ') || 'nothing'}\n`);
          for (const c of r.analysis.interfaceChanges) ctx.stdout.write(`interface ${c.kind}: ${c.id}\n`);
          for (const n of r.notified) ctx.stdout.write(`notified ${n.toAgent}: ${n.message}\n`);
          return 0;
        });
      },
    },
    {
      path: ['lease', 'check'],
      summary: 'Before merge: does this change touch symbols leased by another agent/task? (exit 1 on conflict)',
      options: [
        { flags: '--agent <name>', description: 'agent that owns the change', required: true },
        { flags: '--task <id>', description: 'task of the change', required: true },
        { flags: '--base <ref>', description: 'base ref', default: 'main' },
        { flags: '--head <ref>', description: 'head ref', default: 'HEAD' },
      ],
      run({ options }, ctx) {
        return withLeases(ctx, async (m) => {
          const top = (await git(['rev-parse', '--show-toplevel'], root(ctx))).trim();
          const a = await analyzeChange(top, String(options.base), String(options.head));
          const conflicts = await m.check(
            String(options.agent),
            String(options.task),
            a.touched.map((s) => s.id),
          );
          for (const c of conflicts) ctx.stdout.write(`CONFLICT ${c.symbol} is leased by ${c.heldBy} for ${c.task}\n`);
          if (!conflicts.length) ctx.stdout.write(`no lease conflicts (${a.touched.length} symbol(s) touched)\n`);
          return conflicts.length ? 1 : 0;
        });
      },
    },
    {
      path: ['lease', 'list'],
      summary: 'List active leases',
      run(_i, ctx) {
        return withLeases(ctx, async (m) => {
          const ls = await m.active();
          for (const l of ls)
            ctx.stdout.write(`${l.symbol} ${l.agent} ${l.task} until ${new Date(l.expiresAt).toISOString()}\n`);
          if (!ls.length) ctx.stdout.write('no active leases\n');
          return 0;
        });
      },
    },
    {
      path: ['lease', 'release'],
      summary: 'Release all leases of an agent for a task (e.g. after merge)',
      options: [
        { flags: '--agent <name>', description: 'agent', required: true },
        { flags: '--task <id>', description: 'task', required: true },
      ],
      run({ options }, ctx) {
        return withLeases(ctx, async (m) => {
          ctx.stdout.write(`released ${await m.release(String(options.agent), String(options.task))} lease(s)\n`);
          return 0;
        });
      },
    },
  ],
  tools: [
    {
      name: 'sluice_lease_sync',
      description:
        'Lease the symbols your branch touches for your task. Returns conflicts with other agents (stop and coordinate) and notifies dependents of interface changes.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task: { type: 'string' },
          base: { type: 'string' },
          head: { type: 'string' },
        },
        required: ['agent', 'task'],
        additionalProperties: false,
      },
      run(input, ctx) {
        return withLeases(ctx, async (m) => {
          const top = (await git(['rev-parse', '--show-toplevel'], root(ctx))).trim();
          const r = await syncLeases(m, {
            repo: top,
            base: String(input.base ?? 'main'),
            head: String(input.head ?? 'HEAD'),
            agent: String(input.agent),
            task: String(input.task),
            notifier: ctx.services.get<Notifier>('inbox'),
          });
          return {
            content: {
              leased: r.leases.map((l) => l.symbol),
              conflicts: r.conflicts,
              interfaceChanges: r.analysis.interfaceChanges,
              notified: r.notified.map((n) => n.toAgent),
            },
            isError: r.conflicts.length > 0,
          };
        });
      },
    },
  ],
});
