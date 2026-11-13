/**
 * Minimal, dependency-free GitHub REST client (fetch). Base URL is
 * configurable so the same code talks to api.github.com, GHES, the Sluice
 * GitHub fake, or the Sluice credential broker.
 */
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`GitHub ${method} ${path} -> ${status}: ${(body as { message?: string })?.message ?? JSON.stringify(body)}`);
    this.name = 'GitHubApiError';
  }
}

export interface GitHubClientOptions {
  baseUrl?: string;
  /** Static token, or a function returning one (e.g. installation-token refresh). */
  token: string | (() => Promise<string>);
  userAgent?: string;
}

export interface CheckRunInput {
  name: string;
  head_sha: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  details_url?: string;
  external_id?: string;
  output?: { title: string; summary: string; text?: string };
}

export class GitHubClient {
  readonly baseUrl: string;
  private readonly token: GitHubClientOptions['token'];
  private readonly ua: string;

  constructor(opts: GitHubClientOptions) {
    this.baseUrl = (opts.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
    this.token = opts.token;
    this.ua = opts.userAgent ?? 'sluice-gate';
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': this.ua,
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new GitHubApiError(res.status, method, path, parsed);
    return parsed as T;
  }

  getRepo(owner: string, repo: string) {
    return this.request<{ full_name: string; default_branch: string }>('GET', `/repos/${owner}/${repo}`);
  }
  createCheckRun(owner: string, repo: string, input: CheckRunInput) {
    return this.request<{ id: number; html_url: string; conclusion: string | null }>(
      'POST',
      `/repos/${owner}/${repo}/check-runs`,
      input,
    );
  }
  updateCheckRun(owner: string, repo: string, id: number, input: Partial<CheckRunInput>) {
    return this.request<{ id: number; conclusion: string | null }>(
      'PATCH',
      `/repos/${owner}/${repo}/check-runs/${id}`,
      input,
    );
  }
  listCheckRuns(owner: string, repo: string, ref: string) {
    return this.request<{
      total_count: number;
      check_runs: {
        id: number;
        name: string;
        conclusion: string | null;
        output: { title: string | null; summary: string | null };
      }[];
    }>('GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`);
  }
  createComment(owner: string, repo: string, issue: number, body: string) {
    return this.request<{ id: number; html_url: string }>('POST', `/repos/${owner}/${repo}/issues/${issue}/comments`, {
      body,
    });
  }
  getPull(owner: string, repo: string, n: number) {
    return this.request<{
      number: number;
      head: { sha: string; ref: string };
      base: { sha: string; ref: string };
      title: string;
      body: string | null;
    }>('GET', `/repos/${owner}/${repo}/pulls/${n}`);
  }
  mergePull(owner: string, repo: string, n: number) {
    return this.request<{ merged: boolean; sha: string }>('PUT', `/repos/${owner}/${repo}/pulls/${n}/merge`, {});
  }
  putFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    opts: { branch?: string; sha?: string } = {},
  ) {
    return this.request<{ commit: { sha: string } }>('PUT', `/repos/${owner}/${repo}/contents/${path}`, {
      message,
      content: Buffer.from(content).toString('base64'),
      ...opts,
    });
  }
  getFile(owner: string, repo: string, path: string, ref?: string) {
    return this.request<{ content: string; sha: string }>(
      'GET',
      `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
    ).then((f) => ({ sha: f.sha, text: Buffer.from(f.content, 'base64').toString('utf8') }));
  }
}

/** RS256 JWT for authenticating as a GitHub App (valid 9 minutes, backdated 60s for clock skew). */
export function appJwt(appId: number | string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const body = enc({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** Exchange an app JWT for an installation access token. */
export async function installationToken(opts: {
  appId: number | string;
  privateKeyPem: string;
  installationId: number;
  baseUrl?: string;
  nowSec?: number;
  permissions?: Record<string, 'read' | 'write'>;
}): Promise<{ token: string; expires_at: string }> {
  const client = new GitHubClient({
    baseUrl: opts.baseUrl,
    token: appJwt(opts.appId, opts.privateKeyPem, opts.nowSec),
  });
  return client.request(
    'POST',
    `/app/installations/${opts.installationId}/access_tokens`,
    opts.permissions ? { permissions: opts.permissions } : {},
  );
}

/** Verify an X-Hub-Signature-256 header for a webhook payload. */
export function verifyWebhookSignature(secret: string, payload: string | Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function signWebhook(secret: string, payload: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split('/');
  if (!owner || !repo) throw new Error(`expected owner/repo, got ${full}`);
  return { owner, repo };
}
