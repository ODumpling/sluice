import { resolve } from 'node:path';
import { definePlugin } from '@sluice-dev/plugin-api';
import { loadCampaign, readState, renderStatus, rollbackStep, runCampaign } from './campaign.js';

export * from './campaign.js';
export * from './codemod.js';

export default definePlugin({
  name: '@sluice-dev/plugin-campaign',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  description: 'Multi-repo migrations with evidence-gated steps and rollback',
  commands: [
    {
      path: ['campaign', 'run'],
      summary: 'Run (or resume) a campaign; every step is evidence-gated, failures roll back and halt',
      args: [{ name: 'file', required: true }],
      options: [{ flags: '--until <step>', description: 'stop after this step' }],
      async run({ args, options }, ctx) {
        const c = loadCampaign(resolve(ctx.cwd, args[0]!));
        const s = await runCampaign(c, {
          until: options.until as string | undefined,
          log: (m) => ctx.stdout.write(m + '\n'),
        });
        ctx.stdout.write(renderStatus(c, s));
        return s.status === 'completed' || (options.until && s.status === 'running') ? 0 : 1;
      },
    },
    {
      path: ['campaign', 'status'],
      summary: 'Show the per-repo state of every campaign step',
      args: [{ name: 'file', required: true }],
      options: [{ flags: '--json', description: 'JSON output' }],
      run({ args, options }, ctx) {
        const c = loadCampaign(resolve(ctx.cwd, args[0]!));
        const s = readState(c);
        ctx.stdout.write(options.json ? JSON.stringify(s ?? null, null, 2) + '\n' : renderStatus(c, s));
        return 0;
      },
    },
    {
      path: ['campaign', 'rollback'],
      summary: 'Roll back a step in one repo (and every later step there)',
      args: [{ name: 'file', required: true }],
      options: [
        { flags: '--step <id>', description: 'step', required: true },
        { flags: '--repo <name>', description: 'repository', required: true },
      ],
      async run({ args, options }, ctx) {
        const c = loadCampaign(resolve(ctx.cwd, args[0]!));
        ctx.stdout.write(renderStatus(c, await rollbackStep(c, String(options.step), String(options.repo))));
        return 0;
      },
    },
  ],
});
