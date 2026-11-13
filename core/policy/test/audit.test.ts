import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog, verifyAuditLog } from '@sluice-dev/policy';

describe('audit log', () => {
  const setup = () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sluice-audit-')), 'audit.jsonl');
    const log = new AuditLog(f, () => Date.UTC(2030, 0, 1));
    log.append('grant.issued', { grant: 'g1' });
    log.append('request', { decision: 'deny', path: '/repos/a/b/contents/x' });
    log.append('request', { decision: 'allow' });
    return f;
  };
  it('chains entries and verifies', () => {
    const f = setup();
    expect(verifyAuditLog(f)).toEqual({ ok: true });
    // reopening continues the chain
    new AuditLog(f).append('more');
    expect(verifyAuditLog(f)).toEqual({ ok: true });
  });
  it('detects edits, deletions and reordering', () => {
    const f = setup();
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    writeFileSync(f, lines.map((l, i) => (i === 1 ? l.replace('"deny"', '"allow"') : l)).join('\n') + '\n');
    expect(verifyAuditLog(f)).toMatchObject({ ok: false, brokenAt: 2, reason: expect.stringContaining('edited') });
    writeFileSync(f, [lines[0], lines[2]].join('\n') + '\n');
    expect(verifyAuditLog(f)).toMatchObject({ ok: false, brokenAt: 2 });
    writeFileSync(f, [lines[1], lines[0], lines[2]].join('\n') + '\n');
    expect(verifyAuditLog(f)).toMatchObject({ ok: false, brokenAt: 1 });
    expect(() => new AuditLog(f)).toThrow(/corrupt/);
  });
});
