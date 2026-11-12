// Sluice sandbox gateway (runs inside the sandbox network, no dependencies).
// FORWARDS="listenPort=targetHost:targetPort,..." — each listen port is piped to its target.
// The app containers live on an --internal network with no route out; this
// container is the only bridge, and it only forwards the ports Sluice chose:
//   host -> app (ingress), host -> db (evidence), app -> Sluice-hosted fakes (egress).
'use strict';
const net = require('node:net');

const forwards = (process.env.FORWARDS || '')
  .split(',')
  .filter(Boolean)
  .map((spec) => {
    const [listen, target] = spec.split('=');
    const i = target.lastIndexOf(':');
    return { listen: Number(listen), host: target.slice(0, i), port: Number(target.slice(i + 1)) };
  });

for (const f of forwards) {
  net
    .createServer((client) => {
      const upstream = net.connect({ host: f.host, port: f.port });
      client.pipe(upstream);
      upstream.pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
    })
    .listen(f.listen, '0.0.0.0', () => console.log(`gateway ${f.listen} -> ${f.host}:${f.port}`));
}
