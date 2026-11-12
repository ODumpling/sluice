// Sluice determinism shim for Node apps. Loaded with NODE_OPTIONS=--require.
// Freezes the clock (Date), seeds randomness (Math.random, crypto.randomUUID,
// crypto.randomBytes, crypto.getRandomValues) and exposes a control server so
// Sluice can move time: POST /clock {"nowMs":...}, GET /state.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

let nowMs = Number(process.env.SLUICE_NOW_MS || Date.UTC(2030, 0, 15, 12));
const seed = Number(process.env.SLUICE_SEED || 1);

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);

const RealDate = Date;
function SluiceDate(...args) {
  if (!new.target) return new RealDate(nowMs).toString();
  return args.length ? new RealDate(...args) : new RealDate(nowMs);
}
SluiceDate.prototype = RealDate.prototype;
SluiceDate.now = () => nowMs;
SluiceDate.UTC = RealDate.UTC;
SluiceDate.parse = RealDate.parse;
globalThis.Date = SluiceDate;

Math.random = rng;

function fill(buf) {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(rng() * 256);
  return buf;
}
function patch(obj, key, value) {
  if (!obj) return;
  try {
    Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true });
  } catch {
    try {
      obj[key] = value;
    } catch {
      // non-writable in this runtime; leave the original in place
    }
  }
}

patch(crypto, 'randomBytes', function randomBytes(size, cb) {
  const b = fill(Buffer.alloc(size));
  if (typeof cb === 'function') {
    process.nextTick(cb, null, b);
    return undefined;
  }
  return b;
});
patch(crypto, 'randomFillSync', function randomFillSync(buf, offset = 0, size) {
  const view = new Uint8Array(buf.buffer ?? buf, (buf.byteOffset ?? 0) + offset, size ?? buf.byteLength - offset);
  fill(view);
  return buf;
});
const getRandomValues = (arr) => {
  fill(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  return arr;
};
const randomUUID = () => {
  const b = fill(Buffer.alloc(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
patch(crypto, 'getRandomValues', getRandomValues);
patch(crypto, 'randomUUID', randomUUID);
const web = globalThis.crypto || crypto.webcrypto;
if (web) {
  // webcrypto methods live on Crypto.prototype; shadow them on the instance.
  patch(web, 'getRandomValues', getRandomValues);
  patch(web, 'randomUUID', randomUUID);
}

const port = Number(process.env.SLUICE_CONTROL_PORT || 0);
if (port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/clock') {
        const v = JSON.parse(body || '{}');
        if (typeof v.nowMs === 'number') nowMs = v.nowMs;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nowMs, seed }));
    });
  });
  server.on('error', () => {}); // e.g. a second node process in the same container (docker exec)
  server.listen(port, '0.0.0.0');
  server.unref();
}
