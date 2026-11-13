import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateStore } from '@sluice-dev/plugin-gate';
import { createWebUi } from '@sluice-dev/web';

describe('web UI', () => {
  it('lists tickets, approves scenarios (same-origin only) and serves reports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sluice-web-'));
    const st = new GateStore(root);
    st.writeTicket({ id: 'T-1', title: 'Ticket one', spec: 'do <b>it</b>' });
    st.propose('T-1', [
      {
        id: 'health',
        title: 'health ok',
        steps: [{ http: { method: 'GET', path: '/health' }, expect: { status: 200 } }],
      },
    ]);
    mkdirSync(join(root, '.sluice', 'reports'), { recursive: true });
    writeFileSync(join(root, '.sluice', 'reports', 'gate-T-1-abc.html'), '<p>report</p>');
    const { url, close } = await createWebUi({ projectRoot: root }).listen();
    try {
      const home = await (await fetch(url)).text();
      expect(home).toContain('0/1 scenarios approved');
      expect(home).toContain('gate-T-1-abc.html');
      const t = await (await fetch(`${url}/tickets/T-1`)).text();
      expect(t).toContain('do &lt;b&gt;it&lt;/b&gt;'); // escaped
      expect(t).toContain('unapproved');
      const body = 'scenario=health&approver=po%40acme.test';
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      expect(
        (
          await fetch(`${url}/tickets/T-1/approve`, {
            method: 'POST',
            body,
            headers: { ...headers, origin: 'http://evil.test' },
          })
        ).status,
      ).toBe(403);
      const ok = await fetch(`${url}/tickets/T-1/approve`, {
        method: 'POST',
        body,
        headers: { ...headers, origin: url },
      });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('po@acme.test approved health');
      expect(st.state('T-1')[0]!.status).toBe('approved');
      expect(await (await fetch(`${url}/reports/gate-T-1-abc.html`)).text()).toBe('<p>report</p>');
      expect((await fetch(`${url}/reports/..%2F..%2Fsecret.html`)).status).toBe(404);
    } finally {
      await close();
    }
  });
});
