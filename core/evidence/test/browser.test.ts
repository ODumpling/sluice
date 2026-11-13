// Browser steps without a browser: script validation, the browser diff channel,
// the timeline page, and the client/server Playwright version pin.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, SandboxSchema } from '@sluice-dev/config';
import {
  describeAction,
  describeDbChange,
  diffSessions,
  formatDiff,
  loadScript,
  renderSessionHtml,
  stepName,
  validateScript,
  type BrowserEvidence,
  type Session,
} from '@sluice-dev/evidence';
import { PLAYWRIGHT_VERSION } from '@sluice-dev/sandbox';

const DEMO = join(import.meta.dirname, '..', '..', '..', 'examples', 'billing-demo');

function page(over: Partial<BrowserEvidence> = {}): BrowserEvidence {
  return {
    action: 'click #cancel',
    url: '/portal/1',
    title: 'Billing portal',
    text: ['Your subscription', 'Status: active', 'Cancels on 2030-02-15'],
    network: [
      {
        method: 'POST',
        path: '/subscriptions/1/cancel',
        resource: 'fetch',
        status: 200,
        response: { id: 1, status: 'active' },
      },
    ],
    console: [],
    screenshot: 'data:image/jpeg;base64,AAAA',
    ...over,
  };
}

function session(b: BrowserEvidence, db: Session['steps'][number]['db'] = []): Session {
  return {
    format: 'sluice-session/1',
    label: 't',
    script: { name: 'portal', steps: [] },
    seed: 1,
    startMs: 0,
    contractViolations: [],
    steps: [{ index: 0, name: 'browser click #cancel', kind: 'browser', browser: b, egress: [], db, events: [] }],
    final: { fakes: {}, db: {} },
  };
}

describe('browser steps', () => {
  it('validates actions', () => {
    const ok = (browser: unknown) => validateScript({ name: 's', steps: [{ browser }] });
    expect(() => ok({ goto: '/portal/1' })).not.toThrow();
    expect(() => ok({ fill: '#email', value: 'a@b.c' })).not.toThrow();
    expect(() => ok({ press: '#email', key: 'Enter' })).not.toThrow();
    expect(() => ok({ click: '#a', goto: '/' })).toThrow(/exactly one of goto\/click/);
    expect(() => ok({ fill: '#email' })).toThrow(/fill needs value/);
    expect(() => ok({ click: '#a', value: 'x' })).toThrow(/unknown key value/);
    expect(() => ok({ click: '' })).toThrow(/needs a string/);
    expect(() => validateScript({ name: 's', steps: [{ browser: { goto: '/' }, http: {} }] })).toThrow(
      /exactly one of http\/browser/,
    );
  });

  it('names steps and actions', () => {
    expect(stepName({ browser: { click: 'role=button[name="Cancel"]' } })).toBe(
      'browser click role=button[name="Cancel"]',
    );
    expect(describeAction({ fill: '#email', value: 'a@b.c' })).toBe('fill #email = "a@b.c"');
    expect(describeAction({ press: '#q', key: 'Enter' })).toBe('press Enter on #q');
  });

  it('the billing-demo portal script loads', () => {
    const s = loadScript(join(DEMO, 'scripts', 'portal-cancel.yaml'));
    expect(s.steps.filter((st) => 'browser' in st)).toHaveLength(3);
    expect(loadConfig(DEMO).config.sandbox!.browser).toEqual({
      viewport: { width: 1280, height: 800 },
      actionTimeoutMs: 5000,
    });
  });

  it('sandbox.browser accepts true or options', () => {
    const base = { services: { web: { image: 'nginx' } }, ingress: { service: 'web', port: 80 } };
    expect(SandboxSchema.parse(base).browser).toBeUndefined();
    expect(SandboxSchema.parse({ ...base, browser: { viewport: { width: 800, height: 600 } } }).browser).toEqual({
      viewport: { width: 800, height: 600 },
      actionTimeoutMs: 5000,
    });
    expect(() => SandboxSchema.parse({ ...base, browser: { headless: false } })).toThrow();
  });

  it('diffs what the page showed and requested, not screenshots', () => {
    expect(diffSessions(session(page()), session(page({ screenshot: 'data:image/jpeg;base64,BBBB' }))).equal).toBe(
      true,
    );
    const bad = page({
      text: ['Your subscription', 'Status: canceled', 'Ended 2030-01-15'],
      network: [{ ...page().network[0]!, response: { id: 1, status: 'canceled' } }],
      console: ['console.error: boom'],
    });
    const d = diffSessions(session(page()), session(bad));
    expect(d.entries.map((e) => `${e.channel} ${e.path} ${e.kind}`)).toEqual([
      'browser console[0] added',
      'browser network[0].response.status changed',
      'browser text[1] changed',
      'browser text[2] changed',
    ]);
    expect(formatDiff(d)).toContain('~ browser.text[1]: "Status: active" -> "Status: canceled"');
    expect(
      diffSessions(session(page()), session(bad), { ignore: ['browser.text', 'browser.console'] }).entries,
    ).toHaveLength(1);
  });

  it('an extra request is one addition', () => {
    const more = page({ network: [{ method: 'GET', path: '/me', resource: 'fetch', status: 200 }, ...page().network] });
    const d = diffSessions(session(page()), session(more));
    expect(d.entries).toEqual([expect.objectContaining({ channel: 'browser', path: 'network[0]', kind: 'added' })]);
  });

  it('renders a timeline: action -> requests -> data changes', () => {
    const html = renderSessionHtml(
      session(page(), [
        {
          table: 'subscriptions',
          op: 'UPDATE',
          old: { id: 1, status: 'active', cancel_at: null },
          new: { id: 1, status: 'active', cancel_at: '2030-02-15' },
        },
      ]),
    );
    expect(html).toContain('<title>Sluice timeline</title>');
    expect(html).toContain('POST /subscriptions/1/cancel');
    expect(html).toContain('subscriptions #1 UPDATE cancel_at: null → 2030-02-15');
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).not.toContain('<script');
  });

  it('describes DB writes compactly', () => {
    expect(describeDbChange({ table: 't', op: 'INSERT', old: null, new: { id: 2, a: 1 } })).toBe(
      't #2 INSERT {"id":2,"a":1}',
    );
    expect(describeDbChange({ table: 't', op: 'DELETE', old: { id: 2 }, new: null })).toBe('t #2 DELETE {"id":2}');
  });

  it('client playwright-core matches the sandbox browser image', () => {
    const require = createRequire(join(import.meta.dirname, '..', 'package.json'));
    const pkg = JSON.parse(readFileSync(require.resolve('playwright-core/package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe(PLAYWRIGHT_VERSION);
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['playwright-core']).toBe(PLAYWRIGHT_VERSION);
  });
});
