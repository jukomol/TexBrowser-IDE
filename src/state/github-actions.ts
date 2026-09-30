/**
 * GitHub / Gist operations for the open project.
 */
import { ConflictError, GitHubClient, GitHubError, loadToken, parseRepoRef, saveToken, type SyncFile } from '../storage/github';
import { createSnapshot } from '../storage/history';
import type { GitHubLink } from '../types';
import { basename } from '../utils/paths';
import { KEEP } from './workspace';
import { compile, createProjectFromFiles, workspace } from './actions';
import { openDialog, setState, toast } from './store';
import { syncAllModels } from '../editor/models';

export const github = () => new GitHubClient(loadToken());

export async function connectGitHub(token: string, remember: boolean) {
  const c = new GitHubClient(token.trim());
  const user = await c.user();
  saveToken(token.trim(), remember);
  return user;
}

export function disconnectGitHub() {
  saveToken(null, false);
}

function projectFiles(): SyncFile[] {
  const ws = workspace();
  if (!ws) return [];
  return ws
    .paths()
    .filter((p) => basename(p) !== KEEP)
    .map((p) => {
      const f = ws.get(p)!;
      return f.kind === 'text' ? { path: p, text: f.text ?? '' } : { path: p, data: f.data ?? new Uint8Array() };
    });
}

export function linkRepository(link: GitHubLink) {
  workspace()?.updateMeta({ github: { ...link, shas: undefined, lastSync: undefined } });
}

export function unlinkRepository() {
  workspace()?.updateMeta({ github: undefined });
}

export async function pushToGitHub(message: string, force = false): Promise<void> {
  const ws = workspace();
  const link = ws?.project.github;
  if (!ws || !link) throw new Error('Link a repository first.');
  await ws.flush();
  try {
    const res = await github().push(link, projectFiles(), message || 'Update from TexBrowser IDE', { force });
    ws.updateMeta({ github: { ...link, shas: res.shas, lastSync: Date.now() } });
    if (res.status === 'up-to-date') toast({ kind: 'info', title: 'Already up to date', message: `${link.owner}/${link.repo}@${link.branch}` });
    else {
      toast({
        kind: 'success',
        title: `Pushed to ${link.owner}/${link.repo}`,
        message: `${res.changed.length} changed${res.deleted.length ? `, ${res.deleted.length} deleted` : ''}`,
        action: res.commitUrl ? { label: 'View commit', run: () => window.open(res.commitUrl, '_blank', 'noopener') } : undefined,
      });
    }
  } catch (err) {
    if (err instanceof ConflictError) {
      openDialog({
        type: 'confirm',
        title: 'Changes on GitHub',
        message: `${err.paths.join(', ')} changed on GitHub since your last sync and also locally. Pull first to merge, or overwrite GitHub with your version.`,
        confirm: 'Overwrite GitHub',
        danger: true,
        onConfirm: () => pushToGitHub(message, true),
      });
      return;
    }
    throw err;
  }
}

/**
 * Pull the linked folder. Remote files win for paths that changed remotely;
 * files deleted on GitHub (that were synced before) are removed; local-only
 * files are kept. A history snapshot is taken first.
 */
export async function pullFromGitHub(): Promise<void> {
  const ws = workspace();
  const link = ws?.project.github;
  if (!ws || !link) throw new Error('Link a repository first.');
  await ws.flush();
  const { files, shas } = await github().pull(link);
  await createSnapshot(ws, `Before pulling ${link.owner}/${link.repo}`, false);
  const remote = new Map(files.map((f) => [f.path, f]));
  const last = link.shas ?? {};
  const merged: SyncFile[] = [...files];
  for (const p of ws.paths()) {
    if (remote.has(p) || basename(p) === KEEP) continue;
    if (last[p] !== undefined) continue; // deleted on GitHub
    const f = ws.get(p)!;
    merged.push(f.kind === 'text' ? { path: p, text: f.text } : { path: p, data: f.data });
  }
  ws.replaceAll(merged);
  ws.updateMeta({ github: { ...link, shas, lastSync: Date.now() } });
  syncAllModels();
  const present = new Set(ws.paths());
  setState((s) => {
    const openTabs = s.openTabs.filter((p) => present.has(p));
    return { openTabs, activePath: s.activePath && present.has(s.activePath) ? s.activePath : (openTabs[0] ?? null) };
  });
  toast({ kind: 'success', title: `Pulled ${files.length} files`, message: `${link.owner}/${link.repo}@${link.branch}` });
  void compile({ reason: 'manual' });
}

export async function githubStatus() {
  const ws = workspace();
  const link = ws?.project.github;
  if (!ws || !link) return null;
  return github().status(link, projectFiles());
}

/** Create a new project from a GitHub repository (public repos work without a token). */
export async function openFromGitHub(input: string, branchOverride?: string, pathOverride?: string) {
  const ref = parseRepoRef(input);
  if (!ref) throw new GitHubError('Enter a repository as owner/name or a github.com URL.', 400);
  const c = github();
  let branch = branchOverride || ref.branch;
  if (!branch) branch = (await c.repo(ref.owner, ref.repo)).defaultBranch;
  const link: GitHubLink = { owner: ref.owner, repo: ref.repo, branch, path: pathOverride ?? ref.path ?? '' };
  const { files, shas } = await c.pull(link);
  await createProjectFromFiles(`${ref.repo}${link.path ? ` / ${link.path}` : ''}`, files, { github: { ...link, shas, lastSync: Date.now() } });
  toast({ kind: 'success', title: `Opened ${ref.owner}/${ref.repo}`, message: `${files.length} files · ${branch}` });
}

export async function createRepoAndLink(name: string, isPrivate: boolean) {
  const repo = await github().createRepo(name, isPrivate);
  linkRepository({ owner: repo.owner, repo: repo.name, branch: repo.defaultBranch, path: '' });
  await pushToGitHub('Initial commit from TexBrowser IDE');
  return repo;
}

// ---- Gists ------------------------------------------------------------------

export async function saveToGist(isPublic: boolean) {
  const ws = workspace();
  if (!ws) return;
  await ws.flush();
  const c = github();
  const files = projectFiles();
  const res = ws.project.gist
    ? await c.updateGist(ws.project.gist.id, files)
    : await c.createGist(`${ws.project.name} — LaTeX project (TexBrowser IDE)`, files, isPublic);
  ws.updateMeta({ gist: { id: res.id, url: res.url, lastSync: Date.now() } });
  toast({
    kind: 'success',
    title: ws.project.gist ? 'Gist updated' : 'Gist created',
    action: { label: 'Open gist', run: () => window.open(res.url, '_blank', 'noopener') },
  });
}

export async function openGist(input: string) {
  const id = /([0-9a-f]{20,})/i.exec(input)?.[1];
  if (!id) throw new Error('Enter a gist URL or ID');
  const g = await github().getGist(id);
  await createProjectFromFiles(g.description?.replace(/ — LaTeX project.*$/, '') || `Gist ${id.slice(0, 7)}`, g.files, { gist: { id, url: g.url, lastSync: Date.now() } });
}
