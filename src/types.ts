/** Shared application types. */
import type { TexEngine } from './engine/protocol';

export type FileKind = 'text' | 'binary';

/** A file of a project as stored in IndexedDB. */
export interface StoredFile {
  projectId: string;
  /** POSIX path relative to the project root, e.g. `chapters/intro.tex`. */
  path: string;
  kind: FileKind;
  text?: string;
  data?: Uint8Array;
  updatedAt: number;
}

export interface GitHubLink {
  owner: string;
  repo: string;
  branch: string;
  /** Folder inside the repository ('' = repository root). */
  path: string;
  /** Blob SHAs of the files as last synced (path → sha), for change detection. */
  shas?: Record<string, string>;
  lastSync?: number;
}

export interface GistLink {
  id: string;
  url: string;
  lastSync?: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  mainFile: string;
  engine: TexEngine;
  template?: string;
  github?: GitHubLink;
  gist?: GistLink;
  openTabs?: string[];
  activePath?: string | null;
}

export interface Snapshot {
  id: string;
  projectId: string;
  createdAt: number;
  label: string;
  auto: boolean;
  files: { path: string; kind: FileKind; text?: string; blob?: string }[];
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Project-relative file path, when known. */
  file?: string;
  line?: number;
  /** Extra lines from the log that explain the problem. */
  context?: string;
  /** Raw log excerpt. */
  raw?: string;
  source: 'latex' | 'bibtex' | 'engine';
}

export type ThemeMode = 'dark' | 'light' | 'system';

export interface Settings {
  theme: ThemeMode;
  editorFontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  autoCompile: boolean;
  autoCompileDelay: number;
  bibtex: 'auto' | 'always' | 'never';
  haltOnError: boolean;
  useShelf: boolean;
  pdfDarkMode: boolean;
  pdfNative: boolean;
  beginnerMode: boolean;
  slashCommands: boolean;
  mathPreview: boolean;
  formatBar: boolean;
  engineUrl: string;
  shelfUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  editorFontSize: 14,
  wordWrap: true,
  minimap: false,
  autoCompile: true,
  autoCompileDelay: 1500,
  bibtex: 'auto',
  haltOnError: false,
  useShelf: true,
  pdfDarkMode: false,
  pdfNative: false,
  beginnerMode: true,
  slashCommands: true,
  mathPreview: true,
  formatBar: true,
  engineUrl: '',
  shelfUrl: '',
};
