#!/usr/bin/env node
// Run the "Sluice Gate" GitHub App webhook server.
// Env: SLUICE_APP_ID, SLUICE_APP_PRIVATE_KEY_FILE, SLUICE_WEBHOOK_SECRET, [PORT], [SLUICE_WORK_DIR], [SLUICE_PROJECT_PATH], [GITHUB_API_URL]
import { readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateApp } from '../dist/index.js';

const need = (k) => process.env[k] ?? (console.error(`missing ${k}`), process.exit(2));
const workDir = process.env.SLUICE_WORK_DIR ?? join(tmpdir(), 'sluice-gate-app');
mkdirSync(workDir, { recursive: true });
const app = createGateApp({
  appId: need('SLUICE_APP_ID'),
  privateKeyPem: readFileSync(need('SLUICE_APP_PRIVATE_KEY_FILE'), 'utf8'),
  webhookSecret: need('SLUICE_WEBHOOK_SECRET'),
  apiBaseUrl: process.env.GITHUB_API_URL,
  projectPath: process.env.SLUICE_PROJECT_PATH,
  workDir,
  log: (m) => console.error(m),
});
const { url } = await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0');
console.error(`Sluice Gate app listening on ${url}/webhook`);
