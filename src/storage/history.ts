/**
 * Local version history. Snapshots store every text file verbatim and binary
 * files by content hash (deduplicated in the `blobs` store), so hundreds of
 * versions of an image-heavy project cost almost nothing.
 */
import * as store from './db';
import type { Snapshot } from '../types';
import type { Workspace } from '../state/workspace';
import { sha256Hex, uid } from '../utils/misc';

const MAX_AUTO = 40;

/** Fingerprint of the workspace contents, to avoid storing identical snapshots. */
export function contentKey(ws: Workspace): string {
  let h = 0;
  for (const p of ws.paths()) {
    const f = ws.get(p)!;
    const s = `${p}:${f.kind === 'text' ? f.text : f.data?.length}`;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

export async function createSnapshot(ws: Workspace, label: string, auto: boolean): Promise<Snapshot> {
  const files: Snapshot['files'] = [];
  for (const p of ws.paths()) {
    const f = ws.get(p)!;
    if (f.kind === 'text') files.push({ path: p, kind: 'text', text: f.text ?? '' });
    else if (f.data) {
      const hash = await sha256Hex(f.data);
      await store.putBlob(hash, f.data);
      files.push({ path: p, kind: 'binary', blob: hash });
    }
  }
  const snap: Snapshot = { id: uid('s_'), projectId: ws.project.id, createdAt: Date.now(), label, auto, files };
  await store.putSnapshot(snap);
  if (auto) {
    const autos = (await store.listSnapshots(ws.project.id)).filter((s) => s.auto);
    for (const old of autos.slice(MAX_AUTO)) await store.deleteSnapshot(old.id);
  }
  return snap;
}

export async function snapshotFiles(snap: Snapshot): Promise<{ path: string; text?: string; data?: Uint8Array }[]> {
  const out: { path: string; text?: string; data?: Uint8Array }[] = [];
  for (const f of snap.files) {
    if (f.kind === 'text') out.push({ path: f.path, text: f.text ?? '' });
    else if (f.blob) {
      const data = await store.getBlob(f.blob);
      if (data) out.push({ path: f.path, data });
    }
  }
  return out;
}
