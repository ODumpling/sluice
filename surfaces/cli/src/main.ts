import { Command, CommanderError } from 'commander';
import type { CommandSpec, SluicePlugin } from '@sluice-dev/plugin-api';
import { createCliHost, type HostIO } from './host.js';

export const CLI_VERSION = '0.1.0';

function defaultIO(): HostIO {
  return {
    stdout: { write: (t) => void process.stdout.write(t) },
    stderr: { write: (t) => void process.stderr.write(t) },
    env: process.env,
    cwd: process.cwd(),
  };
}

function ensurePath(root: Command, path: string[]): Command {
  let cmd = root;
  for (const seg of path) {
    const existing = cmd.commands.find((c) => c.name() === seg);
    cmd = existing ?? cmd.command(seg);
  }
  return cmd;
}

/** Run the CLI in-process. Returns the exit code; never calls process.exit. */
export async function runCli(
  argv: string[],
  io: HostIO = defaultIO(),
  extraPlugins: SluicePlugin[] = [],
): Promise<number> {
  const cli = await createCliHost(io, extraPlugins);
  let exitCode = 0;
  const program = new Command('sluice')
    .description('Sluice — nothing merges until the checks open the gate.')
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .showHelpAfterError();

  const sorted = [...cli.host.commands()].sort((a, b) => a.spec.path.length - b.spec.path.length);
  for (const { plugin, spec } of sorted) {
    const p = cli.host.get(plugin)!;
    const cmd = ensurePath(program, spec.path);
    cmd.description(spec.summary).exitOverride();
    for (const a of spec.args ?? []) {
      const n = a.variadic ? `${a.name}...` : a.name;
      cmd.argument(a.required ? `<${n}>` : `[${n}]`, a.description ?? '');
    }
    for (const o of spec.options ?? []) {
      if (o.required) cmd.requiredOption(o.flags, o.description, o.default as string | boolean | undefined);
      else cmd.option(o.flags, o.description, o.default as string | boolean | undefined);
    }
    cmd.action(async (...actionArgs: unknown[]) => {
      const command = actionArgs[actionArgs.length - 1] as Command;
      const args = command.args.map(String);
      exitCode = (await runSpec(spec, args, command.opts(), cli.contextFor(p))) ?? 0;
    });
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) {
      // help / version are reported as "errors" with exitCode 0
      return e.exitCode;
    }
    io.stderr.write(`sluice: ${(e as Error).message}\n`);
    return 1;
  }
  return exitCode;
}

async function runSpec(
  spec: CommandSpec,
  args: string[],
  options: Record<string, unknown>,
  ctx: ReturnType<Awaited<ReturnType<typeof createCliHost>>['contextFor']>,
): Promise<number | undefined> {
  const r = await spec.run({ args, options }, ctx);
  return typeof r === 'number' ? r : 0;
}

export async function main(argv: string[]): Promise<number> {
  return runCli(argv);
}
