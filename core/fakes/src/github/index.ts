/**
 * Stateful GitHub REST fake on the vendored GitHub OpenAPI description.
 *
 * Implemented: repositories, branches, contents (read/write), pull requests
 * (list/get/create/merge/files), issue comments, check runs (create/update/
 * get/list-for-ref), GitHub App installations and installation access tokens
 * (RS256 app JWT verified against the registered public key).
 *
 * Authorization is modelled on fine-grained permissions: every token carries
 * a repo set and permissions (`checks: write`, `contents: read`, …); requests
 * without the needed permission get GitHub's 403 "Resource not accessible by
 * integration". Unknown tokens get 401 "Bad credentials".
 */
import { createHash, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Contract, type Json, type OpenApiDoc } from '../contract.js';
import type { SimClock } from '../clock.js';
import type { Fake, FakeRequest, FakeResponse } from '../server.js';

// GitHub objects are dynamic JSON validated by the contract, not the type system.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

export type Permission = 'read' | 'write';
export type Permissions = Record<string, Permission>;

let cached: Contract | undefined;
export function githubContract(): Contract {
  cached ??= new Contract(
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../../vendor/github/openapi.json', import.meta.url)), 'utf8'),
    ) as OpenApiDoc,
  );
  return cached;
}

interface TokenInfo {
  login: string;
  /** owner/name list, or '*' for all repos the identity can see. */
  repos: string[] | '*';
  permissions: Permissions;
  expiresAt?: number;
  installationId?: number;
}

interface Branch {
  sha: string;
  files: Map<string, string>;
}

interface Repo {
  owner: string;
  name: string;
  id: number;
  defaultBranch: string;
  branches: Map<string, Branch>;
  pulls: Obj[];
  pullFiles: Map<number, Obj[]>;
  comments: Map<number, Obj[]>;
  checkRuns: Obj[];
  installationId?: number;
}

interface State {
  nextId: number;
  repos: Map<string, Repo>;
  tokens: Map<string, TokenInfo>;
  apps: Map<number, { slug: string; publicKeyPem: string }>;
  installations: Map<number, { appId: number; account: string; repos: string[]; permissions: Permissions }>;
  tokenCounter: number;
}

const WEB = 'https://github.com';
const API = 'https://api.github.com';

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function sha1(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex');
}

export interface GitHubFakeOptions {
  clock: SimClock;
}

export class GitHubFake implements Fake {
  readonly name = 'github';
  readonly contract: Contract;
  private readonly clock: SimClock;
  private s: State;
  private seed = 1;

  constructor(opts: GitHubFakeOptions) {
    this.contract = githubContract();
    this.clock = opts.clock;
    this.s = this.empty();
  }

  private empty(): State {
    return {
      nextId: 1000,
      repos: new Map(),
      tokens: new Map(),
      apps: new Map(),
      installations: new Map(),
      tokenCounter: 0,
    };
  }

  reset(seed: number): void {
    this.seed = seed;
    this.s = this.empty();
  }

  // ------------------------------------------------------------------ seeding API

  createRepo(opts: { owner: string; name: string; defaultBranch?: string; files?: Record<string, string> }): void {
    const key = `${opts.owner}/${opts.name}`;
    const branch = opts.defaultBranch ?? 'main';
    const files = new Map(Object.entries(opts.files ?? {}));
    this.s.repos.set(key, {
      owner: opts.owner,
      name: opts.name,
      id: this.id(),
      defaultBranch: branch,
      branches: new Map([[branch, { sha: sha1('init', key, String(this.seed)), files }]]),
      pulls: [],
      pullFiles: new Map(),
      comments: new Map(),
      checkRuns: [],
    });
  }

  setBranch(repo: string, branch: string, sha: string, files: Record<string, string> = {}): void {
    this.repo(repo).branches.set(branch, { sha, files: new Map(Object.entries(files)) });
  }

  /** A token with explicit permissions (models a fine-grained PAT or a broker-issued credential). */
  issueToken(token: string, info: TokenInfo): void {
    this.s.tokens.set(token, info);
  }

  registerApp(id: number, slug: string, publicKeyPem: string): void {
    this.s.apps.set(id, { slug, publicKeyPem });
  }

  installApp(installationId: number, appId: number, account: string, repos: string[], permissions: Permissions): void {
    this.s.installations.set(installationId, { appId, account, repos, permissions });
    for (const r of repos) this.repo(r).installationId = installationId;
  }

  /** Seed a pull request opened from `head` into the default branch. */
  openPullRequest(
    repo: string,
    opts: { head: string; title: string; body?: string; user?: string; files?: Obj[] },
  ): Obj {
    const r = this.repo(repo);
    const pr = this.makePull(r, opts.head, r.defaultBranch, opts.title, opts.body ?? '', opts.user ?? 'agent');
    if (opts.files)
      r.pullFiles.set(
        pr.number as number,
        opts.files.map((f) => this.diffEntry(r, f)),
      );
    return pr;
  }

  checkRuns(repo: string): Obj[] {
    return structuredClone(this.repo(repo).checkRuns);
  }

  comments(repo: string, issue: number): Obj[] {
    return structuredClone(this.repo(repo).comments.get(issue) ?? []);
  }

  file(repo: string, branch: string, path: string): string | undefined {
    return this.repo(repo).branches.get(branch)?.files.get(path);
  }

  state(): Json {
    const repos: Obj = {};
    for (const [k, r] of this.s.repos) {
      repos[k] = {
        defaultBranch: r.defaultBranch,
        branches: Object.fromEntries(
          [...r.branches].map(([n, b]) => [n, { sha: b.sha, files: Object.fromEntries(b.files) }]),
        ),
        pulls: r.pulls,
        comments: Object.fromEntries(r.comments),
        checkRuns: r.checkRuns,
      };
    }
    return structuredClone({ repos }) as Json;
  }

  // ------------------------------------------------------------------ helpers

  private id(): number {
    return this.s.nextId++;
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString().replace('.000Z', 'Z');
  }

  private repo(key: string): Repo {
    const r = this.s.repos.get(key);
    if (!r) throw new Error(`github fake: no repo ${key}`);
    return r;
  }

  /** Synthesized from the schema, overridden by `fields`, restricted to documented properties. */
  private make(schema: string, fields: Obj): Obj {
    const props = (this.contract.schema(schema).properties ?? {}) as Record<string, unknown>;
    const out: Obj = { ...(this.contract.synthesize(schema) as Obj) };
    for (const [k, v] of Object.entries(fields)) if (k in props && v !== undefined) out[k] = v;
    return out;
  }

  private user(login: string, type = 'User'): Obj {
    return this.make('simple-user', {
      login,
      id: Number.parseInt(sha1('user', login).slice(0, 6), 16),
      node_id: b64(`U_${login}`),
      avatar_url: `https://avatars.githubusercontent.com/${login}`,
      url: `${API}/users/${login}`,
      html_url: `${WEB}/${login}`,
      type,
      site_admin: false,
    });
  }

  error(status: number, message: string, extra: Record<string, Json> = {}): FakeResponse {
    return {
      status,
      // validation errors (422) document no `status` field
      body: {
        message,
        documentation_url: 'https://docs.github.com/rest',
        ...(status === 422 ? {} : { status: String(status) }),
        ...extra,
      },
    };
  }

  private repoObject(r: Repo, schema: 'full-repository' | 'repository' = 'full-repository'): Obj {
    const full = `${r.owner}/${r.name}`;
    const base = `${API}/repos/${full}`;
    const urls: Obj = {};
    const props = (this.contract.schema(schema).properties ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(props)) if (k.endsWith('_url')) urls[k] = `${base}/${k.replace(/_url$/, '')}`;
    return this.make(schema, {
      ...urls,
      id: r.id,
      node_id: b64(`R_${full}`),
      name: r.name,
      full_name: full,
      owner: this.user(r.owner, 'Organization'),
      private: true,
      html_url: `${WEB}/${full}`,
      url: base,
      default_branch: r.defaultBranch,
      visibility: 'private',
      created_at: this.now(),
      updated_at: this.now(),
      pushed_at: this.now(),
      clone_url: `${WEB}/${full}.git`,
      git_url: `git://github.com/${full}.git`,
      ssh_url: `git@github.com:${full}.git`,
      svn_url: `${WEB}/${full}`,
      mirror_url: null,
      homepage: null,
      language: null,
      description: null,
      network_count: 0,
      subscribers_count: 0,
    });
  }

  private makePull(r: Repo, head: string, base: string, title: string, body: string, login: string): Obj {
    const number = r.pulls.length + 1;
    const full = `${r.owner}/${r.name}`;
    const api = `${API}/repos/${full}/pulls/${number}`;
    const ref = (branch: string) => ({
      label: `${r.owner}:${branch}`,
      ref: branch,
      sha: r.branches.get(branch)?.sha ?? sha1('missing', branch),
      user: this.user(r.owner, 'Organization'),
      repo: this.repoObject(r, 'repository'),
    });
    const link = (href: string) => ({ href });
    const pr = this.make('pull-request', {
      id: this.id(),
      node_id: b64(`PR_${full}_${number}`),
      number,
      state: 'open',
      locked: false,
      title,
      body,
      user: this.user(login),
      url: api,
      html_url: `${WEB}/${full}/pull/${number}`,
      diff_url: `${WEB}/${full}/pull/${number}.diff`,
      patch_url: `${WEB}/${full}/pull/${number}.patch`,
      issue_url: `${API}/repos/${full}/issues/${number}`,
      commits_url: `${api}/commits`,
      review_comments_url: `${api}/comments`,
      review_comment_url: `${API}/repos/${full}/pulls/comments{/number}`,
      comments_url: `${API}/repos/${full}/issues/${number}/comments`,
      statuses_url: `${API}/repos/${full}/statuses/${ref(head).sha}`,
      created_at: this.now(),
      updated_at: this.now(),
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      assignee: null,
      assignees: [],
      requested_reviewers: [],
      requested_teams: [],
      labels: [],
      milestone: null,
      draft: false,
      head: ref(head),
      base: ref(base),
      _links: {
        self: link(api),
        html: link(`${WEB}/${full}/pull/${number}`),
        issue: link(`${API}/repos/${full}/issues/${number}`),
        comments: link(`${API}/repos/${full}/issues/${number}/comments`),
        review_comments: link(`${api}/comments`),
        review_comment: link(`${API}/repos/${full}/pulls/comments{/number}`),
        commits: link(`${api}/commits`),
        statuses: link(`${API}/repos/${full}/statuses/${ref(head).sha}`),
      },
      author_association: 'CONTRIBUTOR',
      auto_merge: null,
      active_lock_reason: null,
      merged: false,
      mergeable: true,
      rebaseable: true,
      mergeable_state: 'clean',
      merged_by: null,
      comments: 0,
      review_comments: 0,
      maintainer_can_modify: false,
      commits: 1,
      additions: 0,
      deletions: 0,
      changed_files: 0,
    });
    r.pulls.push(pr);
    return pr;
  }

  private diffEntry(r: Repo, f: Obj): Obj {
    const full = `${r.owner}/${r.name}`;
    return this.make('diff-entry', {
      sha: sha1('file', String(f.filename)),
      filename: f.filename,
      status: f.status ?? 'modified',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      changes: (f.additions ?? 0) + (f.deletions ?? 0),
      blob_url: `${WEB}/${full}/blob/${f.filename}`,
      raw_url: `${WEB}/${full}/raw/${f.filename}`,
      contents_url: `${API}/repos/${full}/contents/${f.filename}`,
      patch: f.patch,
    });
  }

  private checkRunObject(r: Repo, fields: Obj): Obj {
    const full = `${r.owner}/${r.name}`;
    const id = fields.id as number;
    return this.make('check-run', {
      node_id: b64(`CR_${id}`),
      url: `${API}/repos/${full}/check-runs/${id}`,
      html_url: `${WEB}/${full}/runs/${id}`,
      details_url: null,
      external_id: null,
      started_at: this.now(),
      completed_at: null,
      conclusion: null,
      check_suite: { id: id + 1 },
      app: null,
      pull_requests: [],
      ...fields,
    });
  }

  // ------------------------------------------------------------------ auth

  private verifyAppJwt(jwt: string): number | undefined {
    const parts = jwt.split('.');
    if (parts.length !== 3) return undefined;
    let payload: { iss?: string | number; exp?: number; iat?: number };
    try {
      payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as typeof payload;
    } catch {
      return undefined;
    }
    const appId = Number(payload.iss);
    const app = this.s.apps.get(appId);
    if (!app) return undefined;
    const ok = createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(app.publicKeyPem, Buffer.from(parts[2]!, 'base64url'));
    if (!ok) return undefined;
    const now = Math.floor(this.clock.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now || payload.exp - (payload.iat ?? now) > 600)
      return undefined;
    return appId;
  }

  private auth(req: FakeRequest): { token?: TokenInfo; appId?: number } {
    const h = req.headers.authorization ?? '';
    const m = /^(?:token|Bearer)\s+(.+)$/i.exec(h);
    if (!m) return {};
    const cred = m[1]!.trim();
    if (cred.split('.').length === 3 && cred.startsWith('ey')) return { appId: this.verifyAppJwt(cred) };
    const t = this.s.tokens.get(cred);
    if (!t) return {};
    if (t.expiresAt !== undefined && t.expiresAt <= this.clock.now()) return {};
    return { token: t };
  }

  private requirePermission(token: TokenInfo, repo: string, perm: string, level: Permission): FakeResponse | undefined {
    if (token.repos !== '*' && !token.repos.includes(repo)) return this.error(404, 'Not Found');
    const have = token.permissions[perm];
    if (!have || (level === 'write' && have !== 'write')) {
      return this.error(403, 'Resource not accessible by integration', {
        'x-accepted-github-permissions': `${perm}=${level}`,
      });
    }
    return undefined;
  }

  preflight(): FakeResponse | undefined {
    return undefined;
  }

  // ------------------------------------------------------------------ routing

  handle(req: FakeRequest): FakeResponse {
    const key = `${req.method} ${req.route}`;
    const p = req.params;
    const { token, appId } = this.auth(req);

    if (key === 'POST /app/installations/{installation_id}/access_tokens') {
      if (appId === undefined) return this.error(401, 'A JSON web token could not be decoded');
      const inst = this.s.installations.get(Number(p.installation_id));
      if (!inst || inst.appId !== appId) return this.error(404, 'Not Found');
      const requested = (req.body.permissions ?? inst.permissions) as Permissions;
      for (const [k, v] of Object.entries(requested)) {
        const granted = inst.permissions[k];
        if (!granted || (v === 'write' && granted !== 'write')) {
          return this.error(422, `The permissions requested are not granted to this installation.`);
        }
      }
      const repos = Array.isArray(req.body.repositories)
        ? (req.body.repositories as string[]).map((n) => `${inst.account}/${n}`)
        : inst.repos;
      const tok = `ghs_${sha1('inst', String(p.installation_id), String(++this.s.tokenCounter), String(this.seed)).slice(0, 36)}`;
      const expiresAt = this.clock.now() + 3_600_000;
      this.s.tokens.set(tok, {
        login: `${this.s.apps.get(appId)!.slug}[bot]`,
        repos,
        permissions: requested,
        expiresAt,
        installationId: Number(p.installation_id),
      });
      return {
        status: 201,
        body: {
          token: tok,
          expires_at: new Date(expiresAt).toISOString().replace('.000Z', 'Z'),
          permissions: requested,
          repository_selection: 'selected',
        },
      };
    }

    const full = p.owner && p.repo ? `${p.owner}/${p.repo}` : undefined;
    const r = full ? this.s.repos.get(full) : undefined;

    if (key === 'GET /repos/{owner}/{repo}/installation') {
      if (appId === undefined) return this.error(401, 'A JSON web token could not be decoded');
      if (!r || r.installationId === undefined) return this.error(404, 'Not Found');
      const inst = this.s.installations.get(r.installationId)!;
      if (inst.appId !== appId) return this.error(404, 'Not Found');
      return {
        status: 200,
        body: this.make('installation', {
          id: r.installationId,
          app_id: appId,
          app_slug: this.s.apps.get(appId)!.slug,
          target_id: 1,
          target_type: 'Organization',
          account: this.user(inst.account, 'Organization'),
          permissions: inst.permissions,
          repository_selection: 'selected',
          access_tokens_url: `${API}/app/installations/${r.installationId}/access_tokens`,
          repositories_url: `${API}/installation/repositories`,
          html_url: `${WEB}/organizations/${inst.account}/settings/installations/${r.installationId}`,
          events: ['pull_request', 'check_run'],
          created_at: this.now(),
          updated_at: this.now(),
          single_file_name: null,
          suspended_at: null,
          suspended_by: null,
        }),
      };
    }

    if (!token) return this.error(401, 'Bad credentials');
    if (!r || !full) return this.error(404, 'Not Found');
    const need = (perm: string, level: Permission) => this.requirePermission(token, full, perm, level);

    switch (key) {
      case 'GET /repos/{owner}/{repo}':
        return need('metadata', 'read') ?? { status: 200, body: this.repoObject(r) };
      case 'GET /repos/{owner}/{repo}/branches/{branch}': {
        const denied = need('contents', 'read');
        if (denied) return denied;
        const b = r.branches.get(p.branch!);
        if (!b) return this.error(404, 'Branch not found');
        const commit = this.make('commit', {
          sha: b.sha,
          node_id: b64(`C_${b.sha}`),
          url: `${API}/repos/${full}/commits/${b.sha}`,
          html_url: `${WEB}/${full}/commit/${b.sha}`,
          comments_url: `${API}/repos/${full}/commits/${b.sha}/comments`,
          author: null,
          committer: null,
          parents: [],
          commit: {
            url: `${API}/repos/${full}/git/commits/${b.sha}`,
            author: null,
            committer: null,
            message: 'commit',
            comment_count: 0,
            tree: { sha: sha1('tree', b.sha), url: `${API}/repos/${full}/git/trees/${b.sha}` },
          },
        });
        return {
          status: 200,
          body: this.make('branch-with-protection', {
            name: p.branch,
            commit,
            _links: { html: `${WEB}/${full}/tree/${p.branch}`, self: `${API}/repos/${full}/branches/${p.branch}` },
            protected: false,
            protection: { enabled: false },
            protection_url: `${API}/repos/${full}/branches/${p.branch}/protection`,
          }),
        };
      }
      case 'GET /repos/{owner}/{repo}/contents/{path}': {
        const denied = need('contents', 'read');
        if (denied) return denied;
        const branch = typeof req.query.ref === 'string' ? req.query.ref : r.defaultBranch;
        const content = r.branches.get(branch)?.files.get(p.path!);
        if (content === undefined) return this.error(404, 'Not Found');
        return { status: 200, body: this.contentFile(full, p.path!, content) };
      }
      case 'PUT /repos/{owner}/{repo}/contents/{path}': {
        const denied = need('contents', 'write');
        if (denied) return denied;
        const branchName = (req.body.branch as string | undefined) ?? r.defaultBranch;
        const b = r.branches.get(branchName);
        if (!b) return this.error(404, 'Branch not found');
        const existing = b.files.get(p.path!);
        if (existing !== undefined && req.body.sha !== sha1('blob', existing)) {
          return this.error(409, `${p.path} does not match ${String(req.body.sha ?? '(no sha)')}`);
        }
        const content = Buffer.from(String(req.body.content), 'base64').toString('utf8');
        b.files.set(p.path!, content);
        b.sha = sha1('commit', b.sha, p.path!, content);
        const commit = this.make('file-commit', {}).commit as Obj;
        return {
          status: existing === undefined ? 201 : 200,
          body: {
            content: this.contentFile(full, p.path!, content, false) as Json,
            commit: {
              ...commit,
              sha: b.sha,
              message: req.body.message,
              html_url: `${WEB}/${full}/commit/${b.sha}`,
              url: `${API}/repos/${full}/git/commits/${b.sha}`,
            },
          } as Json,
        };
      }
      case 'GET /repos/{owner}/{repo}/pulls': {
        const denied = need('pull_requests', 'read');
        if (denied) return denied;
        const state = (req.query.state as string | undefined) ?? 'open';
        const list = r.pulls.filter((x) => state === 'all' || x.state === state).map((x) => this.simplePull(x));
        return { status: 200, body: list };
      }
      case 'POST /repos/{owner}/{repo}/pulls': {
        const denied = need('pull_requests', 'write');
        if (denied) return denied;
        const head = String(req.body.head);
        if (!r.branches.has(head))
          return this.error(422, 'Validation Failed', {
            errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
          });
        return {
          status: 201,
          body: this.makePull(
            r,
            head,
            String(req.body.base ?? r.defaultBranch),
            String(req.body.title ?? ''),
            String(req.body.body ?? ''),
            token.login,
          ),
        };
      }
      case 'GET /repos/{owner}/{repo}/pulls/{pull_number}': {
        const denied = need('pull_requests', 'read');
        if (denied) return denied;
        const pr = r.pulls[Number(p.pull_number) - 1];
        return pr ? { status: 200, body: pr } : this.error(404, 'Not Found');
      }
      case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': {
        const denied = need('pull_requests', 'read');
        if (denied) return denied;
        if (!r.pulls[Number(p.pull_number) - 1]) return this.error(404, 'Not Found');
        return { status: 200, body: r.pullFiles.get(Number(p.pull_number)) ?? [] };
      }
      case 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge': {
        const denied = need('contents', 'write');
        if (denied) return denied;
        const pr = r.pulls[Number(p.pull_number) - 1];
        if (!pr) return this.error(404, 'Not Found');
        if (pr.state !== 'open')
          return {
            status: 405,
            body: { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' },
          };
        const head = r.branches.get(pr.head.ref as string);
        const base = r.branches.get(pr.base.ref as string)!;
        if (head) {
          for (const [k, v] of head.files) base.files.set(k, v);
          base.sha = sha1('merge', base.sha, head.sha);
        }
        Object.assign(pr, {
          state: 'closed',
          merged: true,
          merged_at: this.now(),
          closed_at: this.now(),
          merge_commit_sha: base.sha,
          merged_by: this.user(token.login),
        });
        return { status: 200, body: { merged: true, message: 'Pull Request successfully merged', sha: base.sha } };
      }
      case 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': {
        const denied = need('issues', 'read') && need('pull_requests', 'read');
        if (denied) return denied;
        return { status: 200, body: r.comments.get(Number(p.issue_number)) ?? [] };
      }
      case 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': {
        const denied = need('issues', 'write') && need('pull_requests', 'write');
        if (denied) return denied;
        const n = Number(p.issue_number);
        if (!r.pulls[n - 1]) return this.error(404, 'Not Found');
        const id = this.id();
        const c = this.make('issue-comment', {
          id,
          node_id: b64(`IC_${id}`),
          url: `${API}/repos/${full}/issues/comments/${id}`,
          html_url: `${WEB}/${full}/pull/${n}#issuecomment-${id}`,
          issue_url: `${API}/repos/${full}/issues/${n}`,
          body: req.body.body,
          user: this.user(token.login, token.installationId ? 'Bot' : 'User'),
          created_at: this.now(),
          updated_at: this.now(),
          author_association: 'NONE',
        });
        r.comments.set(n, [...(r.comments.get(n) ?? []), c]);
        return { status: 201, body: c };
      }
      case 'POST /repos/{owner}/{repo}/check-runs': {
        const denied = need('checks', 'write');
        if (denied) return denied;
        const b = req.body;
        const run = this.checkRunObject(r, {
          id: this.id(),
          name: b.name,
          head_sha: b.head_sha,
          status: b.conclusion ? 'completed' : ((b.status as string | undefined) ?? 'queued'),
          conclusion: b.conclusion ?? null,
          details_url: b.details_url ?? null,
          external_id: b.external_id ?? null,
          completed_at: b.conclusion ? (b.completed_at ?? this.now()) : null,
          output: this.output(b.output as Obj | undefined),
        });
        r.checkRuns.push(run);
        return { status: 201, body: run };
      }
      case 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': {
        const denied = need('checks', 'write');
        if (denied) return denied;
        const run = r.checkRuns.find((c) => c.id === Number(p.check_run_id));
        if (!run) return this.error(404, 'Not Found');
        const b = req.body;
        for (const f of ['name', 'details_url', 'external_id', 'status', 'conclusion'] as const)
          if (f in b) run[f] = b[f];
        if (b.conclusion) {
          run.status = 'completed';
          run.completed_at = b.completed_at ?? this.now();
        }
        if (b.output) run.output = this.output(b.output as Obj);
        return { status: 200, body: run };
      }
      case 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}': {
        const denied = need('checks', 'read');
        if (denied) return denied;
        const run = r.checkRuns.find((c) => c.id === Number(p.check_run_id));
        return run ? { status: 200, body: run } : this.error(404, 'Not Found');
      }
      case 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': {
        const denied = need('checks', 'read');
        if (denied) return denied;
        const sha = r.branches.get(p.ref!)?.sha ?? p.ref;
        const runs = r.checkRuns.filter(
          (c) => c.head_sha === sha && (!req.query.check_name || c.name === req.query.check_name),
        );
        return { status: 200, body: { total_count: runs.length, check_runs: runs } };
      }
      default:
        return this.error(404, `The GitHub fake does not implement ${key}`);
    }
  }

  private output(o: Obj | undefined): Obj {
    return {
      title: o?.title ?? null,
      summary: o?.summary ?? null,
      text: o?.text ?? null,
      annotations_count: Array.isArray(o?.annotations) ? o.annotations.length : 0,
      annotations_url: `${API}/annotations`,
    };
  }

  private simplePull(pr: Obj): Obj {
    const props = (this.contract.schema('pull-request-simple').properties ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(pr).filter(([k]) => k in props));
  }

  private contentFile(full: string, path: string, content: string, withContent = true): Obj {
    const sha = sha1('blob', content);
    const name = path.split('/').pop()!;
    const url = `${API}/repos/${full}/contents/${path}`;
    const html = `${WEB}/${full}/blob/main/${path}`;
    const git = `${API}/repos/${full}/git/blobs/${sha}`;
    const base = {
      type: 'file',
      name,
      path,
      sha,
      size: Buffer.byteLength(content),
      url,
      html_url: html,
      git_url: git,
      download_url: `https://raw.githubusercontent.com/${full}/main/${path}`,
      _links: { self: url, git, html },
    };
    return withContent ? { ...base, encoding: 'base64', content: b64(content) } : base;
  }
}
