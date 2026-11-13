import { join, resolve } from 'node:path';
import {
  diffSessions,
  formatDiff,
  loadScript,
  loadSession,
  runScript,
  saveSession,
  startEvidenceSandbox,
  type DiffOptions,
} from '@sluice-dev/evidence';
import type { CommandSpec, PluginContext } from '@sluice-dev/plugin-api';
import { resolveBuild } from './builds.js';
import { loadSandboxSpec } from './sandbox-commands.js';

const buildOptions = [
  { flags: '--source <dir>', description: 'run another checkout of the project' },
  { flags: '--ref <git-ref>', description: 'run a git ref (checked out as a temporary worktree)' },
];

function diffOptions(ctx: PluginContext): DiffOptions {
  const ev = (ctx.sluiceConfig?.evidence ?? {}) as { ignore?: string[] };
  return { ignore: ev.ignore ?? [] };
}

export const recordCommand: CommandSpec = {
  path: ['record'],
  summary: 'Run a script against a sandboxed build and record a behavior session',
  args: [{ name: 'script', required: true, description: 'script YAML (steps: http / advance / clock)' }],
  options: [
    { flags: '-o, --out <file>', description: 'session output (default .sluice/sessions/<name>.json)' },
    ...buildOptions,
  ],
  async run({ args, options }, ctx) {
    const { config, root, spec } = loadSandboxSpec(ctx);
    const script = loadScript(resolve(ctx.cwd, args[0]!));
    const build = await resolveBuild(root, options);
    const sb = await startEvidenceSandbox({
      root,
      spec,
      name: config.name,
      log: (m) => ctx.stderr.write(`sluice: ${m}\n`),
    });
    try {
      const session = await runScript(sb, script, { label: build.label, sourceRoot: build.sourceRoot });
      const out =
        typeof options.out === 'string'
          ? resolve(ctx.cwd, options.out)
          : join(root, '.sluice', 'sessions', `${script.name}.json`);
      saveSession(out, session);
      ctx.stdout.write(`recorded ${session.steps.length} steps (${build.label}) -> ${out}\n`);
      if (session.contractViolations.length) {
        ctx.stderr.write(`fake contract violations:\n  ${session.contractViolations.join('\n  ')}\n`);
        return 1;
      }
      return 0;
    } finally {
      await sb.down();
      await build.cleanup();
    }
  },
};

export const replayCommand: CommandSpec = {
  path: ['replay'],
  summary: 'Replay a recorded session against a build and diff behavior (exit 1 on differences)',
  args: [{ name: 'session', required: true }],
  options: [
    ...buildOptions,
    { flags: '-n, --times <n>', description: 'replay N times (determinism check)', default: '1' },
    { flags: '-o, --out <file>', description: 'write the (last) replayed session' },
    { flags: '--json', description: 'print the diff as JSON' },
  ],
  async run({ args, options }, ctx) {
    const { config, root, spec } = loadSandboxSpec(ctx);
    const recorded = loadSession(resolve(ctx.cwd, args[0]!));
    const build = await resolveBuild(root, options);
    const sb = await startEvidenceSandbox({
      root,
      spec,
      name: config.name,
      log: (m) => ctx.stderr.write(`sluice: ${m}\n`),
    });
    let differing = 0;
    try {
      const times = Number(options.times ?? 1);
      for (let i = 0; i < times; i++) {
        const replay = await runScript(sb, recorded.script, {
          label: build.label,
          sourceRoot: build.sourceRoot,
          seed: recorded.seed,
        });
        const d = diffSessions(recorded, replay, diffOptions(ctx));
        if (!d.equal) differing++;
        if (options.json) ctx.stdout.write(JSON.stringify(d) + '\n');
        else ctx.stdout.write(`replay ${i + 1}/${times} (${build.label}): ${formatDiff(d)}`);
        if (typeof options.out === 'string' && i === times - 1) saveSession(resolve(ctx.cwd, options.out), replay);
      }
      return differing ? 1 : 0;
    } finally {
      await sb.down();
      await build.cleanup();
    }
  },
};

export const diffCommand: CommandSpec = {
  path: ['diff'],
  summary: 'Diff two recorded sessions (noise filters from sluice.yaml evidence.ignore)',
  args: [
    { name: 'a', required: true },
    { name: 'b', required: true },
  ],
  options: [
    { flags: '--json', description: 'print JSON' },
    { flags: '--ignore <glob...>', description: 'extra noise filters' },
  ],
  run({ args, options }, ctx) {
    const opts = diffOptions(ctx);
    if (Array.isArray(options.ignore)) opts.ignore = [...(opts.ignore ?? []), ...(options.ignore as string[])];
    const d = diffSessions(loadSession(resolve(ctx.cwd, args[0]!)), loadSession(resolve(ctx.cwd, args[1]!)), opts);
    ctx.stdout.write(options.json ? JSON.stringify(d, null, 2) + '\n' : formatDiff(d));
    return d.equal ? 0 : 1;
  },
};
