/**
 * Global UI state (zustand). The heavy objects — the Workspace, Monaco models,
 * the engine worker — live outside the store; the store holds what React
 * renders plus version counters that change when those objects change.
 */
import { create } from 'zustand';
import type { CompileResult } from '../engine/protocol';
import type { EngineSnapshot } from '../engine/EngineClient';
import type { SyncRect, SyncTex } from '../latex/synctex';
import type { Wizard } from '../editor/slash-commands';
import { DEFAULT_SETTINGS, type Diagnostic, type ProjectMeta, type Settings } from '../types';

export type CompileStatus = 'idle' | 'running' | 'success' | 'warnings' | 'errors' | 'failed' | 'cancelled' | 'crashed';

export type SidebarView = 'files' | 'outline' | 'github' | 'history' | 'engine';
export type BottomView = 'problems' | 'log' | 'console';

export type Dialog =
  | { type: 'new-project'; initialTemplate?: string }
  | { type: 'settings' }
  | { type: 'command-palette' }
  | { type: 'shortcuts' }
  | { type: 'wizard'; wizard: Wizard }
  | { type: 'prompt'; title: string; label: string; value: string; placeholder?: string; confirm: string; onSubmit: (v: string) => void | Promise<void> }
  | { type: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { type: 'diff'; title: string; path: string; original: string; modified: string; onRestore?: () => void };

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warning';
  title: string;
  message?: string;
  action?: { label: string; run: () => void };
  timeout?: number;
}

export interface CompileState {
  status: CompileStatus;
  result: Omit<CompileResult, 'pdf' | 'synctex'> | null;
  /** Last successfully produced PDF (kept visible while a later compile fails). */
  pdf: Uint8Array | null;
  pdfVersion: number;
  pdfFromCurrentRun: boolean;
  synctex: SyncTex | null;
  diagnostics: Diagnostic[];
  console: string;
  error: string | null;
  lastCompiledAt: number | null;
  dirtySinceCompile: boolean;
}

export interface AppState {
  settings: Settings;
  projects: ProjectMeta[];
  project: ProjectMeta | null;
  treeVersion: number;
  contentVersion: number;
  /** Incremented whenever a project is (re)opened and all editor models are recreated. */
  epoch: number;
  openTabs: string[];
  activePath: string | null;
  engine: EngineSnapshot;
  compile: CompileState;
  sidebar: SidebarView | null;
  bottom: BottomView | null;
  dialog: Dialog | null;
  toasts: Toast[];
  /** Ask the editor to reveal a location. */
  reveal: { path: string; line: number; column?: number; nonce: number } | null;
  /** Ask the PDF viewer to scroll to/highlight rectangles (SyncTeX forward search). */
  pdfTarget: { rects: SyncRect[]; nonce: number } | null;
  cursor: { line: number; column: number } | null;
  booting: boolean;
}

const SETTINGS_KEY = 'texbrowser.settings';

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const initialCompile: CompileState = {
  status: 'idle',
  result: null,
  pdf: null,
  pdfVersion: 0,
  pdfFromCurrentRun: false,
  synctex: null,
  diagnostics: [],
  console: '',
  error: null,
  lastCompiledAt: null,
  dirtySinceCompile: true,
};

export const useStore = create<AppState>(() => ({
  settings: loadSettings(),
  projects: [],
  project: null,
  treeVersion: 0,
  contentVersion: 0,
  epoch: 0,
  openTabs: [],
  activePath: null,
  engine: { state: 'idle', progress: null, info: null, error: null },
  compile: initialCompile,
  sidebar: 'files',
  bottom: null,
  dialog: null,
  toasts: [],
  reveal: null,
  pdfTarget: null,
  cursor: null,
  booting: true,
}));

export const getState = useStore.getState;
export const setState = useStore.setState;

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...getState().settings, ...patch };
  setState({ settings });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage full / disabled */
  }
}

export function patchCompile(patch: Partial<CompileState>) {
  setState((s) => ({ compile: { ...s.compile, ...patch } }));
}

let toastId = 0;
export function toast(t: Omit<Toast, 'id'>): number {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
  const timeout = t.timeout ?? (t.kind === 'error' ? 9000 : 4500);
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}

export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function openDialog(dialog: Dialog) {
  setState({ dialog });
}

export function closeDialog() {
  setState({ dialog: null });
}
