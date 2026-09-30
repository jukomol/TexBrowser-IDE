// Runs the browser end-to-end suites against a real Vite server.
//
//   npm run e2e                 # engine + UI suites against the dev server
//   npm run e2e -- --prod       # UI suite against the production build (run `npm run build` first)
//   npm run e2e -- --only ui    # one suite: ui | engine
//
// Both suites need the engine assets (`npm run engine:fetch`); the TikZ and
// package steps also need the package shelf (`npm run shelf:build`).
// The engine suite drives engine-harness.html, which only the dev server serves.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer, preview } from 'vite';

const args = process.argv.slice(2);
const prod = args.includes('--prod');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const here = path.dirname(fileURLToPath(import.meta.url));

/** Run a suite script as a child process; resolves to its exit code. */
function run(script, base) {
  return new Promise((resolve) => {
    console.log(`\n▶ ${script} → ${base}`);
    const child = spawn(process.execPath, [path.join(here, script), base], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const servers = [];
let failed = 0;
try {
  const needDev = only !== 'ui' || !prod;
  const dev = needDev ? await createServer({ logLevel: 'warn', server: { port: 5199, host: '127.0.0.1' } }) : null;
  if (dev) {
    await dev.listen();
    servers.push(dev);
  }
  const devUrl = dev?.resolvedUrls?.local[0];

  if (only !== 'ui') failed += (await run('engine.mjs', devUrl)) ? 1 : 0;
  if (only !== 'engine') {
    let uiUrl = devUrl;
    if (prod) {
      const p = await preview({ logLevel: 'warn', preview: { port: 4199, host: '127.0.0.1' } });
      servers.push(p);
      uiUrl = p.resolvedUrls.local[0];
    }
    failed += (await run('ui.mjs', uiUrl)) ? 1 : 0;
  }
} finally {
  for (const s of servers) await (s.close?.() ?? s.httpServer?.close());
}
console.log(failed ? `\n✖ ${failed} suite(s) failed` : '\n✔ all e2e suites passed');
process.exit(failed ? 1 : 0);
