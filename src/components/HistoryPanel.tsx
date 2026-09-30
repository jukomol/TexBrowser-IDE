import { useCallback, useEffect, useState } from 'react';
import { History, Save, RotateCcw, GitCompare, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useStore, openDialog } from '../state/store';
import { restoreSnapshot, saveVersion, workspace } from '../state/actions';
import * as db from '../storage/db';
import type { Snapshot } from '../types';
import { timeAgo } from '../utils/misc';
import { Button, EmptyState, IconButton, SectionTitle } from './ui';

export function HistoryPanel() {
  const projectId = useStore((s) => s.project?.id);
  const lastCompiledAt = useStore((s) => s.compile.lastCompiledAt);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (projectId) setSnaps(await db.listSnapshots(projectId));
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload, lastCompiledAt]);

  const save = () =>
    openDialog({
      type: 'prompt',
      title: 'Save a version',
      label: 'Describe this version',
      value: '',
      placeholder: 'Draft sent to supervisor',
      confirm: 'Save version',
      onSubmit: async (label) => {
        await saveVersion(label);
        await reload();
      },
    });

  const compare = (s: Snapshot) => {
    const ws = workspace();
    if (!ws) return;
    const path = ws.project.mainFile;
    const file = s.files.find((f) => f.path === (useStoreActive() ?? path)) ?? s.files.find((f) => f.path === path);
    if (!file || file.kind !== 'text') return;
    openDialog({
      type: 'diff',
      title: `${file.path} — ${s.label} (${new Date(s.createdAt).toLocaleString()}) ↔ current`,
      path: file.path,
      original: file.text ?? '',
      modified: ws.getText(file.path) ?? '',
      onRestore: () => void restoreSnapshot(s).then(reload),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <SectionTitle actions={<IconButton size="sm" label="Save a version" onClick={save}><Save className="size-3.5" /></IconButton>}>History</SectionTitle>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {!snaps.length ? (
          <EmptyState icon={<History className="size-8" />} title="No versions yet">
            Versions are saved automatically after successful compiles (at most every 5 minutes), or manually.
            <div className="mt-3"><Button size="sm" icon={<Save className="size-3.5" />} onClick={save}>Save a version now</Button></div>
          </EmptyState>
        ) : (
          snaps.map((s) => (
            <div
              key={s.id}
              onClick={() => setSelected(s.id === selected ? null : s.id)}
              className={clsx('group mb-0.5 cursor-pointer rounded-md px-2 py-1.5', s.id === selected ? 'bg-accent/10' : 'hover:bg-hover')}
            >
              <div className="flex items-center gap-2">
                <span className={clsx('size-2 shrink-0 rounded-full', s.auto ? 'bg-faint' : 'bg-accent')} />
                <span className="flex-1 truncate text-[13px] text-fg">{s.label}</span>
                <span className="text-[11px] text-faint" title={new Date(s.createdAt).toLocaleString()}>{timeAgo(s.createdAt)}</span>
              </div>
              {s.id === selected && (
                <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
                  <Button size="sm" icon={<GitCompare className="size-3.5" />} onClick={(e) => { e.stopPropagation(); compare(s); }}>Compare</Button>
                  <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={(e) => {
                    e.stopPropagation();
                    openDialog({ type: 'confirm', title: 'Restore this version?', message: `All files will be replaced by “${s.label}”. Your current state is saved to history first.`, confirm: 'Restore', onConfirm: async () => { await restoreSnapshot(s); await reload(); } });
                  }}>Restore</Button>
                  <IconButton size="sm" label="Delete version" onClick={async (e) => { e.stopPropagation(); await db.deleteSnapshot(s.id); await reload(); }}><Trash2 className="size-3.5" /></IconButton>
                  <span className="w-full text-[11px] text-faint">{s.files.length} files</span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function useStoreActive() {
  return useStore.getState().activePath;
}
