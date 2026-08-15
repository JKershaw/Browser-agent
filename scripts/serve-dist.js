#!/usr/bin/env node
/**
 * Serve the built single-file artifact.
 *
 * `npm run serve:dist` — the quickest way to check the real deliverable in a
 * browser, and the closest local equivalent of GitHub Pages.
 */

import { startStaticServer } from '../tests/e2e/test-server.js';

const port = Number(process.env.PORT) || 4173;
const server = await startStaticServer(port);

console.log(`dist/index.html is being served at ${server.url}`);
console.log('Press Ctrl-C to stop.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
