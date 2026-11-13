import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findConfigFile, tryLoadConfig } from '@sluice-dev/config';
import type { CommandSpec, PluginContext } from '@sluice-dev/plugin-api';
import { AuditLog, CredentialBroker, verifyAuditLog, type Upstream } from '@sluice-dev/policy';

function policyPaths(ctx: PluginContext) {
  const loaded = tryLoadConfig(ctx.cwd);
  const root = loaded?.root ?? (findConfigFile(ctx.cwd) ? dirname(findConfigFile(ctx.cwd)!) : ctx.cwd);
  const p = loaded?.config.policy ?? {
    stepUp: [],
    maxTtlSec: 3600,
    db: '.sluice/state/broker.db',
    audit: '.sluice/state/audit.jsonl',
  };
  const db = resolve(root, p.db);
  mkdirSync(dirname(db), { recursive: true });
  return { db, audit: resolve(root, p.audit), stepUp: p.stepUp, maxTtlSec: p.maxTtlSec };
}

function openBroker(
  ctx: PluginContext,
  upstreams: Partial<Record<'github' | 'stripe', Upstream>> = {},
): CredentialBroker {
  const p = policyPaths(ctx);
  return new CredentialBroker({
    db: p.db,
    audit: new AuditLog(p.audit),
    upstreams,
    stepUp: p.stepUp,
    maxTtlSec: p.maxTtlSec,
  });
}

export const policyCommands: CommandSpec[] = [
  {
    path: ['policy', 'serve'],
    summary:
      'Run the credential broker proxy (/github/*, /v1/* for Stripe); real credentials come from the environment',
    options: [{ flags: '--port <n>', description: 'port (127.0.0.1)', default: '4700' }],
    async run({ options }, ctx) {
      const up: Partial<Record<'github' | 'stripe', Upstream>> = {};
      if (ctx.env.SLUICE_UPSTREAM_GITHUB_TOKEN)
        up.github = {
          baseUrl: ctx.env.SLUICE_UPSTREAM_GITHUB_URL ?? 'https://api.github.com',
          token: ctx.env.SLUICE_UPSTREAM_GITHUB_TOKEN,
        };
      if (ctx.env.SLUICE_UPSTREAM_STRIPE_KEY)
        up.stripe = {
          baseUrl: ctx.env.SLUICE_UPSTREAM_STRIPE_URL ?? 'https://api.stripe.com',
          token: ctx.env.SLUICE_UPSTREAM_STRIPE_KEY,
        };
      const broker = openBroker(ctx, up);
      const url = await broker.listen(Number(options.port));
      ctx.stdout.write(
        `Sluice broker on ${url} (github: ${up.github ? 'yes' : 'no'}, stripe: ${up.stripe ? 'yes' : 'no'})\n`,
      );
      await new Promise<void>((r) => process.once('SIGINT', () => r()));
      await broker.close();
      return 0;
    },
  },
  {
    path: ['policy', 'grant'],
    summary: 'Issue a task-scoped, short-lived broker token for an agent',
    options: [
      { flags: '--task <id>', description: 'task id', required: true },
      { flags: '--agent <name>', description: 'agent identity', required: true },
      { flags: '--scope <scope...>', description: 'scopes, e.g. github:acme/app:contents:read', required: true },
      { flags: '--ttl <seconds>', description: 'time to live', default: '900' },
      { flags: '--max-requests <n>', description: 'request cap' },
      { flags: '--max-writes <n>', description: 'write cap' },
      { flags: '--max-usd <n>', description: 'spend cap (USD)' },
      { flags: '--json', description: 'JSON output' },
    ],
    run({ options }, ctx) {
      const broker = openBroker(ctx);
      const num = (v: unknown) => (v === undefined ? undefined : Number(v));
      const { token, grant } = broker.issue({
        task: String(options.task),
        agent: String(options.agent),
        scopes: options.scope as string[],
        ttlSec: Number(options.ttl),
        caps: { requests: num(options.maxRequests), writes: num(options.maxWrites), usd: num(options.maxUsd) },
      });
      ctx.stdout.write(
        options.json
          ? JSON.stringify({ token, grant }) + '\n'
          : `${token}\n# ${grant.id} expires ${new Date(grant.expiresAt).toISOString()}\n`,
      );
      return 0;
    },
  },
  {
    path: ['policy', 'approvals'],
    summary: 'List step-up approval requests',
    options: [{ flags: '--all', description: 'include decided requests' }],
    run({ options }, ctx) {
      const list = openBroker(ctx).approvals(options.all ? undefined : 'pending');
      for (const a of list)
        ctx.stdout.write(
          `${a.id} [${a.status}] ${a.agent} (task ${a.task}) wants ${a.method} ${a.path} — ${a.scope}\n`,
        );
      if (!list.length) ctx.stdout.write('no pending approvals\n');
      return 0;
    },
  },
  ...(['approve', 'deny'] as const).map((verb): CommandSpec => ({
    path: ['policy', verb],
    summary: `${verb === 'approve' ? 'Approve' : 'Deny'} a step-up request (human only; single use)`,
    args: [{ name: 'id', required: true }],
    options: [{ flags: '--as <name>', description: 'approver identity', required: true }],
    run({ args, options }, ctx) {
      const a = openBroker(ctx).decide(args[0]!, verb === 'approve' ? 'approved' : 'denied', String(options.as));
      ctx.stdout.write(`${a.id} ${a.status} by ${a.decidedBy}\n`);
      return 0;
    },
  })),
  {
    path: ['policy', 'audit'],
    summary: 'Verify the tamper-evident audit log (exit 1 if the hash chain is broken)',
    run(_i, ctx) {
      const p = policyPaths(ctx);
      const v = verifyAuditLog(p.audit);
      ctx.stdout.write(v.ok ? `audit log ok: ${p.audit}\n` : `audit log BROKEN at entry ${v.brokenAt}: ${v.reason}\n`);
      return v.ok ? 0 : 1;
    },
  },
];
