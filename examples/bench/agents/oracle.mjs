#!/usr/bin/env node
// Calibration agent: applies the reference patch. Should solve 100% of tasks;
// anything less means the harness (not the agent) is broken.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

execFileSync('git', ['apply', '--whitespace=nowarn', process.env.SLUICE_TASK_GOLD_PATCH], { stdio: 'inherit' });
writeFileSync(process.env.SLUICE_AGENT_REPORT, JSON.stringify({ cost_usd: 0, tokens: 0 }));
