/**
 * Browser steps: drive the app's frontend with Playwright and record what the
 * page did. The browser runs inside the sandbox (see `sandbox.browser`); this
 * module is the host-side client that connects to it through the gateway.
 *
 * Per action Sluice records the page's own requests (documents, fetch/XHR,
 * failures), console errors, the URL, title and visible text after the page
 * settles, and a screenshot. Because each action is its own script step, the
 * DB writes, egress and events the action caused are attributed to it by the
 * same machinery as `http` steps — frontend click → API call → data change.
 *
 * Determinism: fresh context per run, fixed Date (follows the sandbox clock),
 * seeded Math.random, UTC timezone, en-US locale, fixed viewport.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright-core';
import type { Json } from '@sluice-dev/fakes';
import type { BrowserAction } from './script.js';

/** The Playwright page of a browser session (for hosts evaluating checks against the live page). */
export type BrowserPage = Page;

export interface BrowserRequest {
  method: string;
  /** Path + query for requests to the app; the full URL for anything else. */
  path: string;
  /** Playwright resource type: document, fetch, xhr (others are recorded only when they fail). */
  resource: string;
  /** HTTP status, or null when the request failed. */
  status: number | null;
  /** Request body (JSON-parsed when possible). */
  body?: Json;
  /** Response body for fetch/XHR (JSON-parsed when possible). */
  response?: Json;
  /** Network error, e.g. net::ERR_NAME_NOT_RESOLVED (the sandbox has no route out). */
  failure?: string;
}

export interface BrowserEvidence {
  /** The action as written, e.g. "click role=button[name=Cancel]". */
  action: string;
  /** Page URL after the action (path for the app's own origin). */
  url: string;
  title: string;
  /** Visible text of the page after the action, one entry per non-empty line. */
  text: string[];
  network: BrowserRequest[];
  /** console.error output, uncaught page errors and failed requests. */
  console: string[];
  /** JPEG data URL; not part of behavior diffs. */
  screenshot?: string;
  /** Set when the action (or a `save`) failed, e.g. the element never appeared. */
  error?: string;
}

export interface BrowserSessionOptions {
  /** Playwright run-server endpoint (Sandbox.browserEndpoint). */
  endpoint: string;
  /** App URL as the browser sees it (Sandbox.browserBaseUrl). */
  baseUrl: string;
  nowMs: number;
  seed: number;
  viewport?: { width: number; height: number };
  actionTimeoutMs?: number;
  /** Capture a screenshot after every action (default true). */
  screenshots?: boolean;
  /** Write a Playwright trace (open with `npx playwright show-trace <file>`). */
  trace?: string;
}

const RECORDED = new Set(['document', 'fetch', 'xhr']);
const SETTLE_IDLE_MS = 300;
const SETTLE_MAX_MS = 10_000;
const MAX_TEXT_LINES = 300;

/** Seeded Math.random (mulberry32) installed before any page script runs. */
const seedScript = (seed: number) => `(() => {
  let a = ${seed >>> 0} || 1;
  Math.random = function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

function parseMaybeJson(text: string): Json {
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
  }
}

/** First line of a Playwright error, without ANSI codes or the call log. */
function errorLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
    .split('\n')[0]!
    .trim();
}

export function describeAction(a: BrowserAction): string {
  if ('goto' in a) return `goto ${a.goto}`;
  if ('click' in a) return `click ${a.click}`;
  if ('fill' in a) return `fill ${a.fill} = ${JSON.stringify(a.value)}`;
  if ('press' in a) return `press ${a.key} on ${a.press}`;
  if ('select' in a) return `select ${JSON.stringify(a.value)} in ${a.select}`;
  if ('check' in a) return `check ${a.check}`;
  if ('uncheck' in a) return `uncheck ${a.uncheck}`;
  return `waitFor ${a.waitFor}`;
}

export class BrowserSession {
  private seq = 0;
  private readonly inflight = new Set<Request>();
  private readonly captures = new Set<Promise<void>>();
  private records: (BrowserRequest & { seq: number })[] = [];
  private consoleLines: string[] = [];
  private readonly reqSeq = new WeakMap<Request, number>();
  private readonly origin: string;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly opts: BrowserSessionOptions,
  ) {
    this.origin = new URL(opts.baseUrl).origin;
    context.on('request', (r) => {
      this.reqSeq.set(r, this.seq++);
      this.inflight.add(r);
    });
    context.on('requestfinished', (r) => this.track(this.capture(r, undefined)));
    context.on('requestfailed', (r) => this.track(this.capture(r, r.failure()?.errorText ?? 'failed')));
    page.on('console', (m) => {
      if (m.type() === 'error') this.consoleLines.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => this.consoleLines.push(`pageerror: ${e.message}`));
  }

  static async open(opts: BrowserSessionOptions): Promise<BrowserSession> {
    const browser = await chromium.connect(opts.endpoint, { timeout: 30_000 });
    try {
      const context = await browser.newContext({
        baseURL: opts.baseUrl,
        viewport: opts.viewport ?? { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        timezoneId: 'UTC',
        locale: 'en-US',
        reducedMotion: 'reduce',
      });
      await context.clock.setFixedTime(opts.nowMs);
      await context.addInitScript({ content: seedScript(opts.seed) });
      if (opts.trace) await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      return new BrowserSession(browser, context, page, opts);
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
  }

  private track(p: Promise<void>): void {
    this.captures.add(p);
    void p.finally(() => this.captures.delete(p));
  }

  private relative(url: string): string {
    try {
      const u = new URL(url);
      return u.origin === this.origin ? u.pathname + u.search + u.hash : url;
    } catch {
      return url;
    }
  }

  private async capture(r: Request, failure: string | undefined): Promise<void> {
    try {
      const resource = r.resourceType();
      if (!/^https?:/.test(r.url()) || (!RECORDED.has(resource) && failure === undefined)) return;
      const rec: BrowserRequest & { seq: number } = {
        seq: this.reqSeq.get(r) ?? this.seq++,
        method: r.method(),
        path: this.relative(r.url()),
        resource,
        status: null,
      };
      const post = r.postData();
      if (post !== null) rec.body = parseMaybeJson(post);
      if (failure !== undefined) {
        rec.failure = failure;
        this.consoleLines.push(`failed ${rec.method} ${rec.path}: ${failure}`);
      } else {
        const res = await r.response();
        rec.status = res?.status() ?? null;
        if (res && (resource === 'fetch' || resource === 'xhr'))
          rec.response = parseMaybeJson(await res.text().catch(() => ''));
      }
      this.records.push(rec);
    } finally {
      this.inflight.delete(r);
    }
  }

  /** Wait until no request has been in flight for SETTLE_IDLE_MS (bounded). */
  private async settle(): Promise<void> {
    const deadline = Date.now() + SETTLE_MAX_MS;
    let idleSince = Date.now();
    while (Date.now() < deadline) {
      // always yield to the event loop (a timer, not a microtask): Playwright's events arrive as I/O
      await new Promise((r) => setTimeout(r, 25));
      if (this.inflight.size || this.captures.size) idleSince = Date.now();
      else if (Date.now() - idleSince >= SETTLE_IDLE_MS) return;
    }
  }

  /** Run one action (already interpolated), let the page settle, and snapshot it. */
  async run(
    action: BrowserAction,
    save: Record<string, string> = {},
  ): Promise<{ evidence: BrowserEvidence; saved: Record<string, Json> }> {
    const page = this.page;
    const timeout = this.opts.actionTimeoutMs ?? 5000;
    let error: string | undefined;
    try {
      if ('goto' in action) await page.goto(action.goto, { timeout: 30_000, waitUntil: 'load' });
      else if ('click' in action) await page.locator(action.click).click({ timeout });
      else if ('fill' in action) await page.locator(action.fill).fill(String(action.value), { timeout });
      else if ('press' in action) await page.locator(action.press).press(action.key, { timeout });
      else if ('select' in action) await page.locator(action.select).selectOption(String(action.value), { timeout });
      else if ('check' in action) await page.locator(action.check).check({ timeout });
      else if ('uncheck' in action) await page.locator(action.uncheck).uncheck({ timeout });
      else await page.locator(action.waitFor).waitFor({ state: 'visible', timeout });
    } catch (e) {
      error = errorLine(e);
    }
    await this.settle();
    await page.waitForLoadState('load', { timeout }).catch(() => {});

    const saved: Record<string, Json> = {};
    for (const [k, sel] of Object.entries(save)) {
      try {
        saved[k] = ((await page.locator(sel).first().textContent({ timeout })) ?? '').trim();
      } catch (e) {
        saved[k] = null;
        error ??= `save ${k} (${sel}): ${errorLine(e)}`;
      }
    }

    const text = await page
      .locator('body')
      .innerText({ timeout: 2000 })
      .catch(() => '');
    const network = this.records.sort((a, b) => a.seq - b.seq).map(({ seq: _seq, ...r }) => r);
    this.records = [];
    const evidence: BrowserEvidence = {
      action: describeAction(action),
      url: this.relative(page.url()),
      title: await page.title().catch(() => ''),
      text: text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, MAX_TEXT_LINES),
      network,
      console: this.consoleLines,
    };
    this.consoleLines = [];
    if (this.opts.screenshots !== false) {
      const shot = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 10_000 }).catch(() => undefined);
      if (shot) evidence.screenshot = `data:image/jpeg;base64,${shot.toString('base64')}`;
    }
    if (error !== undefined) evidence.error = error;
    return { evidence, saved };
  }

  /** Follow the sandbox clock (advance/clock steps). */
  async setClock(ms: number): Promise<void> {
    await this.context.clock.setFixedTime(ms);
  }

  async close(): Promise<void> {
    try {
      if (this.opts.trace) await this.context.tracing.stop({ path: this.opts.trace });
    } finally {
      await this.context.close().catch(() => {});
      await this.browser.close().catch(() => {});
    }
  }
}
