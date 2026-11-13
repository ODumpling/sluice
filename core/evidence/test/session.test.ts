import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sandbox } from '@sluice-dev/sandbox';
import { runScript } from '../src/session.js';

// A script step's headers get `${var}` interpolation like path and body, so a
// token saved from a login response can authenticate later steps.
describe('runScript http steps', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/login') return res.end(JSON.stringify({ token: 'tok-123' }));
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, tenant: req.headers['x-tenant'] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('interpolates saved variables into request headers', async () => {
    const sb = {
      spec: {},
      ingressUrl: url,
      fakes: new Map(),
      deterministicServices: [],
      clock: { now: () => 0 },
    } as unknown as Sandbox;
    const session = await runScript(
      sb,
      {
        name: 'auth',
        steps: [
          { http: { method: 'POST', path: '/login' }, save: { token: 'body.token' } },
          {
            http: {
              method: 'GET',
              path: '/me',
              headers: { authorization: 'Bearer ${token}', 'x-tenant': '${tenant}' },
            },
          },
        ],
      },
      { reset: false, vars: { tenant: 'acme' } },
    );
    expect(session.steps[1]!.response!.body).toEqual({ authorization: 'Bearer tok-123', tenant: 'acme' });
  });
});
