// Hermetic network guard for every test: any TCP connection to a non-loopback
// address throws. Tests talk only to loopback (published sandbox ports, fakes).
// Docker CLI subprocesses are unaffected (they use the local socket).
import net from 'node:net';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const extra = (process.env.SLUICE_TEST_ALLOW_HOSTS ?? '').split(',').filter(Boolean);
for (const h of extra) LOOPBACK.add(h);

type ConnectFn = (...args: unknown[]) => net.Socket;
const proto = net.Socket.prototype as unknown as { connect: ConnectFn; __sluiceGuard?: boolean };
if (!proto.__sluiceGuard) {
  const original = proto.connect;
  proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const first = args[0] as unknown;
    let host: string | undefined;
    let isPath = false;
    if (Array.isArray(first)) {
      const opts = first[0] as { host?: string; path?: string } | undefined;
      host = opts?.host;
      isPath = Boolean(opts?.path);
    } else if (typeof first === 'object' && first !== null) {
      const opts = first as { host?: string; path?: string };
      host = opts.host;
      isPath = Boolean(opts.path);
    } else if (typeof first === 'string' && Number.isNaN(Number(first))) {
      isPath = true; // unix socket path
    } else {
      host = typeof args[1] === 'string' ? (args[1] as string) : undefined;
    }
    if (!isPath && host !== undefined && !LOOPBACK.has(host)) {
      throw new Error(`[sluice test guard] blocked egress to ${host}: tests must not make real network calls`);
    }
    return original.apply(this, args);
  };
  proto.__sluiceGuard = true;
}
