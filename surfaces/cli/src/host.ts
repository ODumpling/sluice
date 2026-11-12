import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { tryLoadConfig, type LoadedConfig } from '@sluice-dev/config';
import {
  PLUGIN_API_VERSION,
  PluginHost,
  createServiceRegistry,
  pluginFromModule,
  type Logger,
  type PluginContext,
  type ServiceRegistry,
  type SluicePlugin,
  type Writer,
} from '@sluice-dev/plugin-api';
import { builtinPlugins } from './builtins.js';

export interface HostIO {
  stdout: Writer;
  stderr: Writer;
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface CliHost {
  host: PluginHost;
  loaded: LoadedConfig | undefined;
  services: ServiceRegistry;
  contextFor(plugin: SluicePlugin): PluginContext;
}

function makeLogger(io: HostIO): Logger {
  const verbose = io.env.SLUICE_LOG === 'debug';
  const line = (lvl: string, msg: string, data?: Record<string, unknown>) =>
    io.stderr.write(`[${lvl}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`);
  return {
    debug: (m, d) => verbose && line('debug', m, d),
    info: (m, d) => verbose && line('info', m, d),
    warn: (m, d) => line('warn', m, d),
    error: (m, d) => line('error', m, d),
  };
}

async function importPlugin(specifier: string, root: string): Promise<SluicePlugin> {
  let url: string;
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    url = pathToFileURL(resolve(root, specifier)).href;
  } else {
    // resolve bare specifiers from the project, not from the CLI install location
    const req = createRequire(resolve(root, 'package.json'));
    url = pathToFileURL(req.resolve(specifier)).href;
  }
  return pluginFromModule(await import(url), specifier);
}

export async function createCliHost(io: HostIO, extraPlugins: SluicePlugin[] = []): Promise<CliHost> {
  const loaded = tryLoadConfig(io.cwd);
  const host = new PluginHost();
  for (const p of [...builtinPlugins(), ...extraPlugins]) host.register(p);
  for (const spec of loaded?.config.plugins ?? []) host.register(await importPlugin(spec, loaded!.root));
  const services = createServiceRegistry();
  const logger = makeLogger(io);
  const contextFor = (plugin: SluicePlugin): PluginContext => {
    const pc = loaded?.config.pluginConfig ?? {};
    const short = plugin.name.replace(/^@sluice-dev\/plugin-/, '');
    return {
      apiVersion: PLUGIN_API_VERSION,
      cwd: io.cwd,
      env: io.env,
      stdout: io.stdout,
      stderr: io.stderr,
      logger,
      config: pc[plugin.name] ?? pc[short] ?? {},
      sluiceConfig: loaded?.config as Record<string, unknown> | undefined,
      services,
    };
  };
  await host.activateAll(contextFor);
  return { host, loaded, services, contextFor };
}
