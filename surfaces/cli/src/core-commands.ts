import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CONFIG_FILENAME } from '@sluice-dev/config';
import { definePlugin } from '@sluice-dev/plugin-api';
import { downCommand, upCommand } from './sandbox-commands.js';
import { diffCommand, recordCommand, replayCommand } from './evidence-commands.js';

export function initTemplate(name: string): string {
  return `# Sluice configuration. Docs: docs/config.md
version: 1
name: ${name}
plugins: []
pluginConfig: {}
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
      ],
      run({ options }, ctx) {
        const file = join(ctx.cwd, CONFIG_FILENAME);
        if (existsSync(file) && options.force !== true) {
          ctx.stderr.write(`${CONFIG_FILENAME} already exists (use --force to overwrite)\n`);
          return 1;
        }
        const name = typeof options.name === 'string' ? options.name : basename(ctx.cwd);
        writeFileSync(file, initTemplate(name));
        ctx.stdout.write(`wrote ${file}\n`);
        return 0;
      },
    },
    upCommand,
    downCommand,
    recordCommand,
    replayCommand,
    diffCommand,
  ],
});
