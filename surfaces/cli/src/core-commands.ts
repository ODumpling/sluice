import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CONFIG_FILENAME } from '@sluice-dev/config';
import { TOOLCHAINS, detectToolchain, type ToolchainId } from '@sluice-dev/lang';
import { definePlugin } from '@sluice-dev/plugin-api';
import { createWebUi } from '@sluice-dev/web';
import { findConfigFile } from '@sluice-dev/config';
import { dirname } from 'node:path';
import { downCommand, upCommand } from './sandbox-commands.js';
import { diffCommand, recordCommand, replayCommand } from './evidence-commands.js';
import { policyCommands } from './policy-commands.js';
import { workCommands, workTools } from './work-commands.js';

interface InitProfile {
  /** What the app service's Dockerfile does. */
  build: string;
  /** Service command (compiled languages build the mounted source at start). */
  command?: string;
  unitTests: string;
  mounts: string;
}

const LABEL: Record<ToolchainId, string> = { node: 'Node', go: 'Go', dotnet: '.NET' };

const INIT: Record<ToolchainId, InitProfile> = {
  node: {
    build: 'FROM node:22-alpine; npm ci; CMD ["node", "src/server.js"]',
    unitTests: '[npm, test, --silent]',
    mounts: '[src, test]',
  },
  go: {
    build: 'FROM golang:1.27-alpine; go mod download; warm the build cache (see examples/billing-demo-go)',
    command: `[sh, -c, 'go build -o /tmp/app . && exec /tmp/app']`,
    unitTests: '[go, test, ./...]',
    mounts: '[src, test]',
  },
  dotnet: {
    build: 'FROM mcr.microsoft.com/dotnet/sdk:10.0; dotnet restore (see examples/billing-demo-dotnet)',
    command: '[dotnet, run, --no-restore, -c, Release]',
    unitTests: '[dotnet, test, --nologo]',
    mounts: '[src, test]',
  },
};

/** `sluice.yaml` written by `sluice init`: a commented skeleton for the project's toolchain. */
export function initTemplate(name: string, toolchain?: ToolchainId): string {
  if (!toolchain)
    return `# Sluice configuration. Docs: docs/config.md
# (no Node/Go/.NET project detected here; \`sluice init --lang node|go|dotnet\` writes a sandbox skeleton)
version: 1
name: ${name}
plugins: []
pluginConfig: {}
`;
  const p = INIT[toolchain];
  const t = TOOLCHAINS[toolchain];
  const command = p.command
    ? `\n      command: ${p.command} # compiles the mounted source at start (base / PR / mutant builds)`
    : '';
  return `# Sluice configuration for a ${LABEL[toolchain]} project. Docs: docs/config.md
version: 1
name: ${name}
plugins: [] # extra plugins (path or package)

pluginConfig:
  gate:
    mutation: { maxMutants: 10, threshold: 0.8 } # mutants of changed lines; share that must be caught
    # the PR's own unit tests, run in the app image with no network (shown for contrast)
    unitTests: { service: app, command: ${p.unitTests}, mounts: ${p.mounts} }

# The app and its dependencies for \`sluice up\`, gate scenarios and record/replay.
# Services join an internal network only: all egress goes to fakes. Edit to match your app.
sandbox:
  fakes: [] # stripe | github | s3 (point the app at \${fakes.<name>.url})
  ingress: { service: app, port: 3000 }
  services:
    app:
      build: . # Dockerfile context — e.g. ${p.build}
      workdir: /app
      source: src # bind-mounted read-only, so base / PR / mutant builds swap without an image rebuild${command}
      env: { PORT: '3000' }
      ports: [3000]
      determinism: ${toolchain} # frozen clock, seeded RNG, event capture
      ready: { http: { port: 3000, path: /health } }
    # db:
    #   image: postgres:16-alpine
    #   env: { POSTGRES_USER: sluice, POSTGRES_PASSWORD: sluice, POSTGRES_DB: app }
    #   ports: [5432]
    #   ready: { exec: [pg_isready, -U, sluice, -h, 127.0.0.1] }

# Bench (bench.yaml) and campaigns (campaign.yaml) default to this toolchain:
# image ${t.image}, tests \`${t.testCommand}\`${toolchain === 'node' ? '' : ', dependencies fetched by a prepare step'}.
# See docs/guide/bench.md and docs/guide/campaigns.md.
`;
}

/** Core commands, registered through the same plugin API as everything else. */
export const corePlugin = definePlugin({
  name: '@sluice-dev/core-commands',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  description: 'Built-in core commands',
  commands: [
    {
      path: ['init'],
      summary: `Create a ${CONFIG_FILENAME} in the current directory`,
      options: [
        { flags: '--name <name>', description: 'project name (default: directory name)' },
        { flags: '--force', description: 'overwrite an existing config' },
        { flags: '--lang <toolchain>', description: 'node | go | dotnet (default: detected from the directory)' },
      ],
      run({ options }, ctx) {
        const file = join(ctx.cwd, CONFIG_FILENAME);
        if (existsSync(file) && options.force !== true) {
          ctx.stderr.write(`${CONFIG_FILENAME} already exists (use --force to overwrite)\n`);
          return 1;
        }
        const name = typeof options.name === 'string' ? options.name : basename(ctx.cwd);
        let lang: ToolchainId | undefined;
        if (typeof options.lang === 'string') {
          if (!Object.hasOwn(TOOLCHAINS, options.lang)) {
            ctx.stderr.write(`--lang must be one of ${Object.keys(TOOLCHAINS).join(', ')}\n`);
            return 1;
          }
          lang = options.lang as ToolchainId;
        } else lang = detectToolchain(ctx.cwd)?.id;
        writeFileSync(file, initTemplate(name, lang));
        ctx.stdout.write(`wrote ${file}${lang ? ` (${lang})` : ''}\n`);
        return 0;
      },
    },
    {
      path: ['ui'],
      summary: 'Open the local web UI (gate reports, scenario approvals) on 127.0.0.1',
      options: [{ flags: '--port <n>', description: 'port', default: '4600' }],
      async run({ options }, ctx) {
        const f = findConfigFile(ctx.cwd);
        const { url } = await createWebUi({
          projectRoot: f ? dirname(f) : ctx.cwd,
          port: Number(options.port),
        }).listen();
        ctx.stdout.write(`Sluice UI: ${url}  (Ctrl-C to stop)\n`);
        await new Promise<void>((r) => process.once('SIGINT', () => r()));
        return 0;
      },
    },
    upCommand,
    downCommand,
    recordCommand,
    replayCommand,
    diffCommand,
    ...policyCommands,
    ...workCommands,
  ],
  tools: workTools,
});
