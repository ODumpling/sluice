import { dirname } from 'node:path';
import { findConfigFile } from '@sluice-dev/config';
import { definePlugin, type PluginContext } from '@sluice-dev/plugin-api';
import { openWorkspace } from '@sluice-dev/work';
import { Inbox, type DecisionKind } from './inbox.js';

export * from './inbox.js';

export async function openInbox(ctx: PluginContext) {
  const f = findConfigFile(ctx.cwd);
  const root = f ? dirname(f) : ctx.cwd;
  const url = (ctx.sluiceConfig?.work as { url?: string } | undefined)?.url;
  const ws = await openWorkspace(root, url);
  const inbox = await Inbox.open(ws.db, { queue: ws.queue });
  return { inbox, ws };
}

async function withInbox<T>(ctx: PluginContext, fn: (i: Inbox) => Promise<T>): Promise<T> {
  const { inbox, ws } = await openInbox(ctx);
  try {
    return await fn(inbox);
  } finally {
    await ws.close();
  }
}

export default definePlugin({
  name: '@sluice-dev/plugin-inbox',
  version: '0.2.0',
  apiVersion: '^1.0.0',
  description: 'Typed decision requests: dedupe, human answers, propagation to blocked tasks',
  activate(ctx) {
    // Other plugins (leases) post notifications through this service.
    ctx.services.provide('inbox', {
      notify: (n: { toAgent: string; task?: string; kind: string; message: string; data?: Record<string, unknown> }) =>
        withInbox(ctx, (i) => i.notify(n).then(() => undefined)),
    });
  },
  commands: [
    {
      path: ['inbox', 'list'],
      summary: 'List open decision requests (and notifications for --agent)',
      options: [
        { flags: '--all', description: 'include answered decisions' },
        { flags: '--agent <name>', description: 'also show notifications for this agent' },
        { flags: '--json', description: 'JSON output' },
      ],
      run({ options }, ctx) {
        return withInbox(ctx, async (i) => {
          const decisions = await i.list(options.all ? undefined : 'open');
          const notes =
            typeof options.agent === 'string' ? await i.notifications(options.agent, { markRead: false }) : [];
          if (options.json) ctx.stdout.write(JSON.stringify({ decisions, notifications: notes }, null, 2) + '\n');
          else {
            for (const d of decisions) {
              ctx.stdout.write(
                `${d.id} [${d.status}] (${d.kind}) ${d.question}${d.options.length ? ` [${d.options.join(' | ')}]` : ''}\n    asked by ${d.askedBy.join(', ')}; blocks ${d.affectedTasks.join(', ') || 'no tasks'}${d.status === 'answered' ? `; answer: ${JSON.stringify(d.answer)} by ${d.answeredBy}` : ''}\n`,
              );
            }
            for (const n of notes) ctx.stdout.write(`${n.id} -> ${n.toAgent}: ${n.message}\n`);
            if (!decisions.length && !notes.length) ctx.stdout.write('inbox empty\n');
          }
          return 0;
        });
      },
    },
    {
      path: ['inbox', 'ask'],
      summary: 'Ask a typed question for a task (the task blocks until a human answers)',
      options: [
        { flags: '--agent <name>', description: 'asking agent', required: true },
        { flags: '--task <id>', description: 'task that is blocked on the answer' },
        { flags: '--kind <kind>', description: 'choice | confirm | text', default: 'text' },
        { flags: '--question <text>', description: 'the question', required: true },
        { flags: '--option <value...>', description: 'options for a choice' },
        { flags: '--key <dedupe-key>', description: 'explicit dedupe key' },
      ],
      run({ options }, ctx) {
        return withInbox(ctx, async (i) => {
          const r = await i.ask({
            agent: String(options.agent),
            task: options.task as string | undefined,
            kind: String(options.kind) as DecisionKind,
            question: String(options.question),
            options: options.option as string[] | undefined,
            dedupeKey: options.key as string | undefined,
          });
          ctx.stdout.write(
            `${r.decision.id}${r.deduped ? ' (deduplicated with an existing request)' : ''}${r.alreadyAnswered ? ` already answered: ${JSON.stringify(r.decision.answer)}` : ''}\n`,
          );
          return 0;
        });
      },
    },
    {
      path: ['inbox', 'answer'],
      summary: 'Answer a decision (human); the answer propagates to every blocked task',
      args: [
        { name: 'id', required: true },
        { name: 'answer', required: true },
      ],
      options: [{ flags: '--as <name>', description: 'who is answering', required: true }],
      run({ args, options }, ctx) {
        return withInbox(ctx, async (i) => {
          const { decision, tasks } = await i.answer(args[0]!, args[1]!, String(options.as));
          ctx.stdout.write(
            `${decision.id} answered ${JSON.stringify(decision.answer)}; resumed: ${tasks.map((t) => `${t.id} (${t.status})`).join(', ') || 'none'}\n`,
          );
          return 0;
        });
      },
    },
  ],
  tools: [
    {
      name: 'sluice_inbox_ask',
      description:
        'Ask a human a typed question instead of guessing (kind: choice|confirm|text). Your task is parked until it is answered; identical questions from other agents are merged. Poll sluice_inbox_check for the answer.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task: { type: 'string' },
          kind: { enum: ['choice', 'confirm', 'text'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          context: { type: 'object' },
        },
        required: ['agent', 'kind', 'question'],
        additionalProperties: false,
      },
      run(input, ctx) {
        return withInbox(ctx, async (i) => {
          const r = await i.ask(input as never);
          return {
            content: {
              decision: r.decision.id,
              deduped: r.deduped,
              status: r.decision.status,
              answer: r.decision.answer,
            },
          };
        });
      },
    },
    {
      name: 'sluice_inbox_check',
      description:
        'Get answers to your decision requests and notifications addressed to you (e.g. an interface you depend on changed).',
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string' } },
        required: ['agent'],
        additionalProperties: false,
      },
      run(input, ctx) {
        return withInbox(ctx, async (i) => {
          const agent = String(input.agent);
          const decisions = (await i.list()).filter((d) => d.askedBy.includes(agent));
          return {
            content: {
              decisions: decisions.map((d) => ({ id: d.id, question: d.question, status: d.status, answer: d.answer })),
              notifications: await i.notifications(agent, { unreadOnly: true }),
            },
          };
        });
      },
    },
  ],
});
