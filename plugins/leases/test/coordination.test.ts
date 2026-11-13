// M6 exit: two simulated agents editing a shared type get a lease conflict before merge.
// Also: interface-change broadcast to a dependent agent, and inbox dedupe + answer propagation.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { SymbolIndex } from '@sluice-dev/plugin-leases';
import { openWorkspace } from '@sluice-dev/work';

const EXAMPLE = join(import.meta.dirname, '..', '..', '..', 'examples', 'coord-demo');

let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();

function io(): HostIO & { out: () => string } {
  let out = '';
  return { cwd: repo, env: {}, stdout: { write: (t) => void (out += t) }, stderr: { write: () => {} }, out: () => out };
}
async function cli(...args: string[]) {
  const t = io();
  const code = await runCli(args, t);
  return { code, out: t.out() };
}

/** A simulated agent: edits files on its own branch and commits. */
function agentEdit(branch: string, edits: Record<string, (s: string) => string>, message: string) {
  git('checkout', '-q', '-B', branch, 'main');
  for (const [f, fn] of Object.entries(edits)) writeFileSync(join(repo, f), fn(readFileSync(join(repo, f), 'utf8')));
  git('commit', '-qam', message);
  git('checkout', '-q', 'main');
}

beforeAll(() => {
  repo = join(mkdtempSync(join(tmpdir(), 'sluice-coord-')), 'coord-demo');
  cpSync(EXAMPLE, repo, { recursive: true });
  writeFileSync(join(repo, '.gitignore'), '.sluice/\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@acme.test');
  git('config', 'user.name', 'dev');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-qm', 'coord-demo');
});

describe('symbol index (TypeScript language service)', () => {
  it('indexes declarations and resolves semantic references', () => {
    const idx = SymbolIndex.build(repo);
    expect(idx.symbols().map((s) => s.id)).toEqual([
      'src/billing.ts#createInvoice',
      'src/billing.ts#totalCents',
      'src/report.ts#renderReport',
      'src/types.ts#Invoice',
      'src/types.ts#InvoiceStatus',
      'src/util.ts#slugify',
    ]);
    expect(idx.dependents('src/types.ts#Invoice').map((s) => s.id)).toEqual([
      'src/billing.ts#createInvoice',
      'src/billing.ts#totalCents',
      'src/report.ts#renderReport',
    ]);
    expect(idx.dependents('src/util.ts#slugify')).toEqual([]);
  });
});

describe('coordination (M6)', () => {
  it('sets up tasks in the shared work queue', async () => {
    for (const [id, title] of [
      ['T-A', 'Add currency to invoices'],
      ['T-B', 'Rename amountCents to total'],
      ['T-C', 'Report shows dollars with symbol'],
    ] as const)
      expect((await cli('work', 'add', title, '--id', id)).code).toBe(0);
    for (const [agent, task] of [
      ['agent-a', 'T-A'],
      ['agent-b', 'T-B'],
      ['agent-c', 'T-C'],
    ] as const) {
      expect((await cli('work', 'claim', '--agent', agent, '--task', task)).code).toBe(0);
      expect((await cli('work', 'start', task, '--agent', agent)).code).toBe(0);
    }
  });

  it('agent C leases the report function it edits', async () => {
    agentEdit(
      'agent-c',
      {
        'src/report.ts': (s) => s.replace('(i.amountCents / 100).toFixed(2)', '`$${(i.amountCents / 100).toFixed(2)}`'),
      },
      'report: dollar sign',
    );
    const r = await cli('lease', 'sync', '--agent', 'agent-c', '--task', 'T-C', '--head', 'agent-c');
    expect(r.code).toBe(0);
    expect(r.out).toContain('leased src/report.ts#renderReport');
  });

  it('agent A changes the shared Invoice type: leased, and dependents are told about the interface change', async () => {
    agentEdit(
      'agent-a',
      { 'src/types.ts': (s) => s.replace('  amountCents: number;\n', '  amountCents: number;\n  currency: string;\n') },
      'types: add currency',
    );
    const r = await cli('lease', 'sync', '--agent', 'agent-a', '--task', 'T-A', '--head', 'agent-a');
    expect(r.code).toBe(0);
    expect(r.out).toContain('leased src/types.ts#Invoice');
    expect(r.out).toContain('interface changed: src/types.ts#Invoice');
    expect(r.out).toContain('notified agent-c');
    const inbox = await cli('inbox', 'list', '--agent', 'agent-c', '--json');
    const notes = (
      JSON.parse(inbox.out) as {
        notifications: { kind: string; data: { symbol: string; dependent: string; after: string } }[];
      }
    ).notifications;
    expect(notes).toEqual([
      expect.objectContaining({
        kind: 'interface_changed',
        data: expect.objectContaining({
          symbol: 'src/types.ts#Invoice',
          dependent: 'src/report.ts#renderReport',
          after: expect.stringContaining('currency:string'),
        }),
      }),
    ]);
  });

  it('agent B editing the same type gets a lease conflict BEFORE merge', async () => {
    agentEdit(
      'agent-b',
      {
        'src/types.ts': (s) => s.replace('amountCents: number', 'total: number'),
        'src/billing.ts': (s) => s.replaceAll('amountCents', 'total'),
      },
      'rename amountCents -> total',
    );
    const sync = await cli('lease', 'sync', '--agent', 'agent-b', '--task', 'T-B', '--head', 'agent-b');
    expect(sync.code).toBe(1);
    expect(sync.out).toContain('CONFLICT src/types.ts#Invoice is leased by agent-a for T-A');
    // the pre-merge check (what CI / the gate runs) refuses the merge too
    const check = await cli(
      'lease',
      'check',
      '--agent',
      'agent-b',
      '--task',
      'T-B',
      '--base',
      'main',
      '--head',
      'agent-b',
    );
    expect(check.code).toBe(1);
    expect(check.out).toContain('CONFLICT src/types.ts#Invoice');
    // conflict is all-or-nothing: B got no partial leases (e.g. on billing.ts)
    expect((await cli('lease', 'list')).out).not.toContain('agent-b');
    // A's own branch has no conflict
    expect((await cli('lease', 'check', '--agent', 'agent-a', '--task', 'T-A', '--head', 'agent-a')).code).toBe(0);
  });

  it('a question two agents both need answered becomes one decision; the answer unblocks both', async () => {
    const q = [
      '--kind',
      'choice',
      '--question',
      'Should the invoice amount field be called total or amountCents?',
      '--option',
      'total',
      '--option',
      'amountCents',
    ];
    const b = await cli('inbox', 'ask', '--agent', 'agent-b', '--task', 'T-B', ...q);
    const c = await cli(
      'inbox',
      'ask',
      '--agent',
      'agent-c',
      '--task',
      'T-C',
      '--kind',
      'choice',
      '--question',
      'should the invoice AMOUNT field be called total, or amountCents',
      '--option',
      'amountCents',
      '--option',
      'total',
    );
    const id = b.out.trim().split(' ')[0]!;
    expect(c.out).toContain(`${id} (deduplicated with an existing request)`);
    const list = await cli('work', 'list', '--status', 'blocked');
    expect(list.out).toContain('T-B [blocked]');
    expect(list.out).toContain('T-C [blocked]');
    expect((await cli('inbox', 'answer', id, 'maybe', '--as', 'lead@acme.test')).code).toBe(1); // typed: must be an option
    const ans = await cli('inbox', 'answer', id, 'amountCents', '--as', 'lead@acme.test');
    expect(ans.out).toContain('resumed: T-B (in_progress), T-C (in_progress)');
    const ws = await openWorkspace(repo);
    expect((await ws.queue.get('T-B')).data.decisions).toEqual({
      [id]: {
        answer: 'amountCents',
        by: 'lead@acme.test',
        question: 'Should the invoice amount field be called total or amountCents?',
      },
    });
    await ws.close();
  });

  it('after A merges and releases, B can re-lease (and C hears about B’s change)', async () => {
    git('merge', '-q', '--no-ff', '-m', 'merge agent-a', 'agent-a');
    expect((await cli('lease', 'release', '--agent', 'agent-a', '--task', 'T-A')).out).toContain('released');
    // B redoes its rename on top of the merged type (a textual rebase would conflict — exactly what the lease prevented)
    agentEdit(
      'agent-b',
      {
        'src/types.ts': (s) => s.replace('amountCents: number', 'total: number'),
        'src/billing.ts': (s) => s.replaceAll('amountCents', 'total'),
      },
      'rename amountCents -> total (on top of currency)',
    );
    const r = await cli('lease', 'sync', '--agent', 'agent-b', '--task', 'T-B', '--head', 'agent-b');
    expect(r.code).toBe(0);
    expect(r.out).toContain('leased');
    expect(r.out).toContain('notified agent-c');
  });
});
