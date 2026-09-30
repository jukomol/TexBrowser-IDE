/**
 * Application controller: every user-facing operation lives here so the React
 * components stay thin. Coordinates the Workspace (files), Monaco models,
 * the compile worker (EngineClient) and the store.
 */
import { EngineClient, CompileCancelledError } from '../engine/EngineClient';
import type { TexEngine } from '../engine/protocol';
import { Workspace, guessMainFile } from './workspace';
import { getState, setState, patchCompile, toast, openDialog, initialCompile, updateSettings, closeDialog } from './store';
import * as db from '../storage/db';
import { createSnapshot, contentKey, snapshotFiles } from '../storage/history';
import { downloadBytes, downloadProjectZip, downloadText, readFileList, unzipProject, type ImportedFile } from '../storage/local-disk';
import { bindWorkspace, getModel, syncAllModels, syncModel, disposeModel, openModels } from '../editor/models';
import { editorBridge } from '../editor/bridge';
import { monaco } from '../editor/monaco';
import { parseBibtexLog, parseTexLog } from '../latex/log-parser';
import { SyncTex } from '../latex/synctex';
import { packageInsertion } from '../latex/analysis';
import type { QuickFix } from '../latex/explain';
import type { SlashCommand } from '../editor/slash-commands';
import type { Diagnostic, Snapshot } from '../types';
import { basename, dirname, isTextPath, joinPath, normalisePath, relativePath, stripExt } from '../utils/paths';
import { KEEP } from './workspace';
import { TEMPLATES } from '../templates';

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function engineUrls() {
  const s = getState().settings;
  const base = document.baseURI;
  return {
    manifestUrl: s.engineUrl ? new URL(s.engineUrl, base).href : new URL('engine/manifest.json', base).href,
    shelfUrl: !s.useShelf ? null : s.shelfUrl ? new URL(s.shelfUrl, base).href : new URL('shelf/index.json', base).href,
  };
}

export const engine = new EngineClient({ ...engineUrls(), timeoutMs: 240_000 });
engine.subscribe((snapshot) => setState({ engine: snapshot }));
engine.onStdout((chunk) => {
  const prev = getState().compile.console;
  const next = (prev + chunk + '\n').slice(-200_000);
  patchCompile({ console: next });
});

export function reconfigureEngine() {
  engine.configure(engineUrls());
  void engine.start().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

let ws: Workspace | null = null;
let unsubscribe: (() => void) | null = null;
export const workspace = () => ws;

let booted: Promise<void> | null = null;

/** Open the most recent project (creating the Welcome project on first run). Idempotent. */
export function boot(): Promise<void> {
  booted ??= doBoot();
  return booted;
}

async function doBoot() {
  try {
    let projects = await db.listProjects();
    if (!projects.length) {
      await Workspace.create('Welcome to TexBrowser', 'welcome');
      projects = await db.listProjects();
    }
    setState({ projects });
    const last = await db.kvGet<string>('lastProject');
    await openProject(projects.some((p) => p.id === last) ? last! : projects[0].id);
  } catch (err) {
    toast({ kind: 'error', title: 'Could not open your projects', message: String(err), timeout: 0 });
  } finally {
    setState({ booting: false });
  }
  // Warm up the engine once the UI is interactive.
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 400));
  idle(() => void engine.start().catch(() => undefined));
  window.addEventListener('beforeunload', () => void ws?.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void ws?.flush();
  });
}

export async function refreshProjects() {
  setState({ projects: await db.listProjects() });
}

export async function openProject(id: string) {
  if (ws) {
    await ws.flush();
    unsubscribe?.();
  }
  engine.cancel();
  const next = await Workspace.open(id);
  ws = next;
  bindWorkspace(next);
  unsubscribe = next.subscribe((kind) => {
    if (kind === 'meta') setState({ project: { ...next.project } });
    if (kind === 'tree') setState((s) => ({ treeVersion: s.treeVersion + 1, project: { ...next.project } }));
    if (kind === 'content') setState((s) => ({ contentVersion: s.contentVersion + 1 }));
    if (kind !== 'meta') {
      patchCompile({ dirtySinceCompile: true });
      scheduleAutoCompile();
    }
  });
  const files = new Set(next.paths());
  const openTabs = (next.project.openTabs ?? []).filter((p) => files.has(p));
  if (!openTabs.length && files.has(next.project.mainFile)) openTabs.push(next.project.mainFile);
  const activePath = next.project.activePath && files.has(next.project.activePath) ? next.project.activePath : (openTabs[0] ?? null);
  setState((s) => ({
    project: { ...next.project },
    openTabs,
    activePath,
    compile: { ...initialCompile },
    treeVersion: s.treeVersion + 1,
    epoch: s.epoch + 1,
    reveal: null,
    pdfTarget: null,
  }));
  lastSnapshotKey = contentKey(next);
  await db.kvSet('lastProject', id);
  void compile({ reason: 'open' });
}

function persistTabs() {
  const { openTabs, activePath } = getState();
  ws?.updateMeta({ openTabs, activePath });
}

// ---------------------------------------------------------------------------
// Tabs & navigation
// ---------------------------------------------------------------------------

export function openFile(path: string, line?: number, column?: number) {
  if (!ws?.get(path)) return;
  setState((s) => ({
    openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path],
    activePath: path,
    reveal: line ? { path, line, column, nonce: Date.now() } : s.reveal,
  }));
  persistTabs();
}

export function closeTab(path: string) {
  setState((s) => {
    const idx = s.openTabs.indexOf(path);
    const openTabs = s.openTabs.filter((p) => p !== path);
    const activePath = s.activePath === path ? (openTabs[Math.min(idx, openTabs.length - 1)] ?? null) : s.activePath;
    return { openTabs, activePath };
  });
  persistTabs();
}

export function revealDiagnostic(d: Diagnostic) {
  if (d.file && ws?.get(d.file)) openFile(d.file, d.line ?? 1);
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

function newFileContent(path: string): string {
  if (path.endsWith('.tex')) return `% ${basename(path)}\n\\section{${stripExt(basename(path)).replace(/[-_]/g, ' ')}}\n\n`;
  if (path.endsWith('.bib')) return '@article{key2024,\n  author  = {Last, First},\n  title   = {Title},\n  journal = {Journal},\n  year    = {2024}\n}\n';
  if (path.endsWith('.sty')) return `\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesPackage{${stripExt(basename(path))}}\n\n`;
  return '';
}

export function promptNewFile(dir = '') {
  openDialog({
    type: 'prompt',
    title: 'New file',
    label: dir ? `File name (in ${dir}/)` : 'File name',
    value: '',
    placeholder: 'chapter2.tex',
    confirm: 'Create',
    onSubmit: (name) => {
      if (!ws) return;
      const path = normalisePath(joinPath(dir, name.includes('.') ? name : `${name}.tex`));
      if (!path) throw new Error('Invalid file name');
      if (ws.get(path)) throw new Error(`${path} already exists`);
      ws.writeFile(path, newFileContent(path));
      openFile(path);
    },
  });
}

export function promptNewFolder(dir = '') {
  openDialog({
    type: 'prompt',
    title: 'New folder',
    label: 'Folder name',
    value: '',
    placeholder: 'figures',
    confirm: 'Create',
    onSubmit: (name) => {
      ws?.createFolder(joinPath(dir, name));
    },
  });
}

export function promptRename(path: string) {
  openDialog({
    type: 'prompt',
    title: `Rename ${basename(path)}`,
    label: 'New path',
    value: path,
    confirm: 'Rename',
    onSubmit: (to) => {
      if (!ws) return;
      const moves = ws.rename(path, to);
      const map = new Map(moves);
      for (const [from] of moves) disposeModel(from);
      setState((s) => ({
        openTabs: s.openTabs.map((p) => map.get(p) ?? p),
        activePath: s.activePath ? (map.get(s.activePath) ?? s.activePath) : null,
      }));
      persistTabs();
    },
  });
}

export function confirmDelete(path: string) {
  const isFolder = !ws?.get(path);
  openDialog({
    type: 'confirm',
    title: `Delete ${isFolder ? 'folder' : 'file'}?`,
    message: `“${path}”${isFolder ? ' and everything inside it' : ''} will be removed from this project. You can recover it from History if a version was saved.`,
    confirm: 'Delete',
    danger: true,
    onConfirm: () => {
      if (!ws) return;
      const removed = new Set(ws.delete(path));
      for (const p of removed) disposeModel(p);
      setState((s) => {
        const openTabs = s.openTabs.filter((p) => !removed.has(p));
        return { openTabs, activePath: s.activePath && removed.has(s.activePath) ? (openTabs[0] ?? null) : s.activePath };
      });
      persistTabs();
    },
  });
}

export function setMainFile(path: string) {
  ws?.updateMeta({ mainFile: path });
  toast({ kind: 'success', title: `Main document: ${path}` });
  void compile({ reason: 'manual' });
}

export function setEngine(engineName: TexEngine) {
  ws?.updateMeta({ engine: engineName });
  void compile({ reason: 'manual' });
}

/** Add imported files to the project (e.g. upload / drag & drop). */
export function addFiles(files: ImportedFile[], opts: { open?: boolean } = {}) {
  if (!ws || !files.length) return [];
  const written: string[] = [];
  for (const f of files) written.push(ws.writeFile(f.path, f.text ?? f.data ?? ''));
  for (const p of written) syncModel(p);
  toast({ kind: 'success', title: `Added ${written.length} file${written.length > 1 ? 's' : ''}`, message: written.slice(0, 4).join(', ') + (written.length > 4 ? '…' : '') });
  const first = written.find((p) => isTextPath(p));
  if (opts.open && first) openFile(first);
  return written;
}

export async function uploadFiles(list: FileList | File[], dir = '') {
  try {
    addFiles(await readFileList(list, dir), { open: true });
  } catch (err) {
    toast({ kind: 'error', title: 'Import failed', message: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(name: string, templateId: string) {
  const meta = await Workspace.create(name.trim() || 'Untitled project', templateId);
  await refreshProjects();
  await openProject(meta.id);
  closeDialog();
}

export async function createProjectFromFiles(name: string, files: ImportedFile[], extra: Partial<{ github: import('../types').GitHubLink; gist: import('../types').GistLink }> = {}) {
  if (!files.some((f) => f.path.endsWith('.tex'))) throw new Error('No .tex files found in the imported files.');
  const mainFile = guessMainFile(files) ?? 'main.tex';
  const meta = await Workspace.create(name, 'blank', files, { mainFile, engine: detectEngine(files.find((f) => f.path === mainFile)?.text ?? '') });
  if (extra.github || extra.gist) await db.putProject({ ...meta, ...extra });
  await refreshProjects();
  await openProject(meta.id);
}

/** fontspec/unicode-math/polyglossia ⇒ XeLaTeX; otherwise pdfLaTeX. */
function detectEngine(main: string): TexEngine {
  return /\\usepackage(\[[^\]]*\])?\{(fontspec|unicode-math|polyglossia|xeCJK)\}/.test(main) ? 'xetex' : 'pdftex';
}

export async function importZipAsProject(file: File) {
  try {
    const files = unzipProject(new Uint8Array(await file.arrayBuffer()));
    await createProjectFromFiles(file.name.replace(/\.zip$/i, ''), files);
    toast({ kind: 'success', title: 'Project imported', message: `${files.length} files from ${file.name}` });
  } catch (err) {
    toast({ kind: 'error', title: 'Import failed', message: String(err instanceof Error ? err.message : err) });
  }
}

export async function importFolderAsProject(list: FileList | File[]) {
  try {
    const files = await readFileList(list);
    const top = files[0]?.path.split('/')[0];
    const stripped = top && files.every((f) => f.path.startsWith(top + '/')) ? files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) })) : files;
    await createProjectFromFiles(top || 'Imported project', stripped);
  } catch (err) {
    toast({ kind: 'error', title: 'Import failed', message: String(err instanceof Error ? err.message : err) });
  }
}

export function promptRenameProject() {
  if (!ws) return;
  openDialog({
    type: 'prompt',
    title: 'Rename project',
    label: 'Project name',
    value: ws.project.name,
    confirm: 'Rename',
    onSubmit: async (name) => {
      ws?.updateMeta({ name: name.trim() || ws.project.name });
      await ws?.flush();
      await refreshProjects();
    },
  });
}

export async function duplicateProject(id: string) {
  const meta = await db.getProject(id);
  if (!meta) return;
  const files = (await db.listFiles(id)).map((f) => ({ path: f.path, text: f.text, data: f.data }));
  const copy = await Workspace.create(`${meta.name} (copy)`, meta.template ?? 'blank', files, { mainFile: meta.mainFile, engine: meta.engine });
  await refreshProjects();
  await openProject(copy.id);
}

export function confirmDeleteProject(id: string) {
  const meta = getState().projects.find((p) => p.id === id);
  openDialog({
    type: 'confirm',
    title: 'Delete project?',
    message: `“${meta?.name ?? 'This project'}” and its history will be permanently deleted from this browser. Files pushed to GitHub are not affected.`,
    confirm: 'Delete project',
    danger: true,
    onConfirm: async () => {
      await db.deleteProject(id);
      await refreshProjects();
      if (ws?.project.id === id) {
        const rest = getState().projects;
        if (rest.length) await openProject(rest[0].id);
        else {
          const meta2 = await Workspace.create('Welcome to TexBrowser', 'welcome');
          await refreshProjects();
          await openProject(meta2.id);
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

let running = false;
let pending: { clean: boolean } | null = null;
let autoTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleAutoCompile() {
  clearTimeout(autoTimer);
  const { autoCompile, autoCompileDelay } = getState().settings;
  if (!autoCompile) return;
  autoTimer = setTimeout(() => void compile({ reason: 'auto' }), autoCompileDelay);
}

export async function compile(opts: { clean?: boolean; reason?: 'manual' | 'auto' | 'open' } = {}) {
  clearTimeout(autoTimer);
  if (!ws) return;
  if (opts.reason === 'open' && !getState().settings.autoCompile && engine.state.state !== 'ready') return;
  if (running) {
    pending = { clean: !!opts.clean || !!pending?.clean };
    return;
  }
  running = true;
  const current = ws;
  const project = current.project;
  const settings = getState().settings;
  const mainDir = dirname(project.mainFile);
  patchCompile({ status: 'running', error: null, console: '', dirtySinceCompile: false });
  try {
    await current.flush();
    const result = await engine.compile({
      files: current.compileFiles(),
      mainFile: project.mainFile,
      engine: project.engine,
      bibtex: settings.bibtex,
      makeindex: true,
      maxPasses: 5,
      haltOnError: settings.haltOnError,
      synctex: true,
      clean: !!opts.clean,
      useShelf: settings.useShelf,
    });
    if (ws !== current) return; // project switched meanwhile

    const diagnostics: Diagnostic[] = [
      ...parseTexLog(result.log, mainDir),
      ...(result.bibtexLog ? parseBibtexLog(result.bibtexLog, mainDir) : []),
      ...result.unresolved.map<Diagnostic>((name) => ({
        severity: 'error',
        message: `Not available in this TeX distribution: ${name}`,
        source: 'engine',
      })),
      ...result.notices.map<Diagnostic>((message) => ({ severity: 'warning', message, source: 'engine' })),
    ];
    let synctex: SyncTex | null = null;
    if (result.synctex) {
      try {
        synctex = await SyncTex.fromGzip(result.synctex, mainDir);
      } catch {
        synctex = null;
      }
    }
    const prev = getState().compile;
    const { pdf, synctex: _s, ...rest } = result;
    void _s;
    patchCompile({
      status: result.status,
      result: rest,
      pdf: pdf ?? prev.pdf,
      pdfVersion: pdf ? prev.pdfVersion + 1 : prev.pdfVersion,
      pdfFromCurrentRun: !!pdf,
      synctex: pdf ? synctex : prev.synctex,
      diagnostics,
      lastCompiledAt: Date.now(),
      error: null,
    });
    applyMarkers();
    if (result.fetched.length) {
      const labels = new Map((getState().engine.info?.collections ?? []).map((c) => [c.id, c.label.replace(/\s*\(.*\)$/, '')]));
      const names = result.fetched.map((f) => labels.get(f) ?? f.replace(/^font:/, ''));
      toast({ kind: 'info', title: 'Installed on demand', message: names.slice(0, 6).join(', ') + (names.length > 6 ? '…' : ''), timeout: 3500 });
    }
    if (result.status !== 'failed') void maybeAutoSnapshot();
  } catch (err) {
    if (err instanceof CompileCancelledError) patchCompile({ status: 'cancelled', error: err.message });
    else patchCompile({ status: 'crashed', error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
    if (pending) {
      const p = pending;
      pending = null;
      void compile({ clean: p.clean, reason: 'auto' });
    }
  }
}

export function cancelCompile() {
  pending = null;
  engine.cancel();
}

/** Show compile diagnostics as squiggles/markers in every open model. */
export function applyMarkers() {
  const diags = getState().compile.diagnostics;
  for (const [path, model] of openModels()) {
    const markers: monaco.editor.IMarkerData[] = diags
      .filter((d) => d.file === path && d.line && d.severity !== 'info')
      .map((d) => {
        const line = Math.min(Math.max(d.line!, 1), model.getLineCount());
        return {
          severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: d.message,
          startLineNumber: line,
          startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
          endLineNumber: line,
          endColumn: model.getLineMaxColumn(line),
          source: d.source === 'bibtex' ? 'BibTeX' : 'TeX',
        };
      });
    monaco.editor.setModelMarkers(model, 'texbrowser', markers);
  }
}

// ---------------------------------------------------------------------------
// SyncTeX
// ---------------------------------------------------------------------------

export function forwardSearch() {
  const { synctex } = getState().compile;
  const e = editorBridge.get();
  const path = getState().activePath;
  if (!synctex || !e || !path) {
    toast({ kind: 'info', title: 'Compile first', message: 'SyncTeX data is created with each compile.' });
    return;
  }
  const line = e.getPosition()?.lineNumber ?? 1;
  const rects = synctex.forward(path, line);
  if (!rects.length) toast({ kind: 'info', title: 'No PDF location for this line' });
  else setState({ pdfTarget: { rects, nonce: Date.now() } });
}

export function inverseSearch(page: number, x: number, y: number) {
  const { synctex } = getState().compile;
  const hit = synctex?.inverse(page, x, y);
  if (hit && ws?.get(hit.file)) openFile(hit.file, hit.line);
}

// ---------------------------------------------------------------------------
// Editing helpers: packages, quick fixes, slash commands
// ---------------------------------------------------------------------------

/** Replace a whole line range of a file, via its Monaco model when open (keeps undo). */
function editFile(path: string, fn: (text: string) => string | null): boolean {
  if (!ws) return false;
  const model = getModel(path);
  const before = model ? model.getValue() : ws.getText(path);
  if (before === undefined) return false;
  const after = fn(before);
  if (after === null || after === before) return false;
  if (model) {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: after }], () => null);
    model.pushStackElement();
  } else ws.setText(path, after);
  return true;
}

/** Ensure `\usepackage[options]{pkg}` is in the main document's preamble. Returns true if added. */
export function ensurePackage(pkg: string, options?: string): boolean {
  if (!ws) return false;
  const main = ws.project.mainFile;
  return editFile(main, (text) => {
    const ins = packageInsertion(text, pkg, options);
    if (!ins) return null;
    const lines = text.split('\n');
    lines.splice(ins.line - 1, 0, ins.text.replace(/\n$/, ''));
    return lines.join('\n');
  });
}

/** Ensure an arbitrary preamble line exists (e.g. \newtheorem{theorem}{Theorem}). */
export function ensurePreambleLine(line: string, marker: string): boolean {
  if (!ws) return false;
  return editFile(ws.project.mainFile, (text) => {
    if (text.includes(marker)) return null;
    const begin = text.search(/\\begin\s*\{document\}/);
    if (begin < 0) return null;
    return text.slice(0, begin) + line + '\n' + text.slice(begin);
  });
}

export function applyQuickFix(fix: QuickFix) {
  switch (fix.kind) {
    case 'addPackage':
      if (ensurePackage(fix.pkg, fix.options)) toast({ kind: 'success', title: `Added \\usepackage{${fix.pkg}}` });
      else toast({ kind: 'info', title: `${fix.pkg} is already loaded (or the main file has no preamble)` });
      break;
    case 'replaceInLine':
      editFile(fix.file, (text) => {
        const lines = text.split('\n');
        const i = fix.line - 1;
        if (!lines[i]) return null;
        // Replace the first occurrence that is not already escaped.
        const re = new RegExp(`(^|[^\\\\])${fix.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
        lines[i] = lines[i].replace(re, (_m, pre: string) => pre + fix.replace);
        return lines.join('\n');
      });
      openFile(fix.file, fix.line);
      break;
    case 'switchEngine':
      setEngine(fix.engine);
      toast({ kind: 'success', title: `Switched to ${fix.engine === 'xetex' ? 'XeLaTeX' : 'pdfLaTeX'}` });
      return;
    case 'openFile':
      openFile(fix.file, fix.line);
      return;
  }
}

/** Insert a slash command's snippet and add the packages it needs. */
export function runSlashCommand(cmd: SlashCommand) {
  const range = editorBridge.takeSlashRange();
  if (cmd.wizard) {
    // Remove the "/query" text now; the wizard inserts at the cursor later.
    const e = editorBridge.get();
    if (e && range) e.executeEdits('slash', [{ range, text: '' }]);
    openDialog({ type: 'wizard', wizard: cmd.wizard });
    addPackagesFor(cmd);
    return;
  }
  if (cmd.snippet) editorBridge.insertSnippet(cmd.snippet, range);
  addPackagesFor(cmd);
}

export function addPackagesFor(cmd: Pick<SlashCommand, 'packages' | 'id'>) {
  const added: string[] = [];
  for (const p of cmd.packages ?? []) if (ensurePackage(p.name, p.options)) added.push(p.name);
  if (cmd.id === 'theorem' && ensurePreambleLine('\\newtheorem{theorem}{Theorem}', '\\newtheorem{theorem}')) added.push('theorem definition');
  if (cmd.id === 'plot' && ensurePreambleLine('\\pgfplotsset{compat=1.17}', '\\pgfplotsset{compat')) added.push('pgfplots compat');
  if (added.length) toast({ kind: 'success', title: `Preamble updated`, message: `Added ${added.join(', ')}`, timeout: 2500 });
}

/**
 * Path to use in \includegraphics/\input for a project file. TeX resolves
 * relative paths against the main document's directory (its working
 * directory), even inside \input files.
 */
export function includePathFor(target: string): string {
  return relativePath(ws?.project.mainFile ?? 'main.tex', target);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

let lastSnapshotKey = '';
let lastAutoSnapshot = 0;

async function maybeAutoSnapshot() {
  if (!ws) return;
  const key = contentKey(ws);
  if (key === lastSnapshotKey || Date.now() - lastAutoSnapshot < 5 * 60_000) return;
  lastSnapshotKey = key;
  lastAutoSnapshot = Date.now();
  await createSnapshot(ws, 'Auto-saved after compile', true);
  setState((s) => ({ treeVersion: s.treeVersion })); // history panel refreshes on its own
}

export async function saveVersion(label: string) {
  if (!ws) return;
  await ws.flush();
  await createSnapshot(ws, label || 'Saved version', false);
  lastSnapshotKey = contentKey(ws);
  toast({ kind: 'success', title: 'Version saved', message: label });
}

export async function restoreSnapshot(snap: Snapshot) {
  if (!ws) return;
  await createSnapshot(ws, `Before restoring “${snap.label}”`, false);
  ws.replaceAll(await snapshotFiles(snap));
  syncAllModels();
  const files = new Set(ws.paths());
  setState((s) => {
    const openTabs = s.openTabs.filter((p) => files.has(p));
    return { openTabs, activePath: s.activePath && files.has(s.activePath) ? s.activePath : (openTabs[0] ?? null) };
  });
  toast({ kind: 'success', title: 'Version restored', message: 'The previous state was saved to history first.' });
  void compile({ reason: 'manual' });
}

// ---------------------------------------------------------------------------
// Local disk
// ---------------------------------------------------------------------------

export function downloadActive() {
  const path = getState().activePath;
  const f = path ? ws?.get(path) : undefined;
  if (!f) return;
  if (f.kind === 'text') downloadText(f.path, f.text ?? '');
  else if (f.data) downloadBytes(basename(f.path), f.data);
}

export function downloadZip() {
  if (ws) downloadProjectZip(ws, getState().compile.pdf);
}

export function downloadPdf() {
  const { pdf } = getState().compile;
  if (!pdf || !ws) {
    toast({ kind: 'info', title: 'No PDF yet', message: 'Compile the project first.' });
    return;
  }
  downloadBytes(`${stripExt(basename(ws.project.mainFile))}.pdf`, pdf, 'application/pdf');
}

export function openPdfInNewTab() {
  const { pdf } = getState().compile;
  if (!pdf) return;
  const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function newProjectDialog(initialTemplate?: string) {
  openDialog({ type: 'new-project', initialTemplate });
}

export function setTheme(theme: 'dark' | 'light' | 'system') {
  updateSettings({ theme });
  applyTheme();
}

export function applyTheme() {
  const t = getState().settings.theme;
  const resolved = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = resolved;
  monaco.editor.setTheme(resolved === 'dark' ? 'texbrowser-dark' : 'texbrowser-light');
}

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
export const isKeepFile = (p: string) => basename(p) === KEEP;
