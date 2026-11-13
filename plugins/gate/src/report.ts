/** Gate report renderers: self-contained HTML artifact, Markdown (GitHub check), terminal text. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiffEntry } from '@sluice-dev/evidence';
import { GitHubClient, parseRepo } from '@sluice-dev/github-api';
import type { GateReport, ScenarioReport } from './gate.js';

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function short(v: unknown, n = 140): string {
  const s = v === undefined ? '—' : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Diff entries most relevant to reviewers first: API response, egress, DB writes, events, final state. */
function rankedDiff(diff: DiffEntry[]): DiffEntry[] {
  const order = { response: 0, egress: 1, db: 2, events: 3, final: 4 } as const;
  return [...diff].sort((a, b) => order[a.channel] - order[b.channel] || a.step - b.step);
}

function diffLabel(e: DiffEntry): string {
  return `${e.channel}${e.path.startsWith('[') || !e.path ? '' : '.'}${e.path}`;
}

/** Mutants actually tested (the score's denominator): not invalid, not errored. */
const validMutants = (m: GateReport['mutation']) => m.total - (m.invalid ?? 0) - (m.errored ?? 0);

/** " (2 more did not compile, 1 hit a sandbox error; not scored)" or "". */
function invalidNote(m: GateReport['mutation']): string {
  const parts = [
    m.invalid ? `${m.invalid} more did not compile` : '',
    m.errored ? `${m.errored} ${m.invalid ? '' : 'more '}hit a sandbox error` : '',
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')}; not scored)` : '';
}

const mutantStatus = (m: GateReport['mutation']['mutants'][number]) => m.status ?? (m.killed ? 'killed' : 'survived');

export function headline(r: GateReport): string {
  const failed = r.scenarios.filter((s) => !s.passed).length;
  const m = r.mutation.score === null ? '' : `, mutation ${r.mutation.killed}/${validMutants(r.mutation)}`;
  return r.verdict === 'pass'
    ? `Sluice Gate passed: ${r.scenarios.length}/${r.scenarios.length} approved scenarios hold${m}`
    : `Sluice Gate failed: ${failed ? `${failed}/${r.scenarios.length} approved scenarios violated` : r.reasons[0]}${m}`;
}

export function renderText(r: GateReport): string {
  const lines = [
    `${r.verdict === 'pass' ? '✔' : '✘'} ${headline(r)}`,
    `  ticket ${r.ticket.id}: ${r.ticket.title}`,
    `  base ${r.base.ref}@${r.base.sha.slice(0, 8)} → head ${r.head.ref}@${r.head.sha.slice(0, 8)}`,
  ];
  for (const s of r.scenarios) {
    lines.push(`  ${s.passed ? 'PASS' : 'FAIL'} ${s.id} — ${s.title}`);
    for (const f of s.failures) lines.push(`       step ${f.step + 1} (${f.stepName}): ${f.message}`);
  }
  if (r.unitTests)
    lines.push(
      `  unit tests (${r.unitTests.command}): ${r.unitTests.passed ? 'pass' : `fail (exit ${r.unitTests.exitCode})`}`,
    );
  if (r.mutation.enabled) {
    lines.push(
      `  mutation proof: ${r.mutation.killed}/${validMutants(r.mutation)} deliberately broken versions caught${invalidNote(r.mutation)}`,
    );
  }
  for (const reason of r.reasons) lines.push(`  ✘ ${reason}`);
  return lines.join('\n') + '\n';
}

export function renderMarkdown(
  r: GateReport,
  opts: { reportUrl?: string } = {},
): { title: string; summary: string; text: string } {
  const rows = r.scenarios.map(
    (s) =>
      `| ${s.passed ? '✅' : '❌'} | \`${s.id}\` | ${s.title.replace(/\|/g, '\\|')} | ${s.failures[0] ? s.failures[0].message.replace(/\|/g, '\\|').slice(0, 160) : ''} |`,
  );
  const summary = [
    `**${r.verdict === 'pass' ? 'PASS' : 'FAIL'}** — ticket \`${r.ticket.id}\`: ${r.ticket.title}`,
    '',
    '| | scenario | behaviour | violation |',
    '|---|---|---|---|',
    ...rows,
    '',
    r.mutation.enabled
      ? `**Mutation proof:** ${r.mutation.killed}/${validMutants(r.mutation)} deliberately broken versions of the changed code were caught by these checks${invalidNote(r.mutation)}.`
      : '',
    r.unitTests
      ? `**PR unit tests** (\`${r.unitTests.command}\`): ${r.unitTests.passed ? 'passed' : 'failed'} — shown for contrast; the gate judges behaviour.`
      : '',
    ...(r.reasons.length ? ['', '**Why:**', ...r.reasons.map((x) => `- ${x}`)] : []),
    opts.reportUrl ? `\n[Full report](${opts.reportUrl})` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  const text: string[] = [];
  for (const s of r.scenarios.filter((x) => !x.passed)) {
    text.push(`### ❌ ${s.id}`, '', s.title, '');
    for (const f of s.failures) text.push(`- step ${f.step + 1} \`${f.stepName}\`: ${f.message}`);
    text.push('', 'Behavior diff vs base (API response, egress, DB writes):', '', '```diff');
    for (const e of rankedDiff(s.diff).slice(0, 25)) {
      text.push(
        e.kind === 'added'
          ? `+ ${diffLabel(e)} ${short(e.after)}`
          : e.kind === 'removed'
            ? `- ${diffLabel(e)} ${short(e.before)}`
            : `! ${diffLabel(e)} ${short(e.before)} -> ${short(e.after)}`,
      );
    }
    text.push('```', '');
  }
  if (r.mutation.mutants.length) {
    text.push('### Mutation proof', '', '| mutant | caught by |', '|---|---|');
    for (const m of r.mutation.mutants) {
      text.push(
        `| \`${m.file}:${m.line}\` ${m.operator}: \`${m.original.slice(0, 40).replace(/\|/g, '\\|')}\` → \`${m.replacement.slice(0, 40).replace(/\|/g, '\\|')}\` | ${
          mutantStatus(m) === 'killed'
            ? `✅ \`${m.killedBy}\``
            : mutantStatus(m) === 'invalid'
              ? '⛔ invalid — did not compile (not scored)'
              : mutantStatus(m) === 'error'
                ? '🛑 sandbox error — not tested (not scored; fails the gate)'
                : '⚠️ survived'
        } |`,
      );
    }
  }
  return { title: headline(r), summary: summary.slice(0, 65_000), text: text.join('\n').slice(0, 65_000) };
}

function scenarioHtml(s: ScenarioReport): string {
  const diff = rankedDiff(s.diff);
  return `<section class="scenario ${s.passed ? 'pass' : 'fail'}">
  <h3><span class="badge">${s.passed ? 'PASS' : 'FAIL'}</span> ${esc(s.id)}</h3>
  <p class="title">${esc(s.title)}</p>
  ${s.failures.length ? `<ul class="failures">${s.failures.map((f) => `<li><b>step ${f.step + 1}</b> <code>${esc(f.stepName)}</code>: ${esc(f.message)}</li>`).join('')}</ul>` : ''}
  <details ${s.passed ? '' : 'open'}><summary>Behavior diff vs base (${diff.length} change${diff.length === 1 ? '' : 's'})</summary>
  ${
    diff.length
      ? `<table class="diff"><thead><tr><th>step</th><th>where</th><th>base</th><th>head</th></tr></thead><tbody>${diff
          .map(
            (e) =>
              `<tr class="${e.kind}"><td>${e.step >= 0 ? e.step + 1 : 'final'}</td><td><code>${esc(diffLabel(e))}</code></td><td><code>${esc(short(e.before, 300))}</code></td><td><code>${esc(short(e.after, 300))}</code></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<p>No behavior difference from base.</p>'
  }
  </details>
</section>`;
}

export function renderHtml(r: GateReport): string {
  const m = r.mutation;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sluice Gate report</title>
<style>
:root{--bg:#fbfaf9;--fg:#1d1b1a;--muted:#6b6560;--card:#fff;--line:#e7e2dd;--pass:#0f7b45;--fail:#c22a3a;--add:#e7f6ec;--rem:#fdecee;--chg:#fff6e0;--accent:#db2777}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141211;--fg:#ece8e4;--muted:#a59e97;--card:#1d1b1a;--line:#33302d;--pass:#4cc38a;--fail:#ff6b7a;--add:#14301f;--rem:#3a1a1e;--chg:#3a3016}}
:root[data-theme=dark]{--bg:#141211;--fg:#ece8e4;--muted:#a59e97;--card:#1d1b1a;--line:#33302d;--pass:#4cc38a;--fail:#ff6b7a;--add:#14301f;--rem:#3a1a1e;--chg:#3a3016}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}h3{font-size:15px;margin:0 0 4px}
.verdict{border-radius:12px;padding:16px 20px;color:#fff;background:var(--fail)}.verdict.pass{background:var(--pass)}
.verdict p{margin:4px 0 0;opacity:.9}.meta{color:var(--muted);font-size:13px;margin:8px 0 0}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.scenario{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--pass);border-radius:10px;padding:14px 16px;margin:10px 0}
.scenario.fail{border-left-color:var(--fail)}.badge{font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 6px;border-radius:4px;color:#fff;background:var(--pass);margin-right:6px}
.fail .badge{background:var(--fail)}.title{margin:0 0 8px;color:var(--muted)}.failures{margin:6px 0 10px;padding-left:18px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}tr.added td{background:var(--add)}tr.removed td{background:var(--rem)}tr.changed td{background:var(--chg)}
.table-wrap{overflow-x:auto}summary{cursor:pointer;color:var(--muted)}ul.reasons{padding-left:18px}
.killed{color:var(--pass);font-weight:600}.survived{color:var(--fail);font-weight:600}.invalid{color:var(--muted);font-weight:600}.error{color:var(--fail);font-weight:600}pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);padding:10px;border-radius:8px}
</style></head><body><main>
<div class="verdict ${r.verdict}"><h1>${r.verdict === 'pass' ? '✔ Gate open' : '✘ Gate closed'} — ${esc(r.ticket.id)}</h1><p>${esc(headline(r))}</p></div>
<p class="meta">Ticket: <b>${esc(r.ticket.title)}</b> · base <code>${esc(r.base.ref)}@${r.base.sha.slice(0, 8)}</code> → head <code>${esc(r.head.ref)}@${r.head.sha.slice(0, 8)}</code> · ${(r.durationMs / 1000).toFixed(1)}s</p>
${r.reasons.length ? `<h2>Why the gate is closed</h2><ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
<h2>Approved acceptance scenarios</h2>
${r.scenarios.map(scenarioHtml).join('\n')}
${
  r.approvals.filter((a) => a.status !== 'approved').length
    ? `<p>Not run (not approved): ${r.approvals
        .filter((a) => a.status !== 'approved')
        .map((a) => `<code>${esc(a.scenario)}</code> (${a.status})`)
        .join(', ')}</p>`
    : ''
}
<h2>Mutation proof</h2>
<p>${m.enabled ? `Sluice deliberately broke the changed code ${validMutants(m)} way${validMutants(m) === 1 ? '' : 's'}; the approved checks caught <b>${m.killed}</b>${m.score === null ? '' : ` (${Math.round(m.score * 100)}%, threshold ${Math.round(m.threshold * 100)}%)`}.${m.invalid ? ` ${m.invalid} more mutant${m.invalid === 1 ? '' : 's'} did not compile and ${m.invalid === 1 ? 'is' : 'are'} not scored.` : ''}${m.errored ? ` ${m.errored} mutant run${m.errored === 1 ? '' : 's'} hit sandbox errors and ${m.errored === 1 ? 'was' : 'were'} not tested, so the proof is inconclusive.` : ''}` : 'Disabled.'}</p>
${
  m.mutants.length
    ? `<div class="table-wrap"><table><thead><tr><th>where</th><th>mutation</th><th>result</th></tr></thead><tbody>${m.mutants
        .map(
          (x) =>
            `<tr><td><code>${esc(x.file)}:${x.line}</code></td><td>${esc(x.operator)}: <code>${esc(x.original.slice(0, 80))}</code> → <code>${esc(x.replacement.slice(0, 80))}</code></td><td>${
              mutantStatus(x) === 'killed'
                ? `<span class="killed">caught</span> by <code>${esc(x.killedBy)}</code>`
                : mutantStatus(x) === 'invalid'
                  ? `<span class="invalid">invalid</span> — did not compile (not scored)${x.detail ? `<details><summary>output</summary><pre>${esc(x.detail)}</pre></details>` : ''}`
                  : mutantStatus(x) === 'error'
                    ? `<span class="error">sandbox error</span> — not tested (not scored)${x.detail ? `<details><summary>output</summary><pre>${esc(x.detail)}</pre></details>` : ''}`
                    : '<span class="survived">survived</span>'
            }</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : ''
}
${r.unitTests ? `<h2>PR unit tests</h2><p><code>${esc(r.unitTests.command)}</code>: <b>${r.unitTests.passed ? 'passed' : `failed (exit ${r.unitTests.exitCode})`}</b> — shown for contrast; the gate judges behaviour, not the PR's own tests.</p><pre>${esc(r.unitTests.outputTail)}</pre>` : ''}
<h2>Approvals</h2>
<div class="table-wrap"><table><thead><tr><th>scenario</th><th>status</th><th>approved by</th><th>sha256</th></tr></thead><tbody>${r.approvals
    .map(
      (a) =>
        `<tr><td><code>${esc(a.scenario)}</code></td><td>${esc(a.status)}</td><td>${esc(a.approvedBy ?? '—')}</td><td><code>${a.sha256.slice(0, 12)}</code></td></tr>`,
    )
    .join('')}</tbody></table></div>
${r.integrity.gateFilesModified.length ? `<p class="survived">The change modifies gate definitions: ${r.integrity.gateFilesModified.map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>` : ''}
${r.contractViolations.length ? `<h2>Fake contract violations</h2><ul>${r.contractViolations.map((v) => `<li><code>${esc(v)}</code></li>`).join('')}</ul>` : ''}
<h2>Ticket spec</h2><pre>${esc(r.ticket.spec)}</pre>
</main></body></html>
`;
}

export function writeReport(r: GateReport, dir: string): { json: string; html: string } {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `gate-${r.ticket.id}-${r.head.sha.slice(0, 8)}`);
  writeFileSync(`${base}.json`, JSON.stringify(r, null, 2) + '\n');
  writeFileSync(`${base}.html`, renderHtml(r));
  return { json: `${base}.json`, html: `${base}.html` };
}

export async function postCheckRun(
  r: GateReport,
  opts: { repo: string; token: string; baseUrl?: string; reportUrl?: string; name?: string },
): Promise<{ id: number; html_url: string }> {
  const { owner, repo } = parseRepo(opts.repo);
  const gh = new GitHubClient({ baseUrl: opts.baseUrl, token: opts.token });
  const md = renderMarkdown(r, { reportUrl: opts.reportUrl });
  return gh.createCheckRun(owner, repo, {
    name: opts.name ?? 'Sluice Gate',
    head_sha: r.head.sha,
    status: 'completed',
    conclusion: r.verdict === 'pass' ? 'success' : 'failure',
    external_id: `${r.ticket.id}:${r.head.sha}`,
    ...(opts.reportUrl ? { details_url: opts.reportUrl } : {}),
    output: md,
  });
}
