import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, GitHubClient, gitBlobSha, parseRepoRef } from '../../src/storage/github';
import { base64ToBytes, bytesToBase64 } from '../../src/utils/misc';
import type { GitHubLink } from '../../src/types';

/** A tiny in-memory GitHub: blobs, trees, commits and one branch. */
class FakeGitHub {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, { tree: string; parents: string[] }>();
  head = '';
  blobPosts = 0;
  gists = new Map<string, Record<string, { content: string }>>();
  private n = 0;
  private id = (p: string) => `${p}${++this.n}`.padEnd(40, '0');

  async seed(files: Record<string, string>) {
    const tree = new Map<string, string>();
    for (const [p, c] of Object.entries(files)) {
      const data = new TextEncoder().encode(c);
      const sha = await gitBlobSha(data);
      this.blobs.set(sha, data);
      tree.set(p, sha);
    }
    const t = this.id('t');
    this.trees.set(t, tree);
    const c = this.id('c');
    this.commits.set(c, { tree: t, parents: [] });
    this.head = c;
  }

  fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const p = u.pathname;
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/repos/o/r') return json(200, { owner: { login: 'o' }, name: 'r', full_name: 'o/r', private: true, default_branch: 'main', permissions: { push: true } });
    if (method === 'GET' && p === '/repos/o/r/git/ref/heads/main') return this.head ? json(200, { object: { sha: this.head } }) : json(409, { message: 'Git Repository is empty.' });
    if (method === 'GET' && (m = /^\/repos\/o\/r\/git\/commits\/(\w+)$/.exec(p))) return json(200, { sha: m[1], tree: { sha: this.commits.get(m[1])!.tree } });
    if (method === 'GET' && (m = /^\/repos\/o\/r\/git\/trees\/(\w+)$/.exec(p))) {
      const tree = this.trees.get(m[1])!;
      return json(200, { truncated: false, tree: [...tree].map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644' })) });
    }
    if (method === 'GET' && (m = /^\/repos\/o\/r\/git\/blobs\/(\w+)$/.exec(p))) return json(200, { content: bytesToBase64(this.blobs.get(m[1])!), encoding: 'base64' });
    if (method === 'POST' && p === '/repos/o/r/git/blobs') {
      this.blobPosts++;
      const data = body.encoding === 'base64' ? base64ToBytes(body.content) : new TextEncoder().encode(body.content);
      const sha = await gitBlobSha(data);
      this.blobs.set(sha, data);
      return json(201, { sha });
    }
    if (method === 'POST' && p === '/repos/o/r/git/trees') {
      const tree = new Map(this.trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.sha === null) tree.delete(e.path);
        else tree.set(e.path, e.sha);
      }
      const t = this.id('t');
      this.trees.set(t, tree);
      return json(201, { sha: t });
    }
    if (method === 'POST' && p === '/repos/o/r/git/commits') {
      const c = this.id('c');
      this.commits.set(c, { tree: body.tree, parents: body.parents });
      return json(201, { sha: c, html_url: `https://github.com/o/r/commit/${c}` });
    }
    if (method === 'PATCH' && p === '/repos/o/r/git/refs/heads/main') {
      expect(this.commits.get(body.sha)!.parents).toEqual([this.head]); // fast-forward only
      this.head = body.sha;
      return json(200, {});
    }
    if (method === 'POST' && p === '/gists') {
      const id = this.id('g');
      this.gists.set(id, body.files);
      return json(201, { id, html_url: `https://gist.github.com/${id}` });
    }
    if (method === 'GET' && (m = /^\/gists\/(\w+)$/.exec(p))) {
      const files = Object.fromEntries(Object.entries(this.gists.get(m[1])!).map(([k, v]) => [k, { content: v.content, raw_url: '' }]));
      return json(200, { html_url: '', description: '', files });
    }
    return json(404, { message: `unhandled ${method} ${p}` });
  });

  files(): Record<string, string> {
    const tree = this.trees.get(this.commits.get(this.head)!.tree)!;
    return Object.fromEntries([...tree].map(([p, sha]) => [p, new TextDecoder().decode(this.blobs.get(sha))]));
  }
}

describe('GitHub sync', () => {
  let gh: FakeGitHub;
  let client: GitHubClient;
  const link: GitHubLink = { owner: 'o', repo: 'r', branch: 'main', path: 'paper' };

  beforeEach(async () => {
    gh = new FakeGitHub();
    await gh.seed({ 'README.md': '# repo', 'paper/old.tex': 'stale' });
    vi.stubGlobal('fetch', gh.fetch);
    client = new GitHubClient('token');
    link.shas = undefined;
  });

  it('computes git blob SHAs like `git hash-object`', async () => {
    expect(await gitBlobSha(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('pushes a project folder as one commit and leaves unrelated files alone', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2]);
    const r = await client.push(link, [{ path: 'main.tex', text: '\\documentclass{article}' }, { path: 'img/a.png', data: png }], 'first');
    expect(r.status).toBe('pushed');
    const files = gh.files();
    expect(files['paper/main.tex']).toBe('\\documentclass{article}');
    expect(files['README.md']).toBe('# repo');
    expect(files['paper/old.tex']).toBe('stale'); // never synced → never deleted
    expect(gh.blobs.get((await gitBlobSha(png)))).toEqual(png);

    // Unchanged → nothing to do.
    link.shas = r.shas;
    expect((await client.push(link, [{ path: 'main.tex', text: '\\documentclass{article}' }, { path: 'img/a.png', data: png }], 'again')).status).toBe('up-to-date');

    // One edit → one blob upload; a removed synced file is deleted remotely.
    gh.blobPosts = 0;
    const r2 = await client.push(link, [{ path: 'main.tex', text: 'edited' }], 'edit');
    expect(gh.blobPosts).toBe(1);
    expect(r2.deleted).toEqual(['img/a.png']);
    expect(gh.files()['paper/img/a.png']).toBeUndefined();
  });

  it('detects conflicting edits and can force-push', async () => {
    const r = await client.push(link, [{ path: 'main.tex', text: 'v1' }], 'v1');
    link.shas = r.shas;
    // Someone edits on GitHub…
    await gh.seed({ ...gh.files(), 'paper/main.tex': 'remote edit' });
    // …and we edit locally too.
    await expect(client.push(link, [{ path: 'main.tex', text: 'local edit' }], 'v2')).rejects.toBeInstanceOf(ConflictError);
    const forced = await client.push(link, [{ path: 'main.tex', text: 'local edit' }], 'v2', { force: true });
    expect(forced.status).toBe('pushed');
    expect(gh.files()['paper/main.tex']).toBe('local edit');
  });

  it('pulls a folder with binary files', async () => {
    await client.push(link, [{ path: 'main.tex', text: 'hi' }, { path: 'fig.png', data: new Uint8Array([0, 1, 2, 3]) }], 'x');
    const pulled = await client.pull(link);
    const byPath = Object.fromEntries(pulled.files.map((f) => [f.path, f]));
    expect(byPath['main.tex'].text).toBe('hi');
    expect(byPath['fig.png'].data).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(byPath['old.tex'].text).toBe('stale');
    expect(Object.keys(pulled.shas).sort()).toEqual(['fig.png', 'main.tex', 'old.tex']);
  });

  it('round-trips projects through gists (folders + binaries)', async () => {
    const { id } = await client.createGist('d', [{ path: 'chapters/a.tex', text: 'A' }, { path: 'img.png', data: new Uint8Array([9, 0, 9]) }]);
    const g = await client.getGist(id);
    expect(g.files).toEqual([{ path: 'chapters/a.tex', text: 'A' }, { path: 'img.png', data: new Uint8Array([9, 0, 9]) }]);
  });
});

describe('parseRepoRef', () => {
  it('understands URLs and shorthands', () => {
    expect(parseRepoRef('octo/paper')).toEqual({ owner: 'octo', repo: 'paper' });
    expect(parseRepoRef('https://github.com/octo/paper.git')).toMatchObject({ owner: 'octo', repo: 'paper' });
    expect(parseRepoRef('https://github.com/octo/paper/tree/dev/thesis/')).toEqual({ owner: 'octo', repo: 'paper', branch: 'dev', path: 'thesis' });
    expect(parseRepoRef('not a repo')).toBeNull();
  });
});
