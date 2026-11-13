import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLCHAINS } from '@sluice-dev/lang';
import { evidenceEnv, validateCampaign, type CampaignDef, type LoadedCampaign } from '@sluice-dev/plugin-campaign';

const ws = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'sluice-campaign-env-'));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  return d;
};
const campaign = (def: Partial<CampaignDef>): LoadedCampaign =>
  ({
    def: {
      id: 'c',
      title: 't',
      repos: [{ name: 'lib' }, { name: 'web' }, { name: 'svc', image: 'my/go:1', prepare: false }],
      steps: [],
      ...def,
    },
  }) as unknown as LoadedCampaign;

describe('campaign evidence environment', () => {
  const dir = ws({ 'lib/go.mod': 'module lib\n', 'web/package.json': '{}', 'svc/go.mod': 'module svc\n' });

  it('defaults image and prepare per repo from the detected toolchain', () => {
    const lib = evidenceEnv(campaign({}), {}, dir, 'lib');
    expect(lib.image).toBe(TOOLCHAINS.go.image);
    expect(lib.options?.prepare?.command).toBe(`cd lib && ${TOOLCHAINS.go.prepareCommand}`);
    const web = evidenceEnv(campaign({}), {}, dir, 'web');
    expect(web.image).toBe(TOOLCHAINS.node.image);
    expect(web.options?.prepare).toBeUndefined(); // node: unchanged, no prepare unless asked
  });

  it('repo, campaign and step settings override the defaults', () => {
    expect(evidenceEnv(campaign({}), {}, dir, 'svc')).toMatchObject({
      image: 'my/go:1',
      options: { prepare: undefined },
    });
    const c = campaign({ evidenceImage: 'node:24-alpine', prepare: true });
    expect(evidenceEnv(c, {}, dir, 'web')).toMatchObject({ image: 'node:24-alpine' });
    expect(evidenceEnv(c, {}, dir, 'web').options?.prepare?.command).toBe(
      `cd web && ${TOOLCHAINS.node.prepareCommand}`,
    );
    expect(evidenceEnv(c, { prepare: 'npm ci' }, dir, 'web').options?.prepare?.command).toBe('cd web && npm ci');
    expect(evidenceEnv(c, { prepare: false }, dir, 'lib').options?.prepare).toBeUndefined();
  });

  it('rejects malformed prepare settings', () => {
    const base = {
      id: 'c',
      repos: [{ name: 'a', path: 'a' }],
      steps: [{ id: 's', repos: ['a'], apply: { command: 'true' }, evidence: [{ tests: 'true' }] }],
    };
    expect(() => validateCampaign({ ...base, prepare: 1 })).toThrow(/prepare must be/);
    expect(() => validateCampaign({ ...base, steps: [{ ...base.steps[0], prepare: [] }] })).toThrow(/step s prepare/);
    expect(validateCampaign({ ...base, prepare: 'go mod download' }).prepare).toBe('go mod download');
  });
});
