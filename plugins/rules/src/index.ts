import { resolve } from 'node:path';
import { findConfigFile } from '@sluice-dev/config';
import { GitHubClient, parseRepo } from '@sluice-dev/github-api';
import { definePlugin, type PluginContext } from '@sluice-dev/plugin-api';
import { onChangedLines, scanTree, type Finding } from '@sluice-dev/policy';
import { changedLines, checkoutRef, git } from '@sluice-dev/sandbox';
import { proposeFromComment, proveRule, RuleStore, type ReviewComment } from './rules.js';

export * from './rules.js';

function projectRoot(ctx: PluginContext): string {
  const f = findConfigFile(ctx.cwd);
  return f ? resolve(f, '..') : ctx.cwd;
}

/** Run active rules on a ref (whole tree) or only on lines changed base..head. */
export async function checkRules(root: string, o: { base?: string; head?: string } = {}): Promise<Finding[]> {
  const rules = new RuleStore(root).list('active');
  if (!rules.length) return [];
  const top = (await git(['rev-parse', '--show-toplevel'], root)).trim();
  if (!o.head) return scanTree(rules, root);
  const co = await checkoutRef(top, o.head);
  try {
    const all = scanTree(rules, co.dir);
    return o.base ? onChangedLines(all, await changedLines(top, o.base, co.sha)) : all;
  } finally {
    await co.remove();
  }
}

function printFindings(ctx: PluginContext, findings: Finding[]): void {
  for (const f of findings)
    ctx.stdout.write(
      `${f.file}:${f.line}:${f.column} ${f.severity} [${f.rule}] ${f.message}\n    ${f.text.split('\n')[0]}\n`,
    );
}

export default definePlugin({
  name: '@sluice-dev/plugin-rules',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  description: 'Review comment -> proposed rule -> proven on the bad commit and clean on main',
  commands: [
    {
      path: ['rules', 'propose'],
      summary: 'Propose structural rules from a review comment',
      options: [
        { flags: '--comment <text>', description: 'review comment text', required: true },
        { flags: '--path <file>', description: 'file the comment is on' },
        { flags: '--line <n>', description: 'line the comment is on' },
        { flags: '--commit <ref>', description: 'commit the comment was made on (to read the commented code)' },
      ],
      async run({ options }, ctx) {
        const root = projectRoot(ctx);
        const c: ReviewComment = {
          body: String(options.comment),
          path: options.path as string | undefined,
          line: options.line ? Number(options.line) : undefined,
        };
        const source =
          c.path && options.commit
            ? await git(['show', `${String(options.commit)}:${c.path}`], root).catch(() => undefined)
            : undefined;
        const rules = proposeFromComment(c, { sourceAtPath: source });
        const store = new RuleStore(root);
        for (const r of rules) ctx.stdout.write(`proposed ${r.id}: ${r.pattern} -> ${store.save(r, 'proposed')}\n`);
        if (!rules.length) ctx.stderr.write('no code pattern found in the comment\n');
        return rules.length ? 0 : 1;
      },
    },
    {
      path: ['rules', 'from-pr'],
      summary: 'Propose rules from a pull request’s review comments (GitHub API; GITHUB_TOKEN)',
      options: [
        { flags: '--repo <owner/name>', description: 'repository', required: true },
        { flags: '--pr <n>', description: 'pull request number', required: true },
      ],
      async run({ options }, ctx) {
        const { owner, repo } = parseRepo(String(options.repo));
        const token = ctx.env.SLUICE_GITHUB_TOKEN ?? ctx.env.GITHUB_TOKEN;
        if (!token) throw new Error('GITHUB_TOKEN required');
        const gh = new GitHubClient({ baseUrl: ctx.env.GITHUB_API_URL, token });
        const comments = await gh.request<{ body: string; user: { login: string }; html_url: string }[]>(
          'GET',
          `/repos/${owner}/${repo}/issues/${Number(options.pr)}/comments`,
        );
        const store = new RuleStore(projectRoot(ctx));
        let n = 0;
        for (const c of comments) {
          for (const r of proposeFromComment({ body: c.body, author: c.user.login, url: c.html_url })) {
            store.save(r, 'proposed');
            ctx.stdout.write(`proposed ${r.id} from ${c.user.login}: ${r.pattern}\n`);
            n++;
          }
        }
        return n ? 0 : 1;
      },
    },
    {
      path: ['rules', 'prove'],
      summary: 'Prove a proposed rule: it must flag the bad commit and be clean on main; adopt it if so',
      args: [{ name: 'id', required: true }],
      options: [
        { flags: '--bad <ref>', description: 'the commit the review comment was about', required: true },
        { flags: '--main <ref>', description: 'mainline ref that must stay clean', default: 'main' },
      ],
      async run({ args, options }, ctx) {
        const root = projectRoot(ctx);
        const store = new RuleStore(root);
        const rule = store.get(args[0]!, 'proposed') ?? store.get(args[0]!, 'active');
        if (!rule) throw new Error(`no proposed rule ${args[0]}`);
        const proof = await proveRule(rule, { repo: root, bad: String(options.bad), main: String(options.main) });
        ctx.stdout.write(`${proof.proven ? 'PROVEN' : 'REJECTED'} ${rule.id}: ${proof.reason}\n`);
        printFindings(ctx, proof.bad.findings);
        if (proof.proven) ctx.stdout.write(`adopted -> ${store.adopt(rule, proof)}\n`);
        return proof.proven ? 0 : 1;
      },
    },
    {
      path: ['rules', 'check'],
      summary: 'Run adopted rules on the tree, a ref, or only lines changed base..head (exit 1 on errors)',
      options: [
        { flags: '--base <ref>', description: 'only report lines changed since base' },
        { flags: '--head <ref>', description: 'ref to check (default: working tree)' },
        { flags: '--json', description: 'JSON output' },
      ],
      async run({ options }, ctx) {
        const findings = await checkRules(projectRoot(ctx), {
          base: options.base as string | undefined,
          head: options.head as string | undefined,
        });
        if (options.json) ctx.stdout.write(JSON.stringify(findings, null, 2) + '\n');
        else printFindings(ctx, findings);
        return findings.some((f) => f.severity === 'error') ? 1 : 0;
      },
    },
  ],
  tools: [
    {
      name: 'sluice_rules_check',
      description:
        'Check your change against the team’s adopted review rules (structural patterns learned from past review comments).',
      inputSchema: {
        type: 'object',
        properties: { base: { type: 'string' }, head: { type: 'string' } },
        additionalProperties: false,
      },
      async run(input, ctx) {
        const findings = await checkRules(projectRoot(ctx), {
          base: input.base as string | undefined,
          head: input.head as string | undefined,
        });
        return { content: { findings }, isError: findings.some((f) => f.severity === 'error') };
      },
    },
  ],
});
