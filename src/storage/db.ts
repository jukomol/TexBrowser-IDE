/**
 * IndexedDB schema — the browser is the file system.
 *
 *   projects   ProjectMeta                       (key: id)
 *   files      StoredFile                        (key: [projectId, path], index byProject)
 *   snapshots  Snapshot (history)                (key: id, index byProject)
 *   blobs      { hash, data } content-addressed binary snapshot data
 *   kv         arbitrary settings                (key: key)
 *
 * Text files are stored as strings, binaries (images, PDFs, fonts) as
 * Uint8Array. Everything stays on the user's machine.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ProjectMeta, Snapshot, StoredFile } from '../types';

interface TexBrowserDB extends DBSchema {
  projects: { key: string; value: ProjectMeta };
  files: { key: [string, string]; value: StoredFile; indexes: { byProject: string } };
  snapshots: { key: string; value: Snapshot; indexes: { byProject: string } };
  blobs: { key: string; value: { hash: string; data: Uint8Array } };
  kv: { key: string; value: { key: string; value: unknown } };
}

let dbPromise: Promise<IDBPDatabase<TexBrowserDB>> | null = null;

export function db(): Promise<IDBPDatabase<TexBrowserDB>> {
  dbPromise ??= openDB<TexBrowserDB>('texbrowser', 1, {
    upgrade(d) {
      d.createObjectStore('projects', { keyPath: 'id' });
      const files = d.createObjectStore('files', { keyPath: ['projectId', 'path'] });
      files.createIndex('byProject', 'projectId');
      const snaps = d.createObjectStore('snapshots', { keyPath: 'id' });
      snaps.createIndex('byProject', 'projectId');
      d.createObjectStore('blobs', { keyPath: 'hash' });
      d.createObjectStore('kv', { keyPath: 'key' });
    },
    blocking() {
      // Another tab upgraded the schema: close so it can proceed.
      void dbPromise?.then((x) => x.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}

// ---- projects --------------------------------------------------------------

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await (await db()).getAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string) {
  return (await db()).get('projects', id);
}

export async function putProject(p: ProjectMeta) {
  await (await db()).put('projects', p);
}

export async function deleteProject(id: string) {
  const d = await db();
  const tx = d.transaction(['projects', 'files', 'snapshots'], 'readwrite');
  await tx.objectStore('projects').delete(id);
  for (const store of ['files', 'snapshots'] as const) {
    let cursor = await tx.objectStore(store).index('byProject').openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

// ---- files -------------------------------------------------------------------

export async function listFiles(projectId: string): Promise<StoredFile[]> {
  return (await db()).getAllFromIndex('files', 'byProject', projectId);
}

export async function putFiles(files: StoredFile[]) {
  if (!files.length) return;
  const tx = (await db()).transaction('files', 'readwrite');
  await Promise.all([...files.map((f) => tx.store.put(f)), tx.done]);
}

export async function deleteFiles(projectId: string, paths: string[]) {
  if (!paths.length) return;
  const tx = (await db()).transaction('files', 'readwrite');
  await Promise.all([...paths.map((p) => tx.store.delete([projectId, p])), tx.done]);
}

// ---- snapshots ---------------------------------------------------------------

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  const all = await (await db()).getAllFromIndex('snapshots', 'byProject', projectId);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putSnapshot(s: Snapshot) {
  await (await db()).put('snapshots', s);
}

export async function deleteSnapshot(id: string) {
  await (await db()).delete('snapshots', id);
}

export async function putBlob(hash: string, data: Uint8Array) {
  const d = await db();
  if (!(await d.getKey('blobs', hash))) await d.put('blobs', { hash, data });
}

export async function getBlob(hash: string) {
  return (await (await db()).get('blobs', hash))?.data;
}

// ---- key/value -------------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key))?.value as T | undefined;
}

export async function kvSet(key: string, value: unknown) {
  await (await db()).put('kv', { key, value });
}
