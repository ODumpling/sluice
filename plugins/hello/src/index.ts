import { definePlugin } from '@sluice-dev/plugin-api';

export function greeting(name: string, shout = false): string {
  const text = `Hello, ${name}! The gate is closed until the checks pass.`;
  return shout ? text.toUpperCase() : text;
}

/** Reference plugin: one CLI command and one MCP tool. */
export default definePlugin({
  name: '@sluice-dev/plugin-hello',
  version: '0.2.0',
  apiVersion: '^1.0.0',
  description: 'Reference plugin for the Sluice plugin API.',
  commands: [
    {
      path: ['hello'],
      summary: 'Print a greeting (reference plugin)',
      args: [{ name: 'name', description: 'who to greet' }],
      options: [{ flags: '--shout', description: 'upper-case the greeting' }],
      run({ args, options }, ctx) {
        const configured = typeof ctx.config.defaultName === 'string' ? ctx.config.defaultName : 'world';
        ctx.stdout.write(greeting(args[0] ?? configured, options.shout === true) + '\n');
        return 0;
      },
    },
  ],
  tools: [
    {
      name: 'sluice_hello',
      description: 'Return a greeting. Reference tool for the Sluice plugin API.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      run(input) {
        return { content: { greeting: greeting(typeof input.name === 'string' ? input.name : 'world') } };
      },
    },
  ],
});
