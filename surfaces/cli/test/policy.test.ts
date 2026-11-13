import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { AuditLog, CredentialBroker } from '@sluice-dev/policy';

function io(cwd: string): HostIO & { out: () => string } {
  let out = '';
  return { cwd, env: {}, stdout: { write: (t) => void (out += t) }, stderr: { write: () => {} }, out: () => out };
}

describe('sluice policy', () => {
  it('grants, lists and decides step-up approvals, verifies the audit log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sluice-policy-'));
    writeFileSync(join(dir, 'sluice.yaml'), 'version: 1\npolicy:\n  stepUp: ["github:acme/*:merge:write"]\n');
    const g = io(dir);
    expect(
      await runCli(
        [
          'policy',
          'grant',
          '--task',
          'T-1',
          '--agent',
          'codex',
          '--scope',
          'github:acme/app:merge:write',
          '--ttl',
          '600',
          '--json',
        ],
        g,
      ),
    ).toBe(0);
    const { token } = JSON.parse(g.out()) as { token: string };
    // the agent hits a step-up endpoint (via the broker library on the same state)
    const broker = new CredentialBroker({
      db: join(dir, '.sluice/state/broker.db'),
      audit: new AuditLog(join(dir, '.sluice/state/audit.jsonl')),
      upstreams: {},
      stepUp: ['github:acme/*:merge:write'],
    });
    const d = broker.authorize(token, 'github', 'PUT', '/repos/acme/app/pulls/1/merge');
    expect(d).toMatchObject({ allow: false, status: 403 });
    await broker.close();
    const list = io(dir);
    await runCli(['policy', 'approvals'], list);
    expect(list.out()).toContain(`${d.approvalId} [pending] codex (task T-1) wants PUT /repos/acme/app/pulls/1/merge`);
    const ap = io(dir);
    expect(await runCli(['policy', 'approve', d.approvalId!, '--as', 'lead@acme.test'], ap)).toBe(0);
    expect(ap.out()).toContain('approved by lead@acme.test');
    const audit = io(dir);
    expect(await runCli(['policy', 'audit'], audit)).toBe(0);
    expect(audit.out()).toContain('audit log ok');
    expect(
      await runCli(
        ['policy', 'grant', '--task', 'T', '--agent', 'a', '--scope', 'github:acme/app:admin:write'],
        io(dir),
      ),
    ).toBe(1);
  });
});
