/**
 * GitHub panel: connect with a personal access token, link the project to a
 * repository folder, push/pull, gists, and open repositories as projects.
 */
import { useEffect, useMemo, useState } from 'react';
import { LogOut, Upload, Download, Link2, Unlink, ExternalLink, RefreshCw, KeyRound, FolderGit2, Plus, FileCode2, Lock, Globe } from 'lucide-react';
import { Github } from './icons';
import { useStore, toast } from '../state/store';
import {
  connectGitHub, disconnectGitHub, github, githubStatus, linkRepository, openFromGitHub, openGist, pullFromGitHub, pushToGitHub, saveToGist, unlinkRepository, createRepoAndLink,
} from '../state/github-actions';
import { loadToken, tokenRemembered, type RepoSummary } from '../storage/github';
import { timeAgo } from '../utils/misc';
import { Button, SectionTitle, TextInput, Spinner, clsx } from './ui';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,gist&description=TexBrowser%20IDE';

function useAsync() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      toast({ kind: 'error', title: `${label} failed`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

export function GitHubPanel() {
  const [token, setToken] = useState(loadToken());
  const [user, setUser] = useState<{ login: string; avatar_url: string } | null>(null);
  const [input, setInput] = useState('');
  const [remember, setRemember] = useState(tokenRemembered());
  const { busy, run } = useAsync();

  useEffect(() => {
    if (!token) return;
    github()
      .user()
      .then(setUser)
      .catch(() => {
        setUser(null);
      });
  }, [token]);

  return (
    <div className="flex h-full flex-col">
      <SectionTitle>GitHub</SectionTitle>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-6 text-[13px]">
        {!token || !user ? (
          <div className="space-y-3 rounded-lg border border-line bg-panel-2 p-3">
            <div className="flex items-center gap-2 font-medium text-fg">
              <Github className="size-4" /> Use GitHub as your cloud drive
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Paste a personal access token. It is sent only to api.github.com, straight from your browser — there is no TexBrowser server.
            </p>
            <TextInput type="password" autoComplete="off" placeholder="ghp_… or github_pat_…" value={input} onChange={(e) => setInput(e.target.value)} aria-label="GitHub token" />
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--c-accent)]" />
              Remember on this device (otherwise only for this tab session)
            </label>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<KeyRound className="size-3.5" />}
                loading={busy === 'Connect'}
                disabled={!input.trim()}
                onClick={() =>
                  run('Connect', async () => {
                    const u = await connectGitHub(input, remember);
                    setUser(u);
                    setToken(loadToken());
                    setInput('');
                    toast({ kind: 'success', title: `Connected as ${u.login}` });
                  })
                }
              >
                Connect
              </Button>
              <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                Create a token <ExternalLink className="size-3" />
              </a>
            </div>
            <p className="text-[11px] text-faint">Classic tokens need the <code>repo</code> (and <code>gist</code>) scope; fine-grained tokens need “Contents: read & write”.</p>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 p-2">
            <img src={user.avatar_url} alt="" className="size-7 rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-fg">{user.login}</div>
              <div className="text-[11px] text-muted">{tokenRemembered() ? 'Token remembered on this device' : 'Token kept for this session'}</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={<LogOut className="size-3.5" />}
              onClick={() => {
                disconnectGitHub();
                setToken(null);
                setUser(null);
              }}
            >
              Disconnect
            </Button>
          </div>
        )}

        {token && user && <ProjectSync login={user.login} />}

        <OpenRemote />
      </div>
    </div>
  );
}

function ProjectSync({ login }: { login: string }) {
  const project = useStore((s) => s.project);
  const contentVersion = useStore((s) => s.contentVersion);
  const link = project?.github;
  const { busy, run } = useAsync();
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Awaited<ReturnType<typeof githubStatus>>>(null);

  const refresh = () => run('Status', async () => setStatus(await githubStatus()));
  useEffect(() => {
    setStatus(null);
    if (link) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.owner, link?.repo, link?.branch, link?.path, link?.lastSync]);
  void contentVersion;

  if (!project) return null;

  if (!link) return <LinkRepo login={login} />;

  const changes = (status?.localChanged.length ?? 0) + (status?.localDeleted.length ?? 0);
  const remote = (status?.remoteChanged.length ?? 0) + (status?.remoteAdded.length ?? 0);
  const repoUrl = `https://github.com/${link.owner}/${link.repo}/tree/${link.branch}/${link.path}`;

  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex items-start gap-2">
        <FolderGit2 className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <a href={repoUrl} target="_blank" rel="noreferrer" className="block truncate font-medium text-fg hover:underline">
            {link.owner}/{link.repo}
          </a>
          <div className="truncate text-[11px] text-muted">
            {link.branch}
            {link.path ? ` · /${link.path}` : ' · repository root'}
            {link.lastSync ? ` · synced ${timeAgo(link.lastSync)}` : ' · never synced'}
          </div>
        </div>
        <button className="rounded p-1 text-faint hover:bg-hover hover:text-fg" title="Refresh status" onClick={refresh}>
          {busy === 'Status' ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        </button>
      </div>
      {status && (
        <div className="grid grid-cols-2 gap-2 text-center text-[11px]">
          <div className={clsx('rounded-md border border-line py-1.5', changes ? 'text-warn' : 'text-muted')}>
            <div className="text-base font-semibold">{changes}</div>local change{changes === 1 ? '' : 's'}
          </div>
          <div className={clsx('rounded-md border border-line py-1.5', remote ? 'text-info' : 'text-muted')}>
            <div className="text-base font-semibold">{remote}</div>change{remote === 1 ? '' : 's'} on GitHub
          </div>
        </div>
      )}
      <TextInput placeholder="Commit message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={<Upload className="size-3.5" />}
          loading={busy === 'Push'}
          onClick={() =>
            run('Push', async () => {
              await pushToGitHub(message);
              setMessage('');
              setStatus(await githubStatus());
            })
          }
        >
          Commit & push
        </Button>
        <Button size="sm" icon={<Download className="size-3.5" />} loading={busy === 'Pull'} onClick={() => run('Pull', pullFromGitHub)}>
          Pull
        </Button>
        <Button size="sm" variant="ghost" icon={<Unlink className="size-3.5" />} onClick={unlinkRepository}>
          Unlink
        </Button>
      </div>
      <GistSync />
    </div>
  );
}

function LinkRepo({ login }: { login: string }) {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<RepoSummary | null>(null);
  const [branch, setBranch] = useState('');
  const [path, setPath] = useState('');
  const [newName, setNewName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const { busy, run } = useAsync();
  const project = useStore((s) => s.project);

  useEffect(() => {
    void run('Load repositories', async () => setRepos(await github().repos()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setNewName((project?.name ?? 'latex-project').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, ''));
  }, [project?.name]);

  const shown = useMemo(() => (repos ?? []).filter((r) => r.canPush && r.fullName.toLowerCase().includes(filter.toLowerCase())).slice(0, 50), [repos, filter]);

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-line p-3">
        <div className="flex items-center gap-2 font-medium text-fg">
          <Link2 className="size-4 text-accent" /> Link this project to a repository
        </div>
        <TextInput placeholder="Search your repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="max-h-44 overflow-y-auto rounded-md border border-line">
          {!repos ? (
            <div className="flex items-center gap-2 p-3 text-xs text-muted"><Spinner className="size-3.5" /> Loading…</div>
          ) : !shown.length ? (
            <div className="p-3 text-xs text-muted">No repositories found.</div>
          ) : (
            shown.map((r) => (
              <button
                key={r.fullName}
                onClick={() => {
                  setPicked(r);
                  setBranch(r.defaultBranch);
                }}
                className={clsx('flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs', picked?.fullName === r.fullName ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-hover')}
              >
                {r.private ? <Lock className="size-3 shrink-0" /> : <Globe className="size-3 shrink-0" />}
                <span className="truncate">{r.fullName}</span>
              </button>
            ))
          )}
        </div>
        {picked && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-muted">
              Branch
              <TextInput value={branch} onChange={(e) => setBranch(e.target.value)} />
            </label>
            <label className="text-[11px] text-muted">
              Folder (optional)
              <TextInput placeholder="e.g. paper" value={path} onChange={(e) => setPath(e.target.value)} />
            </label>
          </div>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={!picked || !branch}
          icon={<Link2 className="size-3.5" />}
          onClick={() => picked && linkRepository({ owner: picked.owner, repo: picked.name, branch: branch.trim(), path: path.trim().replace(/^\/+|\/+$/g, '') })}
        >
          Link repository
        </Button>
      </div>

      <div className="space-y-2 rounded-lg border border-line p-3">
        <div className="flex items-center gap-2 font-medium text-fg">
          <Plus className="size-4 text-accent" /> Create a new repository
        </div>
        <div className="flex items-center gap-1 text-xs text-muted">
          <span>{login}/</span>
          <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} className="flex-1" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="accent-[var(--c-accent)]" /> Private repository
        </label>
        <Button size="sm" loading={busy === 'Create repository'} disabled={!newName} icon={<Github className="size-3.5" />} onClick={() => run('Create repository', () => createRepoAndLink(newName, isPrivate))}>
          Create & push
        </Button>
      </div>
      <GistSync />
    </div>
  );
}

function GistSync() {
  const gist = useStore((s) => s.project?.gist);
  const { busy, run } = useAsync();
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex items-center gap-2 text-xs font-medium text-fg">
        <FileCode2 className="size-3.5 text-accent-2" /> Gist backup
      </div>
      {gist ? (
        <div className="flex items-center gap-2 text-xs">
          <a href={gist.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-accent hover:underline">{gist.url.replace('https://', '')}</a>
          <Button size="sm" loading={busy === 'Gist'} onClick={() => run('Gist', () => saveToGist(false))}>Update</Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" loading={busy === 'Gist'} onClick={() => run('Gist', () => saveToGist(false))}>Save as secret gist</Button>
          <Button size="sm" variant="ghost" onClick={() => run('Gist', () => saveToGist(true))}>Public</Button>
        </div>
      )}
    </div>
  );
}

function OpenRemote() {
  const [repo, setRepo] = useState('');
  const [gist, setGist] = useState('');
  const { busy, run } = useAsync();
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-line p-3">
      <div className="text-xs font-medium text-fg">Open from GitHub as a new project</div>
      <div className="flex gap-2">
        <TextInput placeholder="owner/repo or github.com URL (…/tree/branch/folder)" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <Button size="sm" loading={busy === 'Open repository'} disabled={!repo.trim()} onClick={() => run('Open repository', async () => { await openFromGitHub(repo); setRepo(''); })}>
          Open
        </Button>
      </div>
      <div className="flex gap-2">
        <TextInput placeholder="Gist URL or ID" value={gist} onChange={(e) => setGist(e.target.value)} />
        <Button size="sm" loading={busy === 'Open gist'} disabled={!gist.trim()} onClick={() => run('Open gist', async () => { await openGist(gist); setGist(''); })}>
          Open
        </Button>
      </div>
      <p className="text-[11px] text-faint">Public repositories open without a token.</p>
    </div>
  );
}
