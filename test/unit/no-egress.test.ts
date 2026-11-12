import net from 'node:net';
import { describe, expect, it } from 'vitest';

describe('test egress guard', () => {
  it('blocks connections to non-loopback hosts', () => {
    expect(() => net.connect({ host: 'api.stripe.com', port: 443 })).toThrow(/blocked egress/);
    expect(() => net.connect(443, '93.184.216.34')).toThrow(/blocked egress/);
  });
  it('blocks fetch to real hosts', async () => {
    await expect(fetch('https://api.github.com/')).rejects.toThrow();
  });
  it('allows loopback', async () => {
    const server = net.createServer((s) => s.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const data = await new Promise<string>((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port });
      let buf = '';
      c.on('data', (d) => (buf += d));
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });
    server.close();
    expect(data).toBe('ok');
  });
});
