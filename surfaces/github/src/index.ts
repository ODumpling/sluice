/**
 * "Sluice Gate" GitHub App: a webhook server that runs the gate on every pull
 * request and reports the verdict as a check run, authenticating as the App
 * (RS256 JWT -> installation token). Stateless; clones into a work dir.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@sluice-dev/config';
import { GitHubClient, installationToken, verifyWebhookSignature } from '@sluice-dev/github-api';
import { renderMarkdown, runGate, writeReport, type GateConfig, type GateReport } from '@sluice-dev/plugin-gate';
import { git } from '@sluice-dev/sandbox';

export interface GateAppOptions {
  appId: number | string;
  privateKeyPem: string;
  webhookSecret: string;
  apiBaseUrl?: string;
  /** Where repositories are cloned (one temp dir per job). */
  workDir: string;
  /** Clone URL for a repo; default https with the installation token. */
  cloneUrl?: (owner: string, repo: string, token: string) => string;
  /** Directory (inside the repo) containing sluice.yaml. */
  projectPath?: string;
  /** Seconds since epoch, for JWTs (tests run on simulated time). */
  nowSec?: () => number;
  run?: typeof runGate;
  log?: (msg: string) => void;
}

const TICKET_RE = /\[([A-Z][A-Z0-9]+-\d+)\]|Ticket:\s*([A-Za-z0-9._-]+)/;

export function extractTicket(...texts: (string | null | undefined)[]): string | undefined {
  for (const t of texts) {
    const m = t ? TICKET_RE.exec(t) : null;
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
}

export interface WebhookResult {
  status: number;
  body: unknown;
  /** Resolves when the triggered gate job (if any) has finished. */
  job?: Promise<GateReport | undefined>;
}

export function createGateApp(opts: GateAppOptions) {
  const log = opts.log ?? (() => {});
  const run = opts.run ?? runGate;
  const cloneUrl = opts.cloneUrl ?? ((o, r, t) => `https://x-access-token:${t}@github.com/${o}/${r}.git`);

  async function job(ev: PullRequestEvent): Promise<GateReport | undefined> {
    const owner = ev.repository.owner.login;
    const repo = ev.repository.name;
    const pr = ev.pull_request;
    const { token } = await installationToken({
      appId: opts.appId,
      privateKeyPem: opts.privateKeyPem,
      installationId: ev.installation!.id,
      baseUrl: opts.apiBaseUrl,
      nowSec: opts.nowSec?.(),
    });
    const gh = new GitHubClient({ baseUrl: opts.apiBaseUrl, token, userAgent: 'sluice-gate-app' });
    const ticket = extractTicket(pr.title, pr.body, pr.head.ref);
    if (!ticket) {
      await gh.createCheckRun(owner, repo, {
        name: 'Sluice Gate',
        head_sha: pr.head.sha,
        conclusion: 'neutral',
        output: {
          title: 'No ticket referenced',
          summary: 'Mention the ticket in the PR title or body, e.g. `[CANCEL-1]` or `Ticket: CANCEL-1`.',
        },
      });
      return undefined;
    }
    const check = await gh.createCheckRun(owner, repo, {
      name: 'Sluice Gate',
      head_sha: pr.head.sha,
      status: 'in_progress',
    });
    const dir = mkdtempSync(join(opts.workDir, 'job-'));
    try {
      const checkout = join(dir, 'repo');
      await git(['clone', '--quiet', '--no-checkout', cloneUrl(owner, repo, token), checkout], dir);
      await git(['fetch', '--quiet', 'origin', pr.base.sha, pr.head.sha], checkout).catch(() => undefined);
      await git(['checkout', '--quiet', '--detach', pr.base.sha], checkout);
      const projectRoot = join(checkout, opts.projectPath ?? '.');
      const cfg = (loadConfig(projectRoot).config.pluginConfig.gate ?? {}) as GateConfig;
      log(`gate ${owner}/${repo}#${pr.number} ticket ${ticket}`);
      const report = await run({ ...cfg, projectRoot, ticket, base: pr.base.sha, head: pr.head.sha, log });
      writeReport(report, join(opts.workDir, 'reports'));
      await gh.updateCheckRun(owner, repo, check.id, {
        status: 'completed',
        conclusion: report.verdict === 'pass' ? 'success' : 'failure',
        output: renderMarkdown(report),
      });
      return report;
    } catch (e) {
      await gh.updateCheckRun(owner, repo, check.id, {
        status: 'completed',
        conclusion: 'failure',
        output: { title: 'Sluice Gate errored', summary: String((e as Error).message).slice(0, 60_000) },
      });
      throw e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function handle(headers: Record<string, string | undefined>, raw: string): WebhookResult {
    if (!verifyWebhookSignature(opts.webhookSecret, raw, headers['x-hub-signature-256'])) {
      return { status: 401, body: { error: 'bad signature' } };
    }
    const event = headers['x-github-event'];
    if (event === 'ping') return { status: 200, body: { ok: true } };
    if (event !== 'pull_request') return { status: 202, body: { ignored: event } };
    const ev = JSON.parse(raw) as PullRequestEvent;
    if (!['opened', 'synchronize', 'reopened'].includes(ev.action))
      return { status: 202, body: { ignored: ev.action } };
    if (!ev.installation?.id) return { status: 400, body: { error: 'missing installation' } };
    const p = job(ev);
    p.catch((e: unknown) => log(`gate job failed: ${(e as Error).message}`));
    return {
      status: 202,
      body: { queued: `${ev.repository.owner.login}/${ev.repository.name}#${ev.pull_request.number}` },
      job: p,
    };
  }

  function listen(port = 0, host = '127.0.0.1'): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
        const r =
          req.method === 'POST' && req.url === '/webhook'
            ? handle(headers, Buffer.concat(chunks).toString('utf8'))
            : { status: 404, body: { error: 'not found' } };
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    return new Promise((resolve) =>
      server.listen(port, host, () =>
        resolve({
          url: `http://${host}:${(server.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        }),
      ),
    );
  }

  return { handle, listen, job };
}
