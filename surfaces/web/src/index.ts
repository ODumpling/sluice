/**
 * Minimal local web UI (binds 127.0.0.1): lists tickets, shows scenarios with
 * their approval state, lets a human approve them, and serves gate reports.
 * Mutating requests require a same-origin Origin header (CSRF guard) and an
 * approver name.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { GateStore } from '@sluice-dev/plugin-gate';

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `:root{--bg:#fbfaf9;--fg:#1d1b1a;--muted:#6b6560;--card:#fff;--line:#e7e2dd;--ok:#0f7b45;--warn:#a15c00;--accent:#db2777}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141211;--fg:#ece8e4;--muted:#a59e97;--card:#1d1b1a;--line:#33302d;--ok:#4cc38a;--warn:#f0b35a}}
:root[data-theme=dark]{--bg:#141211;--fg:#ece8e4;--muted:#a59e97;--card:#1d1b1a;--line:#33302d;--ok:#4cc38a;--warn:#f0b35a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}h1{font-size:22px}h2{font-size:17px;margin-top:28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.approved{color:var(--ok);font-weight:600}.unapproved,.stale{color:var(--warn);font-weight:600}
pre{white-space:pre-wrap;font:12.5px/1.45 ui-monospace,Menlo,monospace;background:var(--bg);padding:10px;border-radius:8px;overflow-x:auto}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--accent);color:#fff;cursor:pointer}
input{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export interface WebUiOptions {
  projectRoot: string;
  port?: number;
}

export function createWebUi(opts: WebUiOptions) {
  const store = new GateStore(opts.projectRoot);
  const reportsDir = join(opts.projectRoot, '.sluice', 'reports');

  function index(): string {
    const tickets = store.tickets().filter((t) => store.hasTicket(t));
    const reports = existsSync(reportsDir)
      ? readdirSync(reportsDir)
          .filter((f) => f.endsWith('.html'))
          .sort()
          .reverse()
      : [];
    return page(
      'Sluice',
      `<h1>Sluice</h1><h2>Tickets</h2>${
        tickets
          .map((t) => {
            const st = store.state(t);
            const ok = st.filter((s) => s.status === 'approved').length;
            return `<div class="card"><a href="/tickets/${encodeURIComponent(t)}"><b>${esc(t)}</b></a> — ${esc(store.readTicket(t).title)} · ${ok}/${st.length} scenarios approved</div>`;
          })
          .join('') || '<p>No tickets yet (<code>sluice gate ticket</code>).</p>'
      }<h2>Gate reports</h2>${reports.map((r) => `<div class="card"><a href="/reports/${encodeURIComponent(r)}">${esc(r)}</a></div>`).join('') || '<p>No reports yet.</p>'}`,
    );
  }

  function ticketPage(id: string, flash = ''): string {
    const t = store.readTicket(id);
    const states = store.state(id);
    return page(
      `${id} · Sluice`,
      `<p><a href="/">← all tickets</a></p><h1>${esc(id)}: ${esc(t.title)}</h1>${flash ? `<p class="approved">${esc(flash)}</p>` : ''}
<div class="card"><pre>${esc(t.spec)}</pre></div><h2>Acceptance scenarios</h2>
<p>Approving a scenario binds your approval to its exact content (sha256). Any later edit makes it <span class="stale">stale</span>.</p>
${states
  .map(
    (
      s,
    ) => `<div class="card"><b>${esc(s.scenario.id)}</b> — ${esc(s.scenario.title)} · <span class="${s.status}">${s.status}</span>${s.approval ? ` by ${esc(s.approval.approvedBy)}` : ''}
<details><summary>scenario</summary><pre>${esc(toYaml(s.scenario))}</pre></details>
${s.status === 'approved' ? '' : `<form method="post" action="/tickets/${encodeURIComponent(id)}/approve"><input type="hidden" name="scenario" value="${esc(s.scenario.id)}"><input name="approver" placeholder="your email" required> <button>Approve</button></form>`}</div>`,
  )
  .join('')}`,
    );
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: string, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      });
      res.end(body);
    };
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      try {
        if (req.method === 'GET' && url.pathname === '/') return send(200, index());
        const ticket = /^\/tickets\/([^/]+)(\/approve)?$/.exec(url.pathname);
        if (ticket && req.method === 'GET' && !ticket[2]) return send(200, ticketPage(decodeURIComponent(ticket[1]!)));
        if (ticket && req.method === 'POST' && ticket[2]) {
          const origin = req.headers.origin;
          if (!origin || new URL(origin).host !== req.headers.host)
            return send(403, page('Forbidden', '<p>Cross-origin request refused.</p>'));
          const form = new URLSearchParams(raw);
          const who = (form.get('approver') ?? '').trim();
          const sid = form.get('scenario') ?? '';
          if (!who || !sid) return send(400, page('Bad request', '<p>approver and scenario required</p>'));
          const id = decodeURIComponent(ticket[1]!);
          store.approve(id, who, [sid]);
          return send(200, ticketPage(id, `${who} approved ${sid}`));
        }
        const rep = /^\/reports\/([^/]+\.html)$/.exec(url.pathname);
        if (rep && req.method === 'GET') {
          const f = join(reportsDir, basename(decodeURIComponent(rep[1]!)));
          if (existsSync(f)) {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
            });
            return res.end(readFileSync(f));
          }
        }
        send(404, page('Not found', '<p>Not found.</p>'));
      } catch (e) {
        send(400, page('Error', `<p>${esc((e as Error).message)}</p>`));
      }
    });
  });

  return {
    listen(): Promise<{ url: string; close: () => Promise<void> }> {
      return new Promise((resolve) =>
        server.listen(opts.port ?? 0, '127.0.0.1', () =>
          resolve({
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            close: () => new Promise((r) => server.close(() => r())),
          }),
        ),
      );
    },
  };
}
