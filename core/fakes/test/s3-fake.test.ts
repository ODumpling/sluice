import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ServiceException,
} from '@aws-sdk/client-s3';
import { FakeServer, S3Fake, SimClock } from '@sluice-dev/fakes';

const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
const fake = new S3Fake({ clock });
const server = new FakeServer(fake, { clock });
const client = (secret = 'sluice-fake-secret', accessKeyId = 'AKIASLUICEFAKE000001') =>
  new S3Client({
    endpoint: server.url,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey: secret },
    maxAttempts: 1,
  });

describe('S3 fake via the official AWS SDK v3', () => {
  beforeAll(() => server.start());
  afterAll(() => server.stop());
  beforeEach(() => server.reset(1));

  it('buckets and objects round-trip with metadata, ranges and copies', async () => {
    const s3 = client();
    await s3.send(new CreateBucketCommand({ Bucket: 'invoices' }));
    await s3.send(
      new PutObjectCommand({
        Bucket: 'invoices',
        Key: '2030/01/inv 1.pdf',
        Body: 'PDF-BYTES',
        ContentType: 'application/pdf',
        Metadata: { customer: 'ada' },
      }),
    );
    const got = await s3.send(new GetObjectCommand({ Bucket: 'invoices', Key: '2030/01/inv 1.pdf' }));
    expect(await got.Body!.transformToString()).toBe('PDF-BYTES');
    expect(got.ContentType).toBe('application/pdf');
    expect(got.Metadata).toEqual({ customer: 'ada' });
    const part = await s3.send(
      new GetObjectCommand({ Bucket: 'invoices', Key: '2030/01/inv 1.pdf', Range: 'bytes=0-2' }),
    );
    expect(await part.Body!.transformToString()).toBe('PDF');
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'invoices', Key: '2030/01/inv 1.pdf' }));
    expect(head.ContentLength).toBe(9);
    await s3.send(
      new CopyObjectCommand({ Bucket: 'invoices', Key: 'archive/inv1.pdf', CopySource: 'invoices/2030/01/inv 1.pdf' }),
    );
    expect(fake.object('invoices', 'archive/inv1.pdf')?.toString()).toBe('PDF-BYTES');
    expect((await s3.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name)).toEqual(['invoices']);
  });

  it('ListObjectsV2 supports prefix, delimiter and pagination', async () => {
    const s3 = client();
    await s3.send(new CreateBucketCommand({ Bucket: 'docs' }));
    for (const k of ['a/1', 'a/2', 'a/3', 'b/1', 'root.txt'])
      await s3.send(new PutObjectCommand({ Bucket: 'docs', Key: k, Body: k }));
    const top = await s3.send(new ListObjectsV2Command({ Bucket: 'docs', Delimiter: '/' }));
    expect(top.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['a/', 'b/']);
    expect(top.Contents?.map((c) => c.Key)).toEqual(['root.txt']);
    const page1 = await s3.send(new ListObjectsV2Command({ Bucket: 'docs', Prefix: 'a/', MaxKeys: 2 }));
    expect(page1.Contents?.map((c) => c.Key)).toEqual(['a/1', 'a/2']);
    expect(page1.IsTruncated).toBe(true);
    const page2 = await s3.send(
      new ListObjectsV2Command({
        Bucket: 'docs',
        Prefix: 'a/',
        MaxKeys: 2,
        ContinuationToken: page1.NextContinuationToken,
      }),
    );
    expect(page2.Contents?.map((c) => c.Key)).toEqual(['a/3']);
  });

  it('returns S3 errors and verifies SigV4 signatures', async () => {
    const s3 = client();
    await expect(s3.send(new GetObjectCommand({ Bucket: 'nope', Key: 'x' }))).rejects.toMatchObject({
      name: 'NoSuchBucket',
    });
    await s3.send(new CreateBucketCommand({ Bucket: 'bk1' }));
    await expect(s3.send(new GetObjectCommand({ Bucket: 'bk1', Key: 'missing' }))).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
    await s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'k', Body: 'x' }));
    await expect(s3.send(new DeleteBucketCommand({ Bucket: 'bk1' }))).rejects.toMatchObject({ name: 'BucketNotEmpty' });
    await s3.send(new DeleteObjectCommand({ Bucket: 'bk1', Key: 'k' }));
    await s3.send(new DeleteBucketCommand({ Bucket: 'bk1' }));
    const bad = await client('wrong-secret')
      .send(new ListBucketsCommand({}))
      .catch((e: S3ServiceException) => e);
    expect(bad).toMatchObject({ name: 'SignatureDoesNotMatch' });
    await expect(client('x', 'AKIAUNKNOWN').send(new ListBucketsCommand({}))).rejects.toMatchObject({
      name: 'InvalidAccessKeyId',
    });
  });
});
