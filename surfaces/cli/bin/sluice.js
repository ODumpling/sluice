#!/usr/bin/env node
import { main } from '../dist/index.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`sluice: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
