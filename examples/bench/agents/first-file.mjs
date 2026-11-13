#!/usr/bin/env node
// Scripted "partial solver" agent for harness tests: applies only the first
// file of the reference patch, then prints a Claude-Code-style JSON result line
// with a SIMULATED cost (0.001 USD per changed line) so cost parsing and
// aggregation are exercised deterministically without calling any model.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const patch = readFileSync(process.env.SLUICE_TASK_GOLD_PATCH, 'utf8');
const files = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git'));
const first = files[0] ?? '';
const tmp = `${process.env.SLUICE_TASK_GOLD_PATCH}.first`;
writeFileSync(tmp, first);
if (first) execFileSync('git', ['apply', '--whitespace=nowarn', tmp], { stdio: 'inherit' });
const changed = first.split('\n').filter((l) => /^[+-](?![+-])/.test(l)).length;
console.log(
  JSON.stringify({
    type: 'result',
    simulated: true,
    total_cost_usd: changed * 0.001,
    usage: { input_tokens: changed * 100, output_tokens: changed * 10 },
  }),
);
