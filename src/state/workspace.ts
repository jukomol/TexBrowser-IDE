/**
 * Workspace — the in-memory model of the open project.
 *
 * All reads/writes go through this object; changes are persisted to
 * IndexedDB in the background (debounced) so typing never waits on storage.
 * Folders are implicit (derived from file paths); an empty folder is kept
 * alive by a hidden `.keep` placeholder file.
 */
import * as store from '../storage/db';
import type { FileKind, ProjectMeta, StoredFile } from '../types';
import type { CompileFile, TexEngine } from '../engine/protocol';
import { basename, dirname, isTextPath, normalisePath } from '../utils/paths';
import { debounce, uid } from '../utils/misc';
import { templateFiles, TEMPLATES } from '../templates';

export interface MemFile {
  path: string;
  kind: FileKind;
  text?: string;
  data?: Uint8Array;
  updatedAt: number;
}

export const KEEP = '.keep';

type ChangeKind = 'tree' | 'content' | 'meta';

export class Workspace {
  readonly files = new Map<string, MemFile>();
  private dirty = new Set<string>();
  private deleted = new Set<string>();
  private listeners = new Set<(kind: ChangeKind, path?: string) => void>();
  private metaDirty = false;

  private constructor(public project: ProjectMeta) {}

  // ---- lifecycle -------------------------------------------------------------

  static async open(projectId: string): Promise<Workspace> {
    const meta = await store.getProject(projectId);
    if (!meta) throw new Error('Project not found');
    const ws = new Workspace(meta);
    for (const f of await store.listFiles(projectId)) {
      ws.files.set(f.path, { path: f.path, kind: f.kind, text: f.text, data: f.data, updatedAt: f.updatedAt });
    }
    if (!ws.files.has(meta.mainFile)) {
      const tex = [...ws.files.keys()].find((p) => p.endsWith('.tex'));
      if (tex) meta.mainFile = tex;
    }
    return ws;
  }

  /** Create a project from a template (or from explicit files) and persist it. */
  static async create(
    name: string,
    templateId: string,
    explicit?: { path: string; text?: string; data?: Uint8Array }[],
    opts: { mainFile?: string; engine?: TexEngine } = {},
  ): Promise<ProjectMeta> {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    const files = explicit ?? (await templateFiles(templateId));
    const now = Date.now();
    const mainFile =
      opts.mainFile ??
      (files.some((f) => f.path === (tpl?.mainFile ?? 'main.tex'))
        ? (tpl?.mainFile ?? 'main.tex')
        : (guessMainFile(files) ?? 'main.tex'));
    const meta: ProjectMeta = {
      id: uid('p_'),
      name,
      createdAt: now,
      updatedAt: now,
      mainFile,
      engine: opts.engine ?? tpl?.engine ?? 'pdftex',
      template: templateId,
      openTabs: [mainFile],
      activePath: mainFile,
    };
    await store.putProject(meta);
    await store.putFiles(
      files.map((f) => ({
        projectId: meta.id,
        path: f.path,
        kind: f.text !== undefined ? 'text' : 'binary',
        text: f.text,
        data: f.data,
        updatedAt: now,
      })),
    );
    return meta;
  }

  // ---- change notification -------------------------------------------------

  subscribe(fn: (kind: ChangeKind, path?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: ChangeKind, path?: string) {
    for (const l of this.listeners) l(kind, path);
  }

  private touch(path: string) {
    this.dirty.add(path);
    this.deleted.delete(path);
    this.project.updatedAt = Date.now();
    this.metaDirty = true;
    this.scheduleSave();
  }

  private scheduleSave = debounce(() => void this.flush(), 700);

  /** Persist pending changes now. */
  async flush(): Promise<void> {
    this.scheduleSave.cancel();
    const dirty = [...this.dirty];
    const deleted = [...this.deleted];
    this.dirty.clear();
    this.deleted.clear();
    const records: StoredFile[] = [];
    for (const p of dirty) {
      const f = this.files.get(p);
      if (f) records.push({ projectId: this.project.id, path: f.path, kind: f.kind, text: f.text, data: f.data, updatedAt: f.updatedAt });
    }
    await store.putFiles(records);
    await store.deleteFiles(this.project.id, deleted);
    if (this.metaDirty) {
      this.metaDirty = false;
      await store.putProject(this.project);
    }
  }

  get hasPendingWrites() {
    return this.dirty.size > 0 || this.deleted.size > 0 || this.metaDirty;
  }

  // ---- queries ---------------------------------------------------------------

  get(path: string) {
    return this.files.get(path);
  }

  getText(path: string): string | undefined {
    return this.files.get(path)?.text;
  }

  /** Visible file paths (without folder placeholders), sorted. */
  paths(): string[] {
    return [...this.files.keys()].filter((p) => basename(p) !== KEEP).sort();
  }

  /** All folders implied by the file paths (including empty ones). */
  folders(): string[] {
    const out = new Set<string>();
    for (const p of this.files.keys()) {
      let d = dirname(p);
      while (d) {
        out.add(d);
        d = dirname(d);
      }
    }
    return [...out].sort();
  }

  textFiles(ext?: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const f of this.files.values()) {
      if (f.kind === 'text' && f.text !== undefined && (!ext || f.path.endsWith(ext))) out.push({ path: f.path, text: f.text });
    }
    return out;
  }

  exists(path: string) {
    return this.files.has(path) || this.folders().includes(path);
  }

  /** Snapshot of the project for the compiler (copies binary data). */
  compileFiles(): CompileFile[] {
    const out: CompileFile[] = [];
    for (const f of this.files.values()) {
      if (basename(f.path) === KEEP) continue;
      if (f.kind === 'text') out.push({ path: f.path, data: f.text ?? '' });
      else if (f.data) out.push({ path: f.path, data: f.data });
    }
    return out;
  }

  // ---- mutations -------------------------------------------------------------

  setText(path: string, text: string) {
    const f = this.files.get(path);
    if (f && f.kind === 'text' && f.text === text) return;
    this.files.set(path, { path, kind: 'text', text, updatedAt: Date.now() });
    this.touch(path);
    this.emit(f ? 'content' : 'tree', path);
  }

  writeFile(path: string, content: string | Uint8Array): string {
    const p = normalisePath(path);
    if (!p) throw new Error(`Invalid file name: ${path}`);
    const existed = this.files.has(p);
    if (typeof content === 'string') this.files.set(p, { path: p, kind: 'text', text: content, updatedAt: Date.now() });
    else if (isTextPath(p) && !looksBinary(content)) {
      this.files.set(p, { path: p, kind: 'text', text: new TextDecoder().decode(content), updatedAt: Date.now() });
    } else this.files.set(p, { path: p, kind: 'binary', data: content, updatedAt: Date.now() });
    this.removeKeep(dirname(p));
    this.touch(p);
    this.emit(existed ? 'content' : 'tree', p);
    return p;
  }

  createFolder(path: string): string {
    const p = normalisePath(path);
    if (!p) throw new Error(`Invalid folder name: ${path}`);
    if (!this.folders().includes(p)) {
      const keep = `${p}/${KEEP}`;
      this.files.set(keep, { path: keep, kind: 'text', text: '', updatedAt: Date.now() });
      this.touch(keep);
      this.emit('tree');
    }
    return p;
  }

  private removeKeep(dir: string) {
    if (!dir) return;
    const keep = `${dir}/${KEEP}`;
    if (this.files.has(keep)) {
      this.files.delete(keep);
      this.deleted.add(keep);
      this.dirty.delete(keep);
    }
  }

  /** Delete a file, or a folder and everything below it. Returns removed paths. */
  delete(path: string): string[] {
    const removed = [...this.files.keys()].filter((p) => p === path || p.startsWith(path + '/'));
    for (const p of removed) {
      this.files.delete(p);
      this.dirty.delete(p);
      this.deleted.add(p);
    }
    const parent = dirname(path);
    if (parent && ![...this.files.keys()].some((p) => p.startsWith(parent + '/'))) this.createFolder(parent);
    this.project.updatedAt = Date.now();
    this.metaDirty = true;
    this.scheduleSave();
    this.emit('tree');
    return removed.filter((p) => basename(p) !== KEEP);
  }

  /** Rename/move a file or folder. Returns [from, to] pairs of files moved. */
  rename(from: string, to: string): [string, string][] {
    const target = normalisePath(to);
    if (!target) throw new Error(`Invalid name: ${to}`);
    if (target === from) return [];
    if (this.files.has(target)) throw new Error(`"${target}" already exists`);
    const moves: [string, string][] = [];
    for (const p of [...this.files.keys()]) {
      if (p === from || p.startsWith(from + '/')) moves.push([p, target + p.slice(from.length)]);
    }
    if (!moves.length) throw new Error(`"${from}" does not exist`);
    for (const [a, b] of moves) {
      const f = this.files.get(a)!;
      this.files.delete(a);
      this.dirty.delete(a);
      this.deleted.add(a);
      this.files.set(b, { ...f, path: b, updatedAt: Date.now() });
      this.touch(b);
    }
    this.removeKeep(dirname(target));
    if (this.project.mainFile === from || this.project.mainFile.startsWith(from + '/')) {
      this.project.mainFile = target + this.project.mainFile.slice(from.length);
    }
    this.metaDirty = true;
    this.emit('tree');
    return moves.filter(([a]) => basename(a) !== KEEP);
  }

  updateMeta(patch: Partial<ProjectMeta>) {
    Object.assign(this.project, patch, { updatedAt: Date.now() });
    this.metaDirty = true;
    this.scheduleSave();
    this.emit('meta');
  }

  /** Replace every file (snapshot restore / pull). */
  replaceAll(files: { path: string; text?: string; data?: Uint8Array }[]) {
    for (const p of this.files.keys()) this.deleted.add(p);
    this.files.clear();
    this.dirty.clear();
    for (const f of files) {
      const kind: FileKind = f.text !== undefined ? 'text' : 'binary';
      this.files.set(f.path, { path: f.path, kind, text: f.text, data: f.data, updatedAt: Date.now() });
      this.deleted.delete(f.path);
      this.dirty.add(f.path);
    }
    if (!this.files.has(this.project.mainFile)) {
      this.project.mainFile = guessMainFile(files) ?? this.project.mainFile;
    }
    this.metaDirty = true;
    this.project.updatedAt = Date.now();
    this.scheduleSave();
    this.emit('tree');
  }
}

/** Binary sniffing: NUL bytes in the first 8 KB mean "not text". */
export function looksBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

/** Pick the most plausible root document: the one with \documentclass, preferring main.tex. */
export function guessMainFile(files: { path: string; text?: string }[]): string | null {
  const roots = files.filter((f) => f.path.endsWith('.tex') && f.text && /\\documentclass/.test(f.text));
  if (!roots.length) return files.find((f) => f.path.endsWith('.tex'))?.path ?? null;
  const pref = roots.find((f) => /(^|\/)main\.tex$/.test(f.path)) ?? roots.find((f) => !f.path.includes('/'));
  return (pref ?? roots[0]).path;
}
