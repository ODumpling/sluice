/**
 * Stateful S3 fake (path-style REST, XML), the "one fake cloud API" for v0.1.
 *
 * Implemented: ListBuckets, CreateBucket, HeadBucket, DeleteBucket,
 * PutObject (with x-amz-meta-*, content-type), GetObject (incl. Range),
 * HeadObject, DeleteObject, CopyObject, ListObjectsV2 (prefix, delimiter,
 * max-keys, continuation tokens). Requests must be signed with AWS SigV4 by a
 * registered access key; signatures are fully verified (wrong secret, tampered
 * headers or payload hash → SignatureDoesNotMatch), like real S3.
 *
 * Contract: AWS publishes Smithy models rather than OpenAPI, so this fake's
 * contract tests run the official AWS SDK v3 client against it (its
 * deserializers reject malformed responses).
 */
import { createHash, createHmac } from 'node:crypto';
import type { Json } from '../contract.js';
import type { SimClock } from '../clock.js';
import type { Fake, FakeRequest, FakeResponse } from '../server.js';

interface S3Object {
  key: string;
  body: Buffer;
  etag: string;
  contentType: string;
  metadata: Record<string, string>;
  lastModified: number;
}

interface Bucket {
  name: string;
  created: number;
  objects: Map<string, S3Object>;
}

const xmlEsc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const httpDate = (ms: number) => new Date(ms).toUTCString();
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

/** RFC 3986 encoding as SigV4 requires. */
function uriEncode(s: string, encodeSlash: boolean): string {
  return [...Buffer.from(s, 'utf8')]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      if (c === '/' && !encodeSlash) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

export interface S3FakeOptions {
  clock: SimClock;
  region?: string;
  /** accessKeyId -> secretAccessKey */
  credentials?: Record<string, string>;
}

export class S3Fake implements Fake {
  readonly name = 's3';
  readonly rawBodies = true;
  private buckets = new Map<string, Bucket>();
  private readonly clock: SimClock;
  readonly region: string;
  private readonly credentials: Record<string, string>;

  constructor(opts: S3FakeOptions) {
    this.clock = opts.clock;
    this.region = opts.region ?? 'us-east-1';
    this.credentials = opts.credentials ?? { AKIASLUICEFAKE000001: 'sluice-fake-secret' };
  }

  reset(): void {
    this.buckets = new Map();
  }

  state(): Json {
    return {
      buckets: [...this.buckets.values()].map((b) => ({
        name: b.name,
        objects: [...b.objects.values()]
          .sort((x, y) => x.key.localeCompare(y.key))
          .map((o) => ({
            key: o.key,
            size: o.body.length,
            etag: o.etag,
            contentType: o.contentType,
            metadata: o.metadata,
            sha256: sha256(o.body),
          })),
      })),
    };
  }

  /** Test helper: read an object's bytes. */
  object(bucket: string, key: string): Buffer | undefined {
    return this.buckets.get(bucket)?.objects.get(key)?.body;
  }

  error(status: number, code: string, extra: Record<string, string> = {}): FakeResponse {
    const message = extra.Message ?? code;
    const fields = Object.entries({ Code: code, Message: message, ...extra })
      .map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`)
      .join('');
    const raw = `<?xml version="1.0" encoding="UTF-8"?>\n<Error>${fields}<RequestId>sluice</RequestId></Error>`;
    return {
      status,
      body: { error: code, message },
      raw,
      headers: { 'content-type': 'application/xml', 'x-amz-request-id': 'sluice' },
    };
  }

  private xml(status: number, body: string, summary: Json): FakeResponse {
    return {
      status,
      body: summary,
      raw: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`,
      headers: { 'content-type': 'application/xml', 'x-amz-request-id': 'sluice' },
    };
  }

  // ------------------------------------------------------------------ SigV4

  preflight(req: FakeRequest): FakeResponse | undefined {
    const auth = req.headers.authorization ?? '';
    const m =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
        auth,
      );
    if (!m) return this.error(403, 'AccessDenied', { Message: 'Request must be signed with AWS Signature Version 4' });
    const [, akid, date, region, signedHeaders, signature] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const secret = this.credentials[akid];
    if (!secret)
      return this.error(403, 'InvalidAccessKeyId', {
        Message: 'The AWS Access Key Id you provided does not exist in our records.',
      });
    if (region !== this.region)
      return this.error(400, 'AuthorizationHeaderMalformed', {
        Message: `the region '${region}' is wrong; expecting '${this.region}'`,
      });
    const amzDate = req.headers['x-amz-date'] ?? '';
    const payloadHash = req.headers['x-amz-content-sha256'] ?? '';
    if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256(req.rawBody)) {
      return this.error(400, 'XAmzContentSHA256Mismatch', {
        Message: 'The provided x-amz-content-sha256 header does not match what was computed.',
      });
    }
    const [rawPath, rawQuery = ''] = req.rawUrl.split('?') as [string, string?];
    const canonicalUri = uriEncode(decodeURIComponent(rawPath!), false);
    const canonicalQuery = rawQuery
      .split('&')
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf('=');
        const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
        const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        return [uriEncode(k, true), uriEncode(v, true)] as const;
      })
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const names = signedHeaders.split(';');
    const canonicalHeaders = names.map((h) => `${h}:${(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
    const canonicalRequest = [
      req.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
    const expected = createHmac('sha256', key).update(stringToSign).digest('hex');
    if (expected !== signature) {
      return this.error(403, 'SignatureDoesNotMatch', {
        Message: 'The request signature we calculated does not match the signature you provided.',
      });
    }
    return undefined;
  }

  // ------------------------------------------------------------------ routing

  handle(req: FakeRequest): FakeResponse {
    const parts = req.path.split('/').filter((_, i) => i > 0);
    const bucketName = decodeURIComponent(parts[0] ?? '');
    const key = parts.length > 1 ? decodeURIComponent(req.path.slice(bucketName.length + 2)) : '';
    const q = new URL(req.rawUrl, 'http://x').searchParams;
    const m = req.method;
    const now = this.clock.now();

    if (!bucketName) {
      if (m !== 'GET') return this.error(405, 'MethodNotAllowed');
      const items = [...this.buckets.values()]
        .map((b) => `<Bucket><Name>${xmlEsc(b.name)}</Name><CreationDate>${iso(b.created)}</CreationDate></Bucket>`)
        .join('');
      return this.xml(
        200,
        `<ListAllMyBucketsResult><Owner><ID>sluice</ID><DisplayName>sluice</DisplayName></Owner><Buckets>${items}</Buckets></ListAllMyBucketsResult>`,
        { buckets: [...this.buckets.keys()] },
      );
    }
    const bucket = this.buckets.get(bucketName);

    if (!key) {
      if (m === 'PUT') {
        if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) return this.error(400, 'InvalidBucketName');
        if (bucket) return this.error(409, 'BucketAlreadyOwnedByYou', { BucketName: bucketName });
        this.buckets.set(bucketName, { name: bucketName, created: now, objects: new Map() });
        return { status: 200, body: { created: bucketName }, raw: '', headers: { location: `/${bucketName}` } };
      }
      if (!bucket) return this.error(404, 'NoSuchBucket', { BucketName: bucketName });
      if (m === 'HEAD') return { status: 200, body: {}, raw: '', headers: { 'x-amz-bucket-region': this.region } };
      if (m === 'DELETE') {
        if (bucket.objects.size) return this.error(409, 'BucketNotEmpty', { BucketName: bucketName });
        this.buckets.delete(bucketName);
        return { status: 204, body: null };
      }
      if (m === 'GET' && q.get('list-type') === '2') return this.listV2(bucket, q);
      return this.error(501, 'NotImplemented', {
        Message: `the S3 fake does not implement ${m} on a bucket with this query`,
      });
    }

    if (!bucket) return this.error(404, 'NoSuchBucket', { BucketName: bucketName });
    const obj = bucket.objects.get(key);
    if (m === 'PUT') {
      const copySource = req.headers['x-amz-copy-source'];
      let body = req.rawBody;
      let contentType = req.headers['content-type'] ?? 'binary/octet-stream';
      let metadata: Record<string, string> = {};
      for (const [h, v] of Object.entries(req.headers))
        if (h.startsWith('x-amz-meta-') && v !== undefined) metadata[h.slice(11)] = v;
      if (copySource) {
        const src = decodeURIComponent(copySource.replace(/^\//, ''));
        const [sb, ...rest] = src.split('/');
        const so = this.buckets.get(sb!)?.objects.get(rest.join('/'));
        if (!so) return this.error(404, 'NoSuchKey', { Key: rest.join('/') });
        body = so.body;
        if (req.headers['x-amz-metadata-directive'] !== 'REPLACE') {
          contentType = so.contentType;
          metadata = { ...so.metadata };
        }
      }
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      bucket.objects.set(key, { key, body: Buffer.from(body), etag, contentType, metadata, lastModified: now });
      if (copySource) {
        return this.xml(
          200,
          `<CopyObjectResult><LastModified>${iso(now)}</LastModified><ETag>${xmlEsc(etag)}</ETag></CopyObjectResult>`,
          { copied: key },
        );
      }
      return { status: 200, body: { put: key, etag }, raw: '', headers: { etag } };
    }
    if (m === 'DELETE') {
      bucket.objects.delete(key);
      return { status: 204, body: null };
    }
    if (m === 'GET' || m === 'HEAD') {
      if (!obj)
        return m === 'HEAD'
          ? { status: 404, body: { error: 'NotFound' }, raw: '' }
          : this.error(404, 'NoSuchKey', { Key: key });
      const headers: Record<string, string> = {
        'content-type': obj.contentType,
        'content-length': String(obj.body.length),
        etag: obj.etag,
        'last-modified': httpDate(obj.lastModified),
        'accept-ranges': 'bytes',
      };
      for (const [k, v] of Object.entries(obj.metadata)) headers[`x-amz-meta-${k}`] = v;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && m === 'GET') {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), obj.body.length - 1) : obj.body.length - 1;
        if (start >= obj.body.length) return this.error(416, 'InvalidRange');
        const slice = obj.body.subarray(start, end + 1);
        return {
          status: 206,
          body: { get: key, range: [start, end] },
          raw: slice,
          headers: {
            ...headers,
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${obj.body.length}`,
          },
        };
      }
      return {
        status: 200,
        body: { [m === 'GET' ? 'get' : 'head']: key, size: obj.body.length },
        raw: m === 'GET' ? obj.body : '',
        headers,
      };
    }
    return this.error(405, 'MethodNotAllowed');
  }

  private listV2(bucket: Bucket, q: URLSearchParams): FakeResponse {
    const prefix = q.get('prefix') ?? '';
    const delimiter = q.get('delimiter') ?? '';
    const max = Math.min(Number(q.get('max-keys') ?? 1000), 1000);
    const after = q.get('continuation-token')
      ? Buffer.from(q.get('continuation-token')!, 'base64url').toString('utf8')
      : (q.get('start-after') ?? '');
    const keys = [...bucket.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    const contents: S3Object[] = [];
    const prefixes = new Set<string>();
    let truncated = false;
    let last = '';
    for (const k of keys) {
      if (contents.length + prefixes.size >= max) {
        truncated = true;
        break;
      }
      const rest = k.slice(prefix.length);
      const di = delimiter ? rest.indexOf(delimiter) : -1;
      if (di >= 0) {
        const p = prefix + rest.slice(0, di + delimiter.length);
        if (!prefixes.has(p)) prefixes.add(p);
        last = k;
        continue;
      }
      contents.push(bucket.objects.get(k)!);
      last = k;
    }
    const body =
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEsc(bucket.name)}</Name><Prefix>${xmlEsc(prefix)}</Prefix>` +
      `<KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>${max}</MaxKeys>${delimiter ? `<Delimiter>${xmlEsc(delimiter)}</Delimiter>` : ''}<IsTruncated>${truncated}</IsTruncated>` +
      (truncated ? `<NextContinuationToken>${Buffer.from(last).toString('base64url')}</NextContinuationToken>` : '') +
      contents
        .map(
          (o) =>
            `<Contents><Key>${xmlEsc(o.key)}</Key><LastModified>${iso(o.lastModified)}</LastModified><ETag>${xmlEsc(o.etag)}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
        )
        .join('') +
      [...prefixes].map((p) => `<CommonPrefixes><Prefix>${xmlEsc(p)}</Prefix></CommonPrefixes>`).join('') +
      `</ListBucketResult>`;
    return this.xml(200, body, { list: contents.map((o) => o.key), prefixes: [...prefixes], truncated });
  }
}
