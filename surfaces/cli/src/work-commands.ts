import { dirname } from 'node:path';
import { findConfigFile } from '@sluice-dev/config';
import type { CommandSpec, PluginContext, ToolSpec } from '@sluice-dev/plugin-api';
import { openWorkspace, type Task, type WorkQueue } from '@sluice-dev/work';

async function withQueue<T>(ctx: PluginContext, fn: (q: WorkQueue) => Promise<T>): Promise<T> {
  const f = findConfigFile(ctx.cwd);
  const ws = await openWorkspace(
    f ? dirname(f) : ctx.cwd,
    (ctx.sluiceConfig?.work as { url?: string } | undefined)?.url,
  );
  try {
    return await fn(ws.queue);
  } finally {
    await ws.close();
  }
}

const show = (t: Task) =>
  `${t.id} [${t.status}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}${t.deps.length ? ` deps:${t.deps.join(',')}` : ''}${t.blockedOn.length ? ` waiting:${t.blockedOn.join(',')}` : ''}`;

export const workCommands: CommandSpec[] = [
  {
    path: ['work', 'add'],
    summary: 'Add a task (with dependencies)',
    args: [{ name: 'title', required: true }],
    options: [
      { flags: '--id <id>', description: 'task id' },
      { flags: '--dep <id...>', description: 'tasks this depends on' },
      { flags: '--priority <n>', description: 'higher first', default: '0' },
    ],
    run({ args, options }, ctx) {
      return withQueue(ctx, async (q) => {
        ctx.stdout.write(
          show(
            await q.add({
              id: options.id as string | undefined,
              title: args[0]!,
              deps: options.dep as string[] | undefined,
              priority: Number(options.priority),
            }),
          ) + '\n',
        );
        return 0;
      });
    },
  },
  {
    path: ['work', 'list'],
    summary: 'List tasks',
    options: [{ flags: '--status <s>', description: 'filter by status' }],
    run({ options }, ctx) {
      return withQueue(ctx, async (q) => {
        for (const t of await q.list({ status: options.status as Task['status'] | undefined }))
          ctx.stdout.write(show(t) + '\n');
        return 0;
      });
    },
  },
  {
    path: ['work', 'claim'],
    summary: 'Claim the next ready task (or --task) for an agent',
    options: [
      { flags: '--agent <name>', description: 'agent', required: true },
      { flags: '--task <id>', description: 'specific task' },
    ],
    run({ options }, ctx) {
      return withQueue(ctx, async (q) => {
        const t = await q.claim(String(options.agent), options.task as string | undefined);
        ctx.stdout.write(t ? show(t) + '\n' : 'nothing ready\n');
        return t ? 0 : 1;
      });
    },
  },
  ...(['start', 'submit', 'release'] as const).map((verb): CommandSpec => ({
    path: ['work', verb],
    summary: `${verb[0]!.toUpperCase()}${verb.slice(1)} a task (agent)`,
    args: [{ name: 'task', required: true }],
    options: [{ flags: '--agent <name>', description: 'agent', required: true }],
    run({ args, options }, ctx) {
      return withQueue(ctx, async (q) => {
        ctx.stdout.write(show(await q[verb](args[0]!, String(options.agent))) + '\n');
        return 0;
      });
    },
  })),
  {
    path: ['work', 'approve'],
    summary: 'Mark a reviewed task done (promotes dependents)',
    args: [{ name: 'task', required: true }],
    options: [{ flags: '--as <name>', description: 'reviewer', required: true }],
    run({ args, options }, ctx) {
      return withQueue(ctx, async (q) => {
        ctx.stdout.write(show(await q.approve(args[0]!, String(options.as))) + '\n');
        return 0;
      });
    },
  },
];

export const workTools: ToolSpec[] = [
  {
    name: 'sluice_work_claim',
    description: 'Claim the next ready task from the shared work queue (atomic: no two agents get the same task).',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' }, task: { type: 'string' } },
      required: ['agent'],
      additionalProperties: false,
    },
    run(input, ctx) {
      return withQueue(ctx, async (q) => ({
        content: { task: (await q.claim(String(input.agent), input.task as string | undefined)) ?? null },
      }));
    },
  },
  {
    name: 'sluice_work_update',
    description: 'Move your task: start | submit (for review) | release | fail.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        task: { type: 'string' },
        action: { enum: ['start', 'submit', 'release', 'fail'] },
        note: { type: 'string' },
      },
      required: ['agent', 'task', 'action'],
      additionalProperties: false,
    },
    run(input, ctx) {
      return withQueue(ctx, async (q) => {
        const a = String(input.action);
        const t =
          a === 'fail'
            ? await q.fail(String(input.task), String(input.agent), String(input.note ?? 'failed'))
            : await q[a as 'start' | 'submit' | 'release'](String(input.task), String(input.agent));
        return { content: { task: t } };
      });
    },
  },
];
