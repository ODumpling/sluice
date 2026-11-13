import { z } from 'zod';

const ReadySchema = z.union([
  z.object({ exec: z.array(z.string()).min(1) }).strict(),
  z.object({ http: z.object({ port: z.number().int(), path: z.string().default('/') }).strict() }).strict(),
  z.object({ tcp: z.number().int() }).strict(),
]);

export const ServiceSchema = z
  .object({
    /** Prebuilt image, e.g. postgres:16-alpine. Exactly one of image/build. */
    image: z.string().min(1).optional(),
    /** Docker build context (relative to sluice.yaml). */
    build: z.string().min(1).optional(),
    dockerfile: z.string().optional(),
    command: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).default({}),
    /** Container ports the sandbox gateway may forward to the host. */
    ports: z.array(z.number().int().positive()).default([]),
    /** Source directory (relative to the build context) bind-mounted into workdir, so builds can be swapped fast. */
    source: z.string().optional(),
    workdir: z.string().default('/app'),
    dependsOn: z.array(z.string()).default([]),
    /** Inject the deterministic runtime shim (frozen clock, seeded RNG). */
    determinism: z.enum(['node', 'none']).default('none'),
    ready: ReadySchema.optional(),
  })
  .strict()
  .refine((s) => !!s.image !== !!s.build, { message: 'service needs exactly one of image or build' });

export const SandboxSchema = z
  .object({
    services: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), ServiceSchema),
    /** Fakes to run (all egress from the sandbox goes to these). */
    fakes: z.array(z.enum(['stripe', 'github', 's3'])).default([]),
    ingress: z.object({ service: z.string(), port: z.number().int() }).strict(),
    database: z
      .object({
        service: z.string(),
        port: z.number().int().default(5432),
        user: z.string(),
        password: z.string(),
        name: z.string(),
      })
      .strict()
      .optional(),
    /** Simulated start time (ISO) and RNG seed for deterministic runs. */
    clock: z.string().datetime().default('2030-01-15T12:00:00.000Z'),
    seed: z.number().int().default(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    const names = new Set(Object.keys(s.services));
    if (!names.has(s.ingress.service))
      ctx.addIssue({ code: 'custom', message: `ingress service ${s.ingress.service} not defined` });
    if (s.database && !names.has(s.database.service)) {
      ctx.addIssue({ code: 'custom', message: `database service ${s.database.service} not defined` });
    }
    for (const [n, svc] of Object.entries(s.services)) {
      for (const d of svc.dependsOn)
        if (!names.has(d)) ctx.addIssue({ code: 'custom', message: `${n} depends on unknown service ${d}` });
    }
  });

/**
 * sluice.yaml schema, version 1. Unknown keys are rejected so typos fail fast.
 * See docs/config.md.
 */
export const SluiceConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1).optional(),
    /** Extra plugin module specifiers (resolved from the config directory). */
    plugins: z.array(z.string().min(1)).default([]),
    /** Per-plugin configuration keyed by plugin name. */
    pluginConfig: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    sandbox: SandboxSchema.optional(),
    /** Credential broker policy. */
    policy: z
      .object({
        /** Scope patterns that need per-request human approval, e.g. github:acme/*:merge:write */
        stepUp: z.array(z.string()).default([]),
        maxTtlSec: z.number().int().positive().default(3600),
        db: z.string().default('.sluice/state/broker.db'),
        audit: z.string().default('.sluice/state/audit.jsonl'),
      })
      .strict()
      .optional(),
    /** Evidence / diff options (noise filters). */
    evidence: z
      .object({
        ignore: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SluiceConfig = z.infer<typeof SluiceConfigSchema>;
export type SandboxSpec = z.infer<typeof SandboxSchema>;
export type ServiceSpec = z.infer<typeof ServiceSchema>;
