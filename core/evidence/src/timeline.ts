/**
 * Timeline view of a session: per step, what the user (or script) did, what
 * the frontend requested, and the data changes that followed — DB writes,
 * calls to third parties, domain events. Self-contained HTML (screenshots are
 * inlined), used by `sluice timeline` and embedded in gate reports.
 */
import type { Json } from '@sluice-dev/fakes';
import type { DbChange } from './audit.js';
import type { Session, StepEvidence } from './session.js';

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function short(v: unknown, n = 160): string {
  const s = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One DB write as a line: INSERT shows the row, UPDATE only the changed columns. */
export function describeDbChange(c: DbChange): string {
  const row = (isObj(c.new) ? c.new : isObj(c.old) ? c.old : {}) as Record<string, Json>;
  const id = row.id !== undefined ? ` #${short(row.id, 40)}` : '';
  const { old: before, new: after } = c;
  if (c.op === 'UPDATE' && isObj(before) && isObj(after)) {
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    const parts = changed.map((k) => `${k}: ${short(before[k], 40)} → ${short(after[k], 40)}`);
    return `${c.table}${id} UPDATE ${parts.join(', ') || '(no column changed)'}`;
  }
  return `${c.table}${id} ${c.op} ${short(c.op === 'DELETE' ? c.old : c.new, 200)}`;
}

const status = (s: number | null | undefined) =>
  s === null || s === undefined
    ? '<span class="tl-bad">failed</span>'
    : `<span class="${s >= 400 ? 'tl-bad' : 'tl-ok'}">${s}</span>`;

function list(title: string, items: string[], empty?: string): string {
  if (!items.length) return empty ? `<div class="tl-col"><h5>${title}</h5><p class="tl-none">${empty}</p></div>` : '';
  return `<div class="tl-col"><h5>${title}</h5><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`;
}

function stepHtml(st: StepEvidence, failures: string[]): string {
  const front: string[] = [];
  if (st.browser) {
    const b = st.browser;
    if (b.error) front.push(`<span class="tl-bad">${esc(b.error)}</span>`);
    front.push(`page <code>${esc(b.url)}</code>${b.title ? ` — ${esc(b.title)}` : ''}`);
    if (b.text.length) front.push(`shows <span class="tl-muted">${esc(short(b.text.join(' · '), 220))}</span>`);
    for (const r of b.network)
      front.push(
        `<code>${esc(r.method)} ${esc(short(r.path, 90))}</code> → ${status(r.status)}${r.failure ? ` <span class="tl-bad">${esc(r.failure)}</span>` : ''}${r.body !== undefined ? ` <code class="tl-muted">${esc(short(r.body, 90))}</code>` : ''}`,
      );
    for (const c of b.console) front.push(`<span class="tl-bad">${esc(short(c, 200))}</span>`);
  } else if (st.request && st.response) {
    front.push(
      `<code>${esc(st.request.method)} ${esc(st.request.path)}</code> → ${status(st.response.status)}${st.request.body !== null ? ` <code class="tl-muted">${esc(short(st.request.body, 90))}</code>` : ''}`,
    );
    front.push(`<code class="tl-muted">${esc(short(st.response.body, 160))}</code>`);
  }
  const shot = st.browser?.screenshot
    ? `<details class="tl-shot"><summary><img src="${st.browser.screenshot}" alt="Page after: ${esc(st.browser.action)}" loading="lazy"></summary><img src="${st.browser.screenshot}" alt=""></details>`
    : '';
  const data = st.db.map((c) => `<code>${esc(describeDbChange(c))}</code>`);
  const outside = [
    ...st.egress.map(
      (e) =>
        `<code>${esc(e.fake)} ${esc(e.method)} ${esc(short(e.path, 70))}</code> → ${status(e.status)}${e.body !== null && e.body !== undefined && JSON.stringify(e.body) !== '{}' ? ` <code class="tl-muted">${esc(short(e.body, 90))}</code>` : ''}`,
    ),
    ...st.events.map((e) => `event <code>${esc(short(e, 160))}</code>`),
  ];
  const quiet = st.kind === 'advance' || st.kind === 'clock' || st.kind === 'check';
  return `<li class="tl-step${failures.length ? ' tl-fail' : ''}">
  <div class="tl-head"><span class="tl-n">${st.index + 1}</span><span class="tl-kind">${esc(st.kind)}</span><code>${esc(st.name)}</code></div>
  ${failures.map((f) => `<p class="tl-bad tl-failure">${esc(f)}</p>`).join('')}
  ${
    quiet && !data.length && !outside.length
      ? ''
      : `<div class="tl-body">${shot}<div class="tl-cols">${list(st.browser ? 'Frontend' : 'Request', front)}${list('Data changes', data, quiet ? undefined : 'none')}${list('Third parties &amp; events', outside)}</div></div>`
  }
</li>`;
}

/** Scoped styles; uses the host page's --line/--muted/--card/--fail/--pass tokens when present. */
export const TIMELINE_CSS = `
.tl{list-style:none;margin:8px 0 0;padding:0}
.tl-step{border:1px solid var(--line,#e3dfdb);border-radius:8px;padding:10px 12px;margin:8px 0;background:var(--card,#fff)}
.tl-step.tl-fail{border-color:var(--fail,#c22a3a)}
.tl-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.tl-n{font-weight:700;min-width:1.5em}.tl-kind{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#6b6560)}
.tl-body{display:flex;gap:12px;margin-top:8px;flex-wrap:wrap}
.tl-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;flex:1;min-width:0}
.tl-col h5{margin:0 0 4px;font-size:12px;color:var(--muted,#6b6560);font-weight:600}
.tl-col ul{margin:0;padding-left:16px}.tl-col li{margin:2px 0;font-size:13px;overflow-wrap:anywhere}
.tl-none{margin:0;font-size:13px;color:var(--muted,#6b6560)}
.tl-muted{color:var(--muted,#6b6560)}.tl-bad{color:var(--fail,#c22a3a)}.tl-ok{color:var(--pass,#0f7b45)}
.tl-failure{margin:6px 0 0;font-size:13px}
.tl-shot{flex:0 0 auto}.tl-shot summary{list-style:none;cursor:zoom-in}.tl-shot summary::-webkit-details-marker{display:none}
.tl-shot summary img{width:240px;max-width:100%;border:1px solid var(--line,#e3dfdb);border-radius:6px;display:block}
.tl-shot[open] summary{cursor:zoom-out}.tl-shot[open]>img{display:block;max-width:100%;margin-top:6px;border:1px solid var(--line,#e3dfdb);border-radius:6px}
`;

/** Timeline fragment (an <ol>). `failures` maps step index -> messages to flag on that step. */
export function renderTimeline(steps: StepEvidence[], failures: Map<number, string[]> = new Map()): string {
  return `<ol class="tl">${steps.map((s) => stepHtml(s, failures.get(s.index) ?? [])).join('\n')}</ol>`;
}

/** Standalone page for one session. */
export function renderSessionHtml(s: Session): string {
  const writes = s.steps.reduce((n, st) => n + st.db.length, 0);
  const calls = s.steps.reduce((n, st) => n + st.egress.length, 0);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sluice timeline</title>
<style>
:root{--bg:#fbfaf9;--fg:#1d1b1a;--muted:#6b6560;--card:#fff;--line:#e7e2dd;--pass:#0f7b45;--fail:#c22a3a}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141211;--fg:#ece8e4;--muted:#a59e97;--card:#1d1b1a;--line:#33302d;--pass:#4cc38a;--fail:#ff6b7a}}
:root[data-theme=dark]{--bg:#141211;--fg:#ece8e4;--muted:#a59e97;--card:#1d1b1a;--line:#33302d;--pass:#4cc38a;--fail:#ff6b7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:20px;margin:0 0 4px}
.meta{color:var(--muted);font-size:13px;margin:0 0 12px}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
${TIMELINE_CSS}
</style></head><body><main>
<h1>${esc(s.script.name)}</h1>
<p class="meta">${esc(s.label)} · ${s.steps.length} steps · ${writes} DB write${writes === 1 ? '' : 's'} · ${calls} third-party call${calls === 1 ? '' : 's'} · seed ${s.seed} · start ${new Date(s.startMs).toISOString()}</p>
${s.contractViolations.length ? `<p class="tl-bad">Fake contract violations: ${s.contractViolations.map(esc).join('; ')}</p>` : ''}
${renderTimeline(s.steps)}
</main></body></html>
`;
}
