import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { findConfigFile } from '@sluice-dev/config';
import { definePlugin, type PluginContext } from '@sluice-dev/plugin-api';
import { git } from '@sluice-dev/sandbox';
import { runGate, type GateConfig, type GateReport } from './gate.js';
import { postCheckRun, renderText, writeReport } from './report.js';
import { parseScenarios } from './scenario.js';
import { GateStore } from './store.js';

export * from './gate.js';
export * from './report.js';
export * from './scenario.js';
export * from './store.js';
export * from './matchers.js';
export * from './mutation.js';
export { runScenario, type ScenarioRun, type Failure } from './runner.js';

function projectRoot(ctx: PluginContext): string {
  const f = findConfigFile(ctx.cwd);
  if (!f) throw new Error('no sluice.yaml found (run sluice init)');
  return resolve(f, '..');
}

function store(ctx: PluginContext): GateStore {
  return new GateStore(projectRoot(ctx));
}

async function approver(ctx: PluginContext, explicit: unknown): Promise<string> {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (ctx.env.SLUICE_APPROVER) return ctx.env.SLUICE_APPROVER;
  const name = (await git(['config', 'user.email'], ctx.cwd).catch(() => '')).trim();
  if (!name) throw new Error('who is approving? pass --as <name> (or set SLUICE_APPROVER / git user.email)');
  return name;
}

/** Spec -> scenarios via an external generator (any agent CLI): ticket YAML on stdin, scenario YAML docs on stdout. */
function runProposer(command: string, input: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(`proposer exited ${code}: ${err.trim()}`)),
    );
    child.stdin.end(input);
  });
}

export function gateConfig(ctx: PluginContext): GateConfig {
  return ctx.config as GateConfig;
}

export interface GateRunCliOptions {
  ticket: string;
  base: string;
  head: string;
  reportDir?: string;
  githubCheck?: boolean;
  repo?: string;
}

/** Run the gate, write the HTML/JSON artifact and optionally post a GitHub check. Shared by CLI, MCP and the GitHub surfaces. */
export async function gateRunAndPublish(
  ctx: PluginContext,
  o: GateRunCliOptions,
): Promise<{ report: GateReport; files: { json: string; html: string }; checkRun?: { id: number; html_url: string } }> {
  const root = projectRoot(ctx);
  const cfg = gateConfig(ctx);
  const report = await runGate({
    ...cfg,
    projectRoot: root,
    ticket: o.ticket,
    base: o.base,
    head: o.head,
    log: (m) => ctx.logger.info(m),
  });
  const files = writeReport(report, o.reportDir ? resolve(ctx.cwd, o.reportDir) : join(root, '.sluice', 'reports'));
  let checkRun: { id: number; html_url: string } | undefined;
  if (o.githubCheck) {
    const repo = o.repo ?? ctx.env.GITHUB_REPOSITORY;
    const token = ctx.env.SLUICE_GITHUB_TOKEN ?? ctx.env.GITHUB_TOKEN;
    if (!repo || !token) throw new Error('--github-check needs --repo (or GITHUB_REPOSITORY) and GITHUB_TOKEN');
    const runUrl =
      ctx.env.GITHUB_SERVER_URL && ctx.env.GITHUB_RUN_ID
        ? `${ctx.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${ctx.env.GITHUB_RUN_ID}`
        : undefined;
    checkRun = await postCheckRun(report, { repo, token, baseUrl: ctx.env.GITHUB_API_URL, reportUrl: runUrl });
  }
  return { report, files, checkRun };
}

export default definePlugin({
  name: '@sluice-dev/plugin-gate',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  description: 'Spec -> scenarios -> human approval -> black-box checks -> mutation proof -> GitHub check',
  commands: [
    {
      path: ['gate', 'ticket'],
      summary: 'Create or update a ticket (the spec scenarios are written against)',
      args: [{ name: 'id', required: true }],
      options: [
        { flags: '--title <title>', description: 'ticket title', required: true },
        { flags: '--spec <text>', description: 'spec text' },
        { flags: '--spec-file <file>', description: 'read spec from a file' },
      ],
      run({ args, options }, ctx) {
        const spec =
          typeof options.specFile === 'string'
            ? readFileSync(resolve(ctx.cwd, options.specFile), 'utf8')
            : String(options.spec ?? '');
        store(ctx).writeTicket({ id: args[0]!, title: String(options.title), spec });
        ctx.stdout.write(`ticket ${args[0]} saved\n`);
        return 0;
      },
    },
    {
      path: ['gate', 'propose'],
      summary:
        'Propose acceptance scenarios for a ticket (from YAML files or a generator command); they need human approval',
      args: [
        { name: 'ticket', required: true },
        { name: 'files', variadic: true, description: 'scenario YAML files (one or more documents each)' },
      ],
      options: [
        {
          flags: '--command <cmd>',
          description: 'generator: receives the ticket as YAML on stdin, prints scenario YAML',
        },
      ],
      async run({ args, options }, ctx) {
        const st = store(ctx);
        const [ticket, ...files] = args;
        const drafts = files.flatMap((f) => parseScenarios(readFileSync(resolve(ctx.cwd, f), 'utf8'), f));
        if (typeof options.command === 'string') {
          const t = st.readTicket(ticket!);
          const out = await runProposer(options.command, toYaml({ ticket: t }), ctx.cwd);
          drafts.push(...parseScenarios(out, 'generator output'));
        }
        if (!drafts.length) {
          ctx.stderr.write('nothing to propose (pass files or --command)\n');
          return 1;
        }
        const saved = st.propose(ticket!, drafts);
        ctx.stdout.write(
          `proposed ${saved.length} scenario(s) for ${ticket}: ${saved.map((s) => s.id).join(', ')}\nreview them, then: sluice gate approve ${ticket}\n`,
        );
        return 0;
      },
    },
    {
      path: ['gate', 'status'],
      summary: 'Show scenarios of a ticket and their approval status',
      args: [{ name: 'ticket', required: true }],
      options: [{ flags: '--json', description: 'JSON output' }],
      run({ args, options }, ctx) {
        const st = store(ctx);
        const t = st.readTicket(args[0]!);
        const states = st.state(args[0]!);
        if (options.json) {
          ctx.stdout.write(
            JSON.stringify(
              {
                ticket: t,
                scenarios: states.map((s) => ({
                  id: s.scenario.id,
                  title: s.scenario.title,
                  status: s.status,
                  sha256: s.sha256,
                  approvedBy: s.approval?.approvedBy,
                })),
              },
              null,
              2,
            ) + '\n',
          );
          return 0;
        }
        ctx.stdout.write(`${t.id}: ${t.title}\n`);
        for (const s of states)
          ctx.stdout.write(
            `  [${s.status}] ${s.scenario.id} — ${s.scenario.title}${s.approval ? ` (by ${s.approval.approvedBy})` : ''}\n`,
          );
        return 0;
      },
    },
    {
      path: ['gate', 'approve'],
      summary: 'Approve scenarios (human only — not exposed to agents over MCP)',
      args: [{ name: 'ticket', required: true }],
      options: [
        { flags: '--scenario <id...>', description: 'approve only these scenarios' },
        { flags: '--as <name>', description: 'approver identity (default: SLUICE_APPROVER or git user.email)' },
      ],
      async run({ args, options }, ctx) {
        const who = await approver(ctx, options.as);
        const added = store(ctx).approve(args[0]!, who, options.scenario as string[] | undefined);
        ctx.stdout.write(`${who} approved ${added.length} scenario(s): ${added.map((a) => a.scenario).join(', ')}\n`);
        return 0;
      },
    },
    {
      path: ['gate', 'run'],
      summary: 'Judge a change against approved scenarios: black-box checks, behavior diff vs base, mutation proof',
      options: [
        { flags: '--ticket <id>', description: 'ticket whose approved scenarios gate the change', required: true },
        { flags: '--base <ref>', description: 'base git ref', default: 'origin/main' },
        { flags: '--head <ref>', description: 'head git ref', default: 'HEAD' },
        { flags: '--report-dir <dir>', description: 'where to write the HTML/JSON report' },
        { flags: '--github-check', description: 'post the result as a GitHub check run (GITHUB_TOKEN, --repo)' },
        { flags: '--repo <owner/name>', description: 'GitHub repository for --github-check' },
        { flags: '--json', description: 'print the JSON report' },
      ],
      async run({ options }, ctx) {
        const { report, files, checkRun } = await gateRunAndPublish(ctx, {
          ticket: String(options.ticket),
          base: String(options.base),
          head: String(options.head),
          reportDir: options.reportDir as string | undefined,
          githubCheck: options.githubCheck === true,
          repo: options.repo as string | undefined,
        });
        if (options.json) ctx.stdout.write(JSON.stringify(report, null, 2) + '\n');
        else {
          ctx.stdout.write(renderText(report));
          ctx.stdout.write(`  report: ${files.html}\n`);
          if (checkRun) ctx.stdout.write(`  check run: ${checkRun.html_url}\n`);
        }
        return report.verdict === 'pass' ? 0 : 1;
      },
    },
  ],
  tools: [
    {
      name: 'sluice_gate_status',
      description:
        'Get a ticket spec and the approval status of its acceptance scenarios. Use before working on a ticket.',
      inputSchema: {
        type: 'object',
        properties: { ticket: { type: 'string' } },
        required: ['ticket'],
        additionalProperties: false,
      },
      run(input, ctx) {
        const st = store(ctx);
        const t = st.readTicket(String(input.ticket));
        return {
          content: {
            ticket: t,
            scenarios: st
              .state(t.id)
              .map((s) => ({ id: s.scenario.id, title: s.scenario.title, status: s.status, scenario: s.scenario })),
          },
        };
      },
    },
    {
      name: 'sluice_gate_propose_scenarios',
      description:
        'Propose acceptance scenarios for a ticket. Each scenario: {id, title, steps[]} where steps are http/advance/clock steps with optional expect {status, body}, or assert {fake|sql|egress}. Proposals must be approved by a human before they gate anything; you cannot approve them.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket: { type: 'string' },
          scenarios: { type: 'array', items: { type: 'object' }, minItems: 1 },
        },
        required: ['ticket', 'scenarios'],
        additionalProperties: false,
      },
      run(input, ctx) {
        try {
          const saved = store(ctx).propose(String(input.ticket), input.scenarios as unknown[]);
          return {
            content: {
              proposed: saved.map((s) => s.id),
              next: 'ask a human to run: sluice gate approve ' + String(input.ticket),
            },
          };
        } catch (e) {
          return { content: { error: (e as Error).message }, isError: true };
        }
      },
    },
    {
      name: 'sluice_gate_run',
      description:
        'Run the gate for a ticket on base..head git refs. Returns verdict, violated scenarios, behavior diff and mutation proof summary.',
      inputSchema: {
        type: 'object',
        properties: { ticket: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' } },
        required: ['ticket', 'base', 'head'],
        additionalProperties: false,
      },
      async run(input, ctx) {
        const { report, files } = await gateRunAndPublish(ctx, {
          ticket: String(input.ticket),
          base: String(input.base),
          head: String(input.head),
        });
        return {
          content: {
            verdict: report.verdict,
            reasons: report.reasons,
            scenarios: report.scenarios.map((s) => ({
              id: s.id,
              passed: s.passed,
              failures: s.failures,
              diff: s.diff.slice(0, 20),
            })),
            mutation: { killed: report.mutation.killed, total: report.mutation.total },
            report: files.html,
          },
          isError: report.verdict !== 'pass',
        };
      },
    },
  ],
});
