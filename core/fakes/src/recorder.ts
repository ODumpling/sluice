/**
 * Recording proxy: forwards requests to a real (or staging) API and writes a
 * cassette of exchanges. Cassettes are the "recorded traffic" half of fake
 * generation: drift detection replays them against the fake. Never used
 * against real third parties in tests (tests point it at a local server).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, readFileSync } from 'node:fs';
import type { Json } from './contract.js';
import { decodeForm } from './form.js';

export interface CassetteEntry {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  status: number;
  response: Json;
}

/** Header names never written to cassettes. */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

export interface RecordingProxyOptions {
  target: string;
  /** JSONL output file. */
  out: string;
  /** Strings to redact from bodies (e.g. API keys). */
  redact?: string[];
  port?: number;
}

function redactJson(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join('[REDACTED]');
  return t;
}

export class RecordingProxy {
  private server: http.Server | undefined;
  constructor(private readonly opts: RecordingProxyOptions) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === 'host' || k === 'content-length' || v === undefined) continue;
          headers[k] = Array.isArray(v) ? v.join(',') : v;
        }
        try {
          const upstream = await fetch(new URL(req.url ?? '/', this.opts.target), {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw,
          });
          const text = await upstream.text();
          const url = new URL(req.url ?? '/', 'http://x');
          let response: Json;
          try {
            response = JSON.parse(text) as Json;
          } catch {
            response = text;
          }
          const body =
            headers['content-type']?.includes('json') && raw
              ? (JSON.parse(raw) as Record<string, unknown>)
              : decodeForm(raw);
          const entry: CassetteEntry = {
            method: req.method ?? 'GET',
            path: url.pathname,
            query: decodeForm(url.searchParams),
            body,
            status: upstream.status,
            response,
          };
          appendFileSync(this.opts.out, redactJson(JSON.stringify(entry), this.opts.redact ?? []) + '\n');
          const outHeaders: Record<string, string> = {};
          upstream.headers.forEach((v, k) => {
            if (!SECRET_HEADERS.has(k) && k !== 'content-encoding' && k !== 'content-length') outHeaders[k] = v;
          });
          res.writeHead(upstream.status, outHeaders);
          res.end(text);
        } catch (e) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `recording proxy: ${(e as Error).message}` } }));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.opts.port ?? 0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export function readCassette(file: string): CassetteEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CassetteEntry);
}
