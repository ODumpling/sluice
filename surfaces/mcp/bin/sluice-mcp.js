#!/usr/bin/env node
import { serve } from '../dist/index.js';

await serve({
  cwd: process.env.SLUICE_CWD ?? process.cwd(),
  env: process.env,
  // stdout is the MCP channel; plugin output goes to stderr
  stdout: { write: (t) => void process.stderr.write(t) },
  stderr: { write: (t) => void process.stderr.write(t) },
});
