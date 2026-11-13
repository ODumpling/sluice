# Releasing

Releases publish every `@sluice-dev/*` package to npm from
`.github/workflows/release.yml` using **npm Trusted Publishing**: the workflow's
GitHub OIDC identity is exchanged for a short-lived publish token. There is no
`NPM_TOKEN` secret.

## Cutting a release

1. Bump every package to the same version and update `CHANGELOG.md`.
2. `git tag -a vX.Y.Z -m "Sluice vX.Y.Z" && git push origin vX.Y.Z`
3. The workflow checks, builds, tests, verifies the tag matches the package
   versions, publishes anything not yet on npm
   (`node scripts/npm-release.mjs publish`) and creates the GitHub release.

## One-time bootstrap (first release only)

npm only lets you attach a trusted publisher to a package that already
exists, so the very first version is published from a maintainer's machine
with a browser sign-in:

```sh
npm install -g npm@latest        # >= 11.15 for `npm trust`
npm login                        # opens npmjs.com in the browser; account needs 2FA
                                 # and publish rights on the @sluice-dev org
pnpm install && pnpm build
node scripts/npm-release.mjs publish --dry-run
node scripts/npm-release.mjs publish     # publishes 0.1.0 of all packages
node scripts/npm-release.mjs trust       # trusts ODumpling/sluice release.yml for each package
```

From then on, tags publish from CI with no stored credentials. If a trusted
publisher config is never used within 2 days, npm expires it; re-run
`trust` (revoke stale entries with `npm trust list` / `npm trust revoke`).

Notes:

- `repository.url` in each `package.json` must match the GitHub repository
  exactly (it does: `git+https://github.com/ODumpling/sluice.git`).
- npm does not generate provenance attestations for **private** source
  repositories; they appear automatically once the repo is public.
