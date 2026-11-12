import type { SluicePlugin } from '@sluice-dev/plugin-api';
import hello from '@sluice-dev/plugin-hello';
import { corePlugin } from './core-commands.js';

/** Plugins bundled with the CLI. Surfaces may import plugins; core may not. */
export function builtinPlugins(): SluicePlugin[] {
  return [corePlugin, hello];
}
