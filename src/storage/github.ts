/**
 * GitHub as a zero-backend cloud drive — REST API v3 via fetch() only.
 *
 * Push = one atomic commit through the Git Data API:
 *   blobs (only for changed files) → tree (on top of the current tree) →
 *   commit → fast-forward the branch ref.
 *
 * Safety rules:
 *   - files that exist in the repository but were never part of the project
 *     (README, CI config…) are never deleted,
 *   - a file changed both locally and on GitHub since the last sync is a
 *     conflict: the push stops and the user decides (pull first or overwrite).
 *
 * Gists are supported too (flat namespace, so paths are encoded and a small
 * manifest restores folders and binary files).
 */
import type { GitHubLink } from '../types';
import { base64ToBytes, bytesToBase64, sha1Hex } from '../utils/misc';
import { isTextPath, normalisePath } from '../utils/paths';
import { looksBinary } from '../state/workspace';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
  description: string | null;
  canPush: boolean;
}

export interface SyncFile {
  path: string;
  text?: string;
  data?: Uint8Array;
}

export interface PushResult {
  status: 'pushed' | 'up-to-date';
  commitSha?: string;
  commitUrl?: string;
  changed: string[];
  deleted: string[];
  shas: Record<string, string>;
}

export class ConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`These files changed both locally and on GitHub since the last sync: ${paths.join(', ')}`);
    this.name = 'ConflictError';
  }
}

const enc = new TextEncoder();
const bytesOf = (f: SyncFile) => (f.data ? f.data : enc.encode(f.text ?? ''));

/** The SHA-1 git uses for a blob: sha1("blob <len>\0<content>"). */
export async function gitBlobSha(content: Uint8Array): Promise<string> {
  const header = enc.encode(`blob ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header);
  buf.set(content, header.length);
  return sha1Hex(buf);
}

function decodeFile(path: string, bytes: Uint8Array): SyncFile {
  return isTextPath(path) && !looksBinary(bytes) ? { path, text: new TextDecoder().decode(bytes) } : { path, data: bytes };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** Parse "owner/repo", "https://github.com/owner/repo/tree/branch/path" etc. */
export function parseRepoRef(input: string): { owner: string; repo: string; branch?: string; path?: string } | null {
  const s = input.trim().replace(/\.git$/, '');
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?/.exec(s);
  if (url) return { owner: url[1], repo: url[2], branch: url[3], path: url[4]?.replace(/\/$/, '') };
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  return short ? { owner: short[1], repo: short[2] } : null;
}

export class GitHubClient {
  constructor(private token: string | null) {}

  get authenticated() {
    return !!this.token;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch {
      throw new GitHubError('Could not reach GitHub — check your internet connection.', 0);
    }
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg = (json as { message?: string }).message ?? res.statusText;
      if (res.status === 401) msg = 'GitHub rejected the token (401). Check that it is valid and not expired.';
      else if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        msg = `GitHub API rate limit reached. Try again ${reset ? 'after ' + new Date(reset).toLocaleTimeString() : 'later'}${this.token ? '' : ' or add a token'}.`;
      } else if (res.status === 403 || res.status === 404) {
        msg += this.token
          ? ' — make sure the token has access to this repository (classic: "repo" scope; fine-grained: Contents read & write).'
          : ' — private repositories need a personal access token.';
      }
      throw new GitHubError(msg, res.status);
    }
    return json as T;
  }

  async user(): Promise<{ login: string; name: string | null; avatar_url: string }> {
    return this.req('GET', '/user');
  }

  async repos(): Promise<RepoSummary[]> {
    const out: RepoSummary[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.req<any[]>('GET', `/user/repos?per_page=100&sort=updated&page=${page}&affiliation=owner,collaborator,organization_member`);
      out.push(...batch.map(toRepo));
      if (batch.length < 100) break;
    }
    return out;
  }

  async repo(owner: string, repo: string): Promise<RepoSummary> {
    return toRepo(await this.req<any>('GET', `/repos/${owner}/${repo}`));
  }

  async branches(owner: string, repo: string): Promise<string[]> {
    const list = await this.req<{ name: string }[]>('GET', `/repos/${owner}/${repo}/branches?per_page=100`);
    return list.map((b) => b.name);
  }

  async createRepo(name: string, isPrivate: boolean, description = 'LaTeX project from TexBrowser IDE'): Promise<RepoSummary> {
    return toRepo(await this.req<any>('POST', '/user/repos', { name, private: isPrivate, description, auto_init: true }));
  }

  /** Current head commit + full recursive tree of a branch (null if the repo is empty). */
  private async head(owner: string, repo: string, branch: string) {
    let ref: { object: { sha: string } };
    try {
      ref = await this.req('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
    const commit = await this.req<{ sha: string; tree: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    const tree = await this.req<{ tree: { path: string; type: string; sha: string; mode: string }[]; truncated: boolean }>(
      'GET',
      `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (tree.truncated) throw new GitHubError('This repository is too large to sync through the API.', 413);
    return { commitSha: commit.sha, treeSha: commit.tree.sha, entries: tree.tree };
  }

  private prefix(link: GitHubLink) {
    const p = link.path.replace(/^\/+|\/+$/g, '');
    return p ? p + '/' : '';
  }

  /** Download the project folder of a repository. */
  async pull(link: GitHubLink): Promise<{ files: SyncFile[]; shas: Record<string, string>; commitSha: string }> {
    const head = await this.head(link.owner, link.repo, link.branch);
    if (!head) throw new GitHubError(`Branch "${link.branch}" not found (or the repository is empty).`, 404);
    const prefix = this.prefix(link);
    const blobs = head.entries.filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && e.mode !== '120000');
    if (!blobs.length) throw new GitHubError(`No files found under "${link.path || '/'}" on ${link.branch}.`, 404);
    if (blobs.length > 800) throw new GitHubError(`Too many files (${blobs.length}) under that path.`, 413);
    const shas: Record<string, string> = {};
    const files = await mapLimit(blobs, 6, async (b) => {
      const rel = normalisePath(b.path.slice(prefix.length))!;
      shas[rel] = b.sha;
      let bytes: Uint8Array;
      if (this.token) {
        const blob = await this.req<{ content: string; encoding: string }>('GET', `/repos/${link.owner}/${link.repo}/git/blobs/${b.sha}`);
        bytes = blob.encoding === 'base64' ? base64ToBytes(blob.content) : enc.encode(blob.content);
      } else {
        // Anonymous: raw.githubusercontent.com is CORS-enabled and not API rate-limited.
        const res = await fetch(`https://raw.githubusercontent.com/${link.owner}/${link.repo}/${head.commitSha}/${b.path.split('/').map(encodeURIComponent).join('/')}`);
        if (!res.ok) throw new GitHubError(`Failed to download ${b.path} (${res.status})`, res.status);
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      return decodeFile(rel, bytes);
    });
    return { files, shas, commitSha: head.commitSha };
  }

  /** Commit the project to the repository in a single commit. */
  async push(link: GitHubLink, files: SyncFile[], message: string, opts: { force?: boolean } = {}): Promise<PushResult> {
    const { owner, repo, branch } = link;
    let head = await this.head(owner, repo, branch);
    if (!head) {
      const info = await this.repo(owner, repo);
      const base = await this.head(owner, repo, info.defaultBranch).catch(() => null);
      if (base) {
        // Create the branch from the default branch.
        await this.req('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.commitSha });
      } else {
        // Empty repository: the Git Data API needs one commit to exist first.
        await this.req('PUT', `/repos/${owner}/${repo}/contents/README.md`, {
          message: 'Initial commit',
          content: bytesToBase64(enc.encode(`# ${repo}\n\nLaTeX project synced from TexBrowser IDE.\n`)),
          branch,
        });
      }
      head = await this.head(owner, repo, branch);
      if (!head) throw new GitHubError('Could not initialise the branch.', 500);
    }

    const prefix = this.prefix(link);
    const remote = new Map(head.entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    const last = link.shas ?? {};
    const shas: Record<string, string> = {};
    const changed: SyncFile[] = [];
    const conflicts: string[] = [];

    for (const f of files) {
      const sha = await gitBlobSha(bytesOf(f));
      shas[f.path] = sha;
      const remoteSha = remote.get(prefix + f.path);
      if (remoteSha === sha) continue;
      // Changed on GitHub since our last sync *and* changed locally → conflict.
      if (!opts.force && remoteSha && last[f.path] && remoteSha !== last[f.path] && sha !== last[f.path]) conflicts.push(f.path);
      changed.push(f);
    }
    const local = new Set(files.map((f) => f.path));
    // Only delete files we previously synced and the user removed locally.
    const deleted = Object.keys(last).filter((p) => !local.has(p) && remote.has(prefix + p));
    for (const p of deleted) if (!opts.force && remote.get(prefix + p) !== last[p]) conflicts.push(p);
    if (conflicts.length) throw new ConflictError(conflicts);

    if (!changed.length && !deleted.length) return { status: 'up-to-date', changed: [], deleted: [], shas };

    const treeEntries = await mapLimit(changed, 4, async (f) => {
      const blob = f.data
        ? await this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, { content: bytesToBase64(f.data), encoding: 'base64' })
        : await this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, { content: f.text ?? '', encoding: 'utf-8' });
      return { path: prefix + f.path, mode: '100644', type: 'blob', sha: blob.sha };
    });
    for (const p of deleted) treeEntries.push({ path: prefix + p, mode: '100644', type: 'blob', sha: null as unknown as string });

    const tree = await this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: head.treeSha, tree: treeEntries });
    const commit = await this.req<{ sha: string; html_url: string }>('POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [head.commitSha],
    });
    await this.req('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
    return { status: 'pushed', commitSha: commit.sha, commitUrl: commit.html_url, changed: changed.map((f) => f.path), deleted, shas };
  }

  /** Compare local files with the last-synced state and the current remote tree. */
  async status(link: GitHubLink, files: SyncFile[]) {
    const head = await this.head(link.owner, link.repo, link.branch);
    const prefix = this.prefix(link);
    const remote = new Map((head?.entries ?? []).filter((e) => e.type === 'blob' && e.path.startsWith(prefix)).map((e) => [e.path.slice(prefix.length), e.sha]));
    const last = link.shas ?? {};
    const localChanged: string[] = [];
    for (const f of files) if ((await gitBlobSha(bytesOf(f))) !== last[f.path]) localChanged.push(f.path);
    const localDeleted = Object.keys(last).filter((p) => !files.some((f) => f.path === p));
    const remoteChanged = [...remote.entries()].filter(([p, sha]) => last[p] !== undefined && last[p] !== sha).map(([p]) => p);
    const remoteAdded = [...remote.keys()].filter((p) => last[p] === undefined && !files.some((f) => f.path === p));
    return { localChanged, localDeleted, remoteChanged, remoteAdded, commitSha: head?.commitSha ?? null };
  }

  // ---- Gists -------------------------------------------------------------------

  static readonly GIST_MANIFEST = '.texbrowser.json';

  private gistPayload(files: SyncFile[], previous?: Set<string>) {
    const manifest: Record<string, { path: string; binary?: boolean }> = {};
    const out: Record<string, { content: string } | null> = {};
    for (const f of files) {
      const name = f.path.replace(/\//g, '∕') + (f.data ? '.b64' : '');
      manifest[name] = { path: f.path, binary: !!f.data || undefined };
      out[name] = { content: f.data ? bytesToBase64(f.data) : f.text?.length ? f.text : ' ' };
    }
    out[GitHubClient.GIST_MANIFEST] = { content: JSON.stringify({ version: 1, files: manifest }, null, 2) };
    for (const old of previous ?? []) if (!(old in out)) out[old] = null;
    return out;
  }

  async createGist(description: string, files: SyncFile[], isPublic = false): Promise<{ id: string; url: string }> {
    const g = await this.req<{ id: string; html_url: string }>('POST', '/gists', { description, public: isPublic, files: this.gistPayload(files) });
    return { id: g.id, url: g.html_url };
  }

  async updateGist(id: string, files: SyncFile[]): Promise<{ id: string; url: string }> {
    const current = await this.req<{ files: Record<string, unknown> }>('GET', `/gists/${id}`);
    const g = await this.req<{ id: string; html_url: string }>('PATCH', `/gists/${id}`, {
      files: this.gistPayload(files, new Set(Object.keys(current.files))),
    });
    return { id: g.id, url: g.html_url };
  }

  async listGists(): Promise<{ id: string; description: string; url: string; updatedAt: string; files: string[] }[]> {
    const list = await this.req<any[]>('GET', '/gists?per_page=100');
    return list.map((g) => ({ id: g.id, description: g.description ?? '', url: g.html_url, updatedAt: g.updated_at, files: Object.keys(g.files) }));
  }

  async getGist(id: string): Promise<{ files: SyncFile[]; url: string; description: string }> {
    const g = await this.req<{ html_url: string; description: string; files: Record<string, { content?: string; truncated?: boolean; raw_url: string }> }>(
      'GET',
      `/gists/${id}`,
    );
    const contentOf = async (f: { content?: string; truncated?: boolean; raw_url: string }) =>
      f.truncated || f.content === undefined ? await (await fetch(f.raw_url)).text() : f.content;
    const manifestFile = g.files[GitHubClient.GIST_MANIFEST];
    const manifest: Record<string, { path: string; binary?: boolean }> = manifestFile
      ? (JSON.parse(await contentOf(manifestFile)) as { files: Record<string, { path: string; binary?: boolean }> }).files
      : {};
    const files: SyncFile[] = [];
    for (const [name, f] of Object.entries(g.files)) {
      if (name === GitHubClient.GIST_MANIFEST) continue;
      const m = manifest[name] ?? { path: name.replace(/∕/g, '/') };
      const path = normalisePath(m.path);
      if (!path) continue;
      const content = await contentOf(f);
      files.push(m.binary ? { path, data: base64ToBytes(content) } : { path, text: content === ' ' ? '' : content });
    }
    return { files, url: g.html_url, description: g.description };
  }
}

function toRepo(r: any): RepoSummary {
  return {
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch ?? 'main',
    updatedAt: r.updated_at,
    description: r.description,
    canPush: r.permissions ? !!r.permissions.push : true,
  };
}

// ---- token storage ---------------------------------------------------------------

const TOKEN_KEY = 'texbrowser.github.token';

export function loadToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string | null, remember: boolean) {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  if (!token) return;
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
}

export const tokenRemembered = () => localStorage.getItem(TOKEN_KEY) !== null;
