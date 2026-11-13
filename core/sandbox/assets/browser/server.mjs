// Sluice sandbox browser server: one headless Chromium shared by every run
// (each run opens its own fresh context), served as a Playwright WebSocket
// endpoint on :3000/. Flags are fixed here, not by clients.
import { chromium } from 'playwright-core';

const server = await chromium.launchServer({
  host: '0.0.0.0',
  port: 3000,
  wsPath: '/',
  headless: true,
  args: [
    // the app is plain http on the internal network; never upgrade or block it
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
  ],
});
console.log(`sluice browser ready: ${server.wsEndpoint()}`);
const stop = () => server.close().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
