import http from 'node:http';
import { createPool, migrate } from './db.js';
import { createStripe } from './stripe.js';
import { createBilling, HttpError } from './billing.js';
import { portalHtml } from './portal.js';

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function createApp({ billing }) {
  const routes = [
    ['GET', /^\/health$/, async () => [200, { ok: true }]],
    ['GET', /^\/portal\/(\d+)$/, async (m) => [200, portalHtml(m[1]), 'text/html; charset=utf-8']],
    ['POST', /^\/customers$/, async (_m, body) => [201, await billing.createCustomer(body)]],
    ['GET', /^\/customers\/(\d+)\/access$/, async (m) => [200, await billing.access(Number(m[1]))]],
    ['POST', /^\/subscriptions$/, async (_m, body) => [201, await billing.subscribe(body)]],
    ['GET', /^\/subscriptions\/(\d+)$/, async (m) => [200, await billing.getSubscription(Number(m[1]))]],
    ['POST', /^\/subscriptions\/(\d+)\/cancel$/, async (m) => [200, await billing.cancel(Number(m[1]))]],
    ['POST', /^\/jobs\/sync-subscriptions$/, async () => [200, await billing.syncSubscriptions()]],
  ];
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let status = 404;
    let payload = { error: 'not found' };
    let type = 'application/json';
    try {
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (m && req.method === method) {
          [status, payload, type = 'application/json'] = await handler(m, method === 'POST' ? await readJson(req) : {});
          break;
        }
      }
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500;
      payload = { error: err instanceof HttpError ? err.message : 'internal error' };
      if (!(err instanceof HttpError)) console.error(err);
    }
    res.writeHead(status, { 'content-type': type });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool();
  await migrate(db);
  const billing = createBilling({ db, stripe: createStripe() });
  const port = Number(process.env.PORT ?? 3000);
  createApp({ billing }).listen(port, () => console.error(`billing-demo listening on :${port}`));
}
