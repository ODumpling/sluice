import { defineConfig } from 'vitest/config';

// Two projects:
//  - unit: fast, hermetic, no Docker. `pnpm test`.
//  - integration: needs Docker (sandboxes, Postgres). `pnpm test:integration`.
// Both forbid real third-party network calls; see test/setup/no-egress.ts.
const shared = {
  resolve: { conditions: ['@sluice-dev/source'] },
  ssr: { resolve: { conditions: ['@sluice-dev/source'] } },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          include: ['{core,plugins,surfaces}/*/test/**/*.test.ts', 'test/unit/**/*.test.ts'],
          setupFiles: ['test/setup/no-egress.ts'],
          testTimeout: 20_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'integration',
          include: ['{core,plugins,surfaces}/*/test/**/*.itest.ts', 'test/e2e/**/*.itest.ts'],
          setupFiles: ['test/setup/no-egress.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
