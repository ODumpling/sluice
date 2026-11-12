/**
 * @sluice-dev/plugin-api — the versioned contract between the Sluice host
 * (CLI / MCP server / GitHub surfaces) and plugins.
 *
 * Versioning: PLUGIN_API_VERSION follows semver. A plugin declares the range it
 * was written against in `apiVersion` (e.g. "^1.0.0"). Minor versions only add
 * optional fields; a major bump may remove or change fields. See
 * docs/plugin-api.md for the full reference.
 */

export const PLUGIN_API_VERSION = '1.0.0';

export interface Writer {
  write(text: string): void;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Named services that plugins can provide to and consume from each other. */
export interface ServiceRegistry {
  provide<T>(name: string, impl: T): void;
  get<T>(name: string): T | undefined;
  require<T>(name: string): T;
}

export interface PluginContext {
  /** Host API version (PLUGIN_API_VERSION of the host). */
  readonly apiVersion: string;
  /** Working directory of the invocation (repo root in most cases). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly logger: Logger;
  /** This plugin's section of sluice.yaml (`plugins.<name>`), or {}. */
  readonly config: Readonly<Record<string, unknown>>;
  /** The whole parsed sluice.yaml, if one was found. */
  readonly sluiceConfig: Readonly<Record<string, unknown>> | undefined;
  readonly services: ServiceRegistry;
}

export interface OptionSpec {
  /** Commander-style flags, e.g. "-b, --base <ref>" or "--json". */
  flags: string;
  description: string;
  default?: string | boolean | number;
  required?: boolean;
}

export interface ArgSpec {
  name: string;
  description?: string;
  required?: boolean;
  variadic?: boolean;
}

export interface CommandInput {
  args: string[];
  options: Record<string, unknown>;
}

export interface CommandSpec {
  /** Command path; ["gate", "run"] becomes `sluice gate run`. */
  path: string[];
  summary: string;
  args?: ArgSpec[];
  options?: OptionSpec[];
  /** Returns a process exit code (default 0). */
  run(input: CommandInput, ctx: PluginContext): Promise<number | void> | number | void;
}

/** JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

export interface ToolResult {
  /** JSON-serialisable result. */
  content: unknown;
  isError?: boolean;
}

/** A tool exposed to agents over MCP (and callable from other surfaces). */
export interface ToolSpec {
  /** snake_case, globally unique, conventionally prefixed with `sluice_`. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(input: Record<string, unknown>, ctx: PluginContext): Promise<ToolResult> | ToolResult;
}

export interface SluicePlugin {
  /** npm-style name, e.g. "@sluice-dev/plugin-gate" or "hello". */
  name: string;
  version: string;
  /** Plugin API range this plugin supports, e.g. "^1.0.0". */
  apiVersion: string;
  description?: string;
  commands?: CommandSpec[];
  tools?: ToolSpec[];
  /** Called once after all plugins are registered, before any command/tool runs. */
  activate?(ctx: PluginContext): void | Promise<void>;
}

/** Identity helper that gives plugin authors type-checking. */
export function definePlugin<T extends SluicePlugin>(plugin: T): T {
  return plugin;
}

export class PluginLoadError extends Error {
  constructor(
    message: string,
    readonly plugin: string,
  ) {
    super(message);
    this.name = 'PluginLoadError';
  }
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(v: string): Semver | undefined {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

function cmp(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Supported range forms: "^X.Y.Z" (same major, >= X.Y.Z), "X" / "X.x" (same
 * major), and an exact "X.Y.Z".
 */
export function isApiCompatible(range: string, hostVersion: string = PLUGIN_API_VERSION): boolean {
  const host = parseSemver(hostVersion);
  if (!host) throw new Error(`invalid host version ${hostVersion}`);
  const r = range.trim();
  if (r.startsWith('^')) {
    const min = parseSemver(r.slice(1));
    return !!min && min.major === host.major && cmp(host, min) >= 0;
  }
  const majorOnly = /^(\d+)(?:\.x)?$/.exec(r);
  if (majorOnly) return Number(majorOnly[1]) === host.major;
  const exact = parseSemver(r);
  return !!exact && cmp(exact, host) === 0;
}

const NAME_RE = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;

export interface RegisteredCommand {
  plugin: string;
  spec: CommandSpec;
}

export interface RegisteredTool {
  plugin: string;
  spec: ToolSpec;
}

/**
 * Registry used by every surface. Validates plugins on registration so a broken
 * plugin fails loudly at startup rather than at first use.
 */
export class PluginHost {
  readonly hostVersion: string;
  private readonly plugins = new Map<string, SluicePlugin>();
  private readonly commandIndex = new Map<string, RegisteredCommand>();
  private readonly toolIndex = new Map<string, RegisteredTool>();

  constructor(opts: { hostVersion?: string } = {}) {
    this.hostVersion = opts.hostVersion ?? PLUGIN_API_VERSION;
  }

  register(plugin: SluicePlugin): void {
    const name = plugin?.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new PluginLoadError(`invalid plugin name ${JSON.stringify(name)}`, String(name));
    }
    if (this.plugins.has(name)) throw new PluginLoadError(`plugin ${name} registered twice`, name);
    if (typeof plugin.version !== 'string' || !parseSemver(plugin.version)) {
      throw new PluginLoadError(`plugin ${name} has invalid version ${JSON.stringify(plugin.version)}`, name);
    }
    if (typeof plugin.apiVersion !== 'string' || !isApiCompatible(plugin.apiVersion, this.hostVersion)) {
      throw new PluginLoadError(
        `plugin ${name} requires plugin API ${plugin.apiVersion}, host provides ${this.hostVersion}`,
        name,
      );
    }
    const newCommands: [string, RegisteredCommand][] = [];
    for (const spec of plugin.commands ?? []) {
      if (!Array.isArray(spec.path) || spec.path.length === 0 || !spec.path.every((s) => SEGMENT_RE.test(s))) {
        throw new PluginLoadError(`plugin ${name} has invalid command path ${JSON.stringify(spec.path)}`, name);
      }
      if (typeof spec.run !== 'function')
        throw new PluginLoadError(`command ${spec.path.join(' ')} has no run()`, name);
      const key = spec.path.join(' ');
      const existing = this.commandIndex.get(key) ?? newCommands.find(([k]) => k === key)?.[1];
      if (existing) {
        throw new PluginLoadError(`command "${key}" from ${name} conflicts with ${existing.plugin}`, name);
      }
      newCommands.push([key, { plugin: name, spec }]);
    }
    const newTools: [string, RegisteredTool][] = [];
    for (const spec of plugin.tools ?? []) {
      if (!TOOL_RE.test(spec.name)) throw new PluginLoadError(`invalid tool name ${JSON.stringify(spec.name)}`, name);
      if (typeof spec.run !== 'function') throw new PluginLoadError(`tool ${spec.name} has no run()`, name);
      const existing = this.toolIndex.get(spec.name) ?? newTools.find(([k]) => k === spec.name)?.[1];
      if (existing)
        throw new PluginLoadError(`tool "${spec.name}" from ${name} conflicts with ${existing.plugin}`, name);
      newTools.push([spec.name, { plugin: name, spec }]);
    }
    this.plugins.set(name, plugin);
    for (const [k, v] of newCommands) this.commandIndex.set(k, v);
    for (const [k, v] of newTools) this.toolIndex.set(k, v);
  }

  list(): SluicePlugin[] {
    return [...this.plugins.values()];
  }

  get(name: string): SluicePlugin | undefined {
    return this.plugins.get(name);
  }

  commands(): RegisteredCommand[] {
    return [...this.commandIndex.values()];
  }

  findCommand(path: string[]): RegisteredCommand | undefined {
    return this.commandIndex.get(path.join(' '));
  }

  tools(): RegisteredTool[] {
    return [...this.toolIndex.values()];
  }

  findTool(name: string): RegisteredTool | undefined {
    return this.toolIndex.get(name);
  }

  async activateAll(contextFor: (plugin: SluicePlugin) => PluginContext): Promise<void> {
    for (const p of this.plugins.values()) {
      if (p.activate) await p.activate(contextFor(p));
    }
  }
}

export function createServiceRegistry(): ServiceRegistry {
  const services = new Map<string, unknown>();
  return {
    provide(name, impl) {
      if (services.has(name)) throw new Error(`service ${name} already provided`);
      services.set(name, impl);
    },
    get<T>(name: string) {
      return services.get(name) as T | undefined;
    },
    require<T>(name: string) {
      if (!services.has(name)) throw new Error(`required service ${name} is not provided by any plugin`);
      return services.get(name) as T;
    },
  };
}

/** Plugin modules export the plugin as default export or as `plugin`. */
export function pluginFromModule(mod: unknown, specifier: string): SluicePlugin {
  const m = mod as { default?: unknown; plugin?: unknown };
  const candidate = (m.default ?? m.plugin) as SluicePlugin | undefined;
  if (!candidate || typeof candidate !== 'object') {
    throw new PluginLoadError(`module ${specifier} has no default or "plugin" export`, specifier);
  }
  return candidate;
}
