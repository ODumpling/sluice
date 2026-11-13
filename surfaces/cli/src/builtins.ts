import type { SluicePlugin } from '@sluice-dev/plugin-api';
import hello from '@sluice-dev/plugin-hello';
import gate from '@sluice-dev/plugin-gate';
import bench from '@sluice-dev/plugin-bench';
import rules from '@sluice-dev/plugin-rules';
import inbox from '@sluice-dev/plugin-inbox';
import leases from '@sluice-dev/plugin-leases';
import { corePlugin } from './core-commands.js';

/** Plugins bundled with the CLI. Surfaces may import plugins; core may not. */
export function builtinPlugins(): SluicePlugin[] {
  return [corePlugin, hello, gate, bench, rules, inbox, leases];
}
