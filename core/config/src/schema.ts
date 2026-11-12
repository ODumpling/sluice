import { z } from 'zod';

/**
 * sluice.yaml schema, version 1. Unknown keys are rejected so typos fail fast.
 * Sections are added by milestone; see docs/config.md.
 */
export const SluiceConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1).optional(),
    /** Extra plugin module specifiers (resolved from the config directory). */
    plugins: z.array(z.string().min(1)).default([]),
    /** Per-plugin configuration keyed by plugin name. */
    pluginConfig: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  })
  .strict();

export type SluiceConfig = z.infer<typeof SluiceConfigSchema>;
