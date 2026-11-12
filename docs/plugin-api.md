# Sluice Plugin API (v1)

`@sluice-dev/plugin-api` is the versioned contract between Sluice hosts (CLI, MCP
server, GitHub surfaces) and plugins. Current version: **1.0.0**
(`PLUGIN_API_VERSION`).

## Writing a plugin

```ts
import { definePlugin } from '@sluice-dev/plugin-api';

export default definePlugin({
  name: 'my-plugin', // npm-style name
  version: '1.0.0', // the plugin's own semver
  apiVersion: '^1.0.0', // plugin API range it supports
  commands: [
    {
      path: ['my', 'thing'], // => `sluice my thing`
      summary: 'Do the thing',
      args: [{ name: 'target', required: true }],
      options: [{ flags: '--dry-run', description: 'print only' }],
      async run({ args, options }, ctx) {
        ctx.stdout.write(`thing ${args[0]} ${options.dryRun ? '(dry)' : ''}\n`);
        return 0; // exit code
      },
    },
  ],
  tools: [
    {
      name: 'sluice_my_thing', // exposed over MCP
      description: 'Do the thing',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
      async run(input, ctx) {
        return { content: { ok: true, target: input.target } };
      },
    },
  ],
  activate(ctx) {
    ctx.services.provide('my-service', { hello: () => 'hi' });
  },
});
```

Load it from `sluice.yaml`:

```yaml
version: 1
plugins: [./plugins/my-plugin.mjs] # path or package name
pluginConfig:
  my-plugin: { anything: true } # available as ctx.config
```

See `plugins/hello` for the reference implementation and tests.

## Context (`PluginContext`)

| Field              | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `apiVersion`       | host API version                                                                        |
| `cwd`              | invocation directory                                                                    |
| `env`              | environment variables                                                                   |
| `stdout`, `stderr` | writers (use these, not `process.*`, so surfaces can capture output)                    |
| `logger`           | leveled logger (`SLUICE_LOG=debug` to see debug/info)                                   |
| `config`           | `pluginConfig.<name>` (or `pluginConfig.<short name>` for `@sluice-dev/plugin-<short>`) |
| `sluiceConfig`     | the full parsed `sluice.yaml`                                                           |
| `services`         | `provide(name, impl)`, `get(name)`, `require(name)` — cross-plugin services             |

## Rules enforced by the host

- Names: plugin `name` is npm-style; command path segments are `[a-z][a-z0-9-]*`;
  tool names are `[a-z][a-z0-9_]*` (≤64 chars).
- No duplicate plugins, command paths or tool names. Registration is atomic: a
  plugin that conflicts registers nothing.
- `apiVersion` must be compatible with the host: `^X.Y.Z` (same major, ≥ X.Y.Z),
  `X` / `X.x` (same major) or exact `X.Y.Z`.
- `activate()` runs once per host start, in registration order (built-ins first).

## Versioning policy

- **Minor** (1.x): only additive, optional fields/methods.
- **Major**: breaking changes; hosts reject plugins built for another major.
- Plugins must not import `@sluice-dev/cli` or other surfaces; they may import
  any `core/*` package.
