import { spawn } from 'node:child_process';
import { loadConfig } from '@sluice-dev/config';
import type { CommandSpec, PluginContext } from '@sluice-dev/plugin-api';
import { Sandbox } from '@sluice-dev/sandbox';

export function loadSandboxSpec(ctx: PluginContext) {
  const loaded = loadConfig(ctx.cwd);
  if (!loaded.config.sandbox) throw new Error(`${loaded.file} has no sandbox: section`);
  return { ...loaded, spec: loaded.config.sandbox };
}

function runShell(cmd: string, env: Record<string, string | undefined>, ctx: PluginContext): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      env: { ...process.env, ...ctx.env, ...env },
      cwd: ctx.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => ctx.stdout.write(d.toString()));
    child.stderr.on('data', (d: Buffer) => ctx.stderr.write(d.toString()));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export const upCommand: CommandSpec = {
  path: ['up'],
  summary: 'Boot the app and its dependencies in a sealed Docker sandbox (egress only to fakes)',
  options: [
    {
      flags: '--exec <command>',
      description: 'run a shell command against the sandbox, then tear down (exit code passes through)',
    },
    { flags: '--source <dir>', description: 'mount source from another checkout of the project' },
    { flags: '--seed <n>', description: 'RNG seed' },
  ],
  async run({ options }, ctx) {
    const { config, root, spec } = loadSandboxSpec(ctx);
    const sb = await Sandbox.up({
      root,
      spec,
      name: config.name,
      sourceRoot: typeof options.source === 'string' ? options.source : undefined,
      seed: typeof options.seed === 'string' ? Number(options.seed) : undefined,
      log: (m) => ctx.stderr.write(`sluice: ${m}\n`),
    });
    const env: Record<string, string> = { SLUICE_SANDBOX_ID: sb.id, SLUICE_INGRESS_URL: sb.ingressUrl };
    if (spec.database) env.SLUICE_DATABASE_URL = sb.databaseUrl;
    for (const [name, f] of sb.fakes) env[`SLUICE_FAKE_${name.toUpperCase()}_URL`] = f.url;
    if (typeof options.exec === 'string') {
      try {
        return await runShell(options.exec, env, ctx);
      } finally {
        await sb.down();
      }
    }
    ctx.stdout.write(`sandbox ${sb.id} is up\n`);
    for (const [k, v] of Object.entries(env)) ctx.stdout.write(`  ${k}=${v}\n`);
    ctx.stdout.write('press Ctrl-C to stop\n');
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await sb.down();
    return 0;
  },
};

export const downCommand: CommandSpec = {
  path: ['down'],
  summary: 'Remove all Sluice sandbox containers and networks left on this machine',
  async run(_input, ctx) {
    const n = await Sandbox.pruneAll();
    ctx.stdout.write(`removed ${n} container(s)\n`);
    return 0;
  },
};
