// End-to-end test of the IDE UI in headless Chromium (real engine, real UI).
// Usage: node tests/e2e/ui.mjs [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT = 'tests/e2e/out';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

let failed = 0;
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    console.log(`✔ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed++;
    console.log(`✖ ${name}: ${e.message}`);
    await page.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` });
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const S = () => page.evaluate(() => { const s = window.__TEXBROWSER__.store.getState(); return { status: s.compile.status, pdf: s.compile.pdf?.length ?? 0, pdfVersion: s.compile.pdfVersion, diags: s.compile.diagnostics, fetched: s.compile.result?.fetched ?? [], ms: s.compile.result?.durationMs, passes: s.compile.result?.passes, active: s.activePath, project: s.project?.name, projectId: s.project?.id, dialog: s.dialog?.type, pdfTarget: !!s.pdfTarget, reveal: s.reveal }; });
const text = (path) => page.evaluate((p) => window.__TEXBROWSER__.actions.workspace().getText(p), path);
const waitCompiled = async (prevVersion, timeout = 240000) => {
  await page.waitForFunction((v) => { const s = window.__TEXBROWSER__.store.getState().compile; return s.status !== 'running' && s.status !== 'idle' && (v === undefined || s.lastCompiledAt > v); }, prevVersion, { timeout });
  return S();
};
const lastCompiledAt = () => page.evaluate(() => window.__TEXBROWSER__.store.getState().compile.lastCompiledAt ?? 0);
const cursorTo = (line, column = 1) => page.evaluate(([l, c]) => { const e = window.__TEXBROWSER__.editor.get(); e.setPosition({ lineNumber: l, column: c }); e.focus(); }, [line, column]);
const lineOf = (needle) => page.evaluate((n) => window.__TEXBROWSER__.editor.get().getModel().getLinesContent().findIndex((l) => l.includes(n)) + 1, needle);
const compileNow = async () => { const t = await lastCompiledAt(); await page.evaluate(() => window.__TEXBROWSER__.actions.compile({ reason: 'manual' })); return waitCompiled(t); };

await step('boot and first compile of the Welcome project', async () => {
  await page.goto(base);
  await page.waitForFunction(() => window.__TEXBROWSER__ && !window.__TEXBROWSER__.store.getState().booting, null, { timeout: 60000 });
  const s = await waitCompiled();
  assert(s.pdf > 10000, `no PDF (status ${s.status})`);
  await page.waitForFunction(() => document.querySelectorAll('[data-page] canvas').length > 0, null, { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/01-welcome.png` });
});

await step('incremental recompile is fast', async () => {
  const s = await compileNow();
  assert(s.ms < 3000, `recompile took ${s.ms} ms`);
  console.log(`   recompile: ${s.ms} ms, ${s.passes} pass(es)`);
});

await step('slash menu → table wizard inserts a booktabs table', async () => {
  await page.evaluate(() => window.__TEXBROWSER__.store.setState({ settings: { ...window.__TEXBROWSER__.store.getState().settings, autoCompile: false } }));
  const line = await lineOf('\\section{Where next?}');
  await cursorTo(line - 1, 1);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('/tab');
  await page.getByRole('listbox', { name: 'Insert block' }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${OUT}/02-slash-menu.png` });
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Insert table' }).waitFor();
  await page.screenshot({ path: `${OUT}/03-table-wizard.png` });
  await page.getByRole('button', { name: /Insert 3 × 3 table/ }).click();
  await page.waitForTimeout(200);
  const src = await text('main.tex');
  assert(src.includes('\\begin{tabular}{ccc}') && src.includes('Header 1'), 'table not inserted');
  assert(!src.split('\n').some((l) => l.trim() === '/tab'), 'slash query text left behind');
});

await step('slash menu → matrix wizard with live preview', async () => {
  await page.keyboard.press('Escape');
  const line = await lineOf('\\section{Where next?}');
  await cursorTo(line - 1, 1);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('/matr');
  await page.getByRole('listbox', { name: 'Insert block' }).waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Insert matrix' }).waitFor();
  await page.locator('.katex').first().waitFor();
  await page.screenshot({ path: `${OUT}/04-matrix-wizard.png` });
  await page.getByRole('button', { name: 'Insert matrix' }).click();
  await page.waitForTimeout(200);
  assert((await text('main.tex')).includes('\\begin{pmatrix}'), 'matrix not inserted');
});

await step('the document with inserted blocks compiles', async () => {
  const s = await compileNow();
  assert(s.status === 'success' || s.status === 'warnings', `status ${s.status}: ${s.diags.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`);
});

await step('undefined \\SI → friendly explanation → one-click fix', async () => {
  const line = await lineOf('\\section{Where next?}');
  await cursorTo(line - 1, 1);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('Speed of light: \\SI{3e8}{\\metre\\per\\second}.');
  const s = await compileNow();
  assert(s.status === 'errors', `expected errors, got ${s.status}`);
  const fix = page.getByRole('button', { name: /Add \\usepackage\{siunitx\}/ }).first();
  await fix.waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${OUT}/05-error-overlay.png` });
  await fix.click();
  assert((await text('main.tex')).includes('\\usepackage{siunitx}'), 'package not added');
  const s2 = await compileNow();
  assert(s2.status === 'success' || s2.status === 'warnings', `after fix: ${s2.status}`);
});

await step('SyncTeX forward and inverse search', async () => {
  const line = await lineOf('\\section{Mathematics}');
  await cursorTo(line + 1, 3);
  await page.evaluate(() => window.__TEXBROWSER__.actions.forwardSearch());
  await page.waitForFunction(() => !!window.__TEXBROWSER__.store.getState().pdfTarget);
  await page.locator('.synctex-flash').first().waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${OUT}/06-synctex.png` });
  // Inverse: double-click the highlighted spot — once the smooth scroll has settled.
  const flash = page.locator('.synctex-flash').first();
  let box = await flash.boundingBox();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const next = await flash.boundingBox();
    if (next && box && Math.abs(next.y - box.y) < 0.5) break;
    box = next;
  }
  await page.evaluate(() => window.__TEXBROWSER__.store.setState({ reveal: null }));
  await page.mouse.dblclick(box.x + 20, box.y + box.height / 2);
  await page.waitForFunction(() => window.__TEXBROWSER__.store.getState().reveal, null, { timeout: 5000 });
  const r = (await S()).reveal;
  assert(r.path === 'main.tex' && Math.abs(r.line - (line + 1)) <= 3, `inverse search went to ${r.path}:${r.line}, expected ≈${line + 1}`);
});

await step('create a file through the prompt dialog', async () => {
  await page.evaluate(() => window.__TEXBROWSER__.actions.promptNewFile('chapters'));
  await page.getByRole('dialog').locator('input').fill('results.tex');
  await page.keyboard.press('Enter');
  await page.getByRole('tree').getByText('results.tex').waitFor();
  assert((await S()).active === 'chapters/results.tex', 'new file not opened');
});

await step('command palette opens and runs commands', async () => {
  await page.keyboard.press('Control+Shift+P');
  await page.getByPlaceholder('Type a command, file or /block…').waitFor();
  await page.keyboard.type('outline');
  await page.keyboard.press('Enter');
  await page.getByText('≈', { exact: false }).first().waitFor();
});

await step('command palette stays usable while open (button and Ctrl+P)', async () => {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Commands/ }).click();
  await page.getByPlaceholder('Type a command, file or /block…').waitFor();
  await page.waitForTimeout(4000);
  const alive = await page.evaluate(() => document.getElementById('root').childElementCount > 0 && !!document.querySelector('.monaco-editor'));
  assert(alive, 'app unmounted while the palette was open');
  const blur = await page.evaluate(() => getComputedStyle(document.querySelector('[role=dialog]').parentElement).backdropFilter);
  assert(!blur || blur === 'none', `dialog backdrop uses backdrop-filter (${blur})`);
  await page.keyboard.press('Escape');
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Control+P');
  await page.getByPlaceholder('Type a command, file or /block…').waitFor();
  await page.keyboard.press('Escape');
});

await step('theme switch to light and back', async () => {
  await page.evaluate(() => window.__TEXBROWSER__.actions.setTheme('light'));
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'not light');
  await page.screenshot({ path: `${OUT}/07-light-theme.png` });
  await page.evaluate(() => window.__TEXBROWSER__.actions.setTheme('dark'));
});

await step('save a version to history', async () => {
  await page.evaluate(() => window.__TEXBROWSER__.actions.saveVersion('E2E version'));
  await page.evaluate(() => window.__TEXBROWSER__.store.setState({ sidebar: 'history' }));
  await page.getByLabel('Sidebar', { exact: true }).getByText('E2E version').waitFor();
});

await step('download the project as .zip', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__TEXBROWSER__.actions.downloadZip())]);
  const p = `${OUT}/project.zip`;
  await dl.saveAs(p);
  assert(fs.statSync(p).size > 1000, 'zip too small');
});

await step('new TikZ project fetches PGF from the package shelf', async () => {
  const t = await lastCompiledAt();
  await page.evaluate(() => window.__TEXBROWSER__.actions.createProject('TikZ test', 'tikz'));
  const s = await waitCompiled(t);
  assert(s.status !== 'failed' && s.pdf > 5000, `tikz status ${s.status}: ${s.diags.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`);
  assert(s.fetched.includes('pgf'), `fetched ${s.fetched.join(',')}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/08-tikz.png` });
});

await step('XeLaTeX template compiles', async () => {
  const t = await lastCompiledAt();
  await page.evaluate(() => window.__TEXBROWSER__.actions.createProject('XeLaTeX test', 'xelatex'));
  const s = await waitCompiled(t);
  assert(s.status !== 'failed' && s.pdf > 3000, `xelatex status ${s.status}: ${s.diags.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`);
});

await browser.close();
const real = errors.filter((e) => !/Download the React DevTools/.test(e));
if (real.length) console.log('console errors:\n  ' + real.slice(0, 10).join('\n  '));
console.log(failed ? `\n${failed} step(s) failed` : '\nall UI steps passed');
process.exit(failed ? 1 : 0);
