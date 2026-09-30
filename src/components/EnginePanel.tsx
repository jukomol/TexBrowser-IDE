import { useEffect } from 'react';
import { Cpu, Package, Trash2, RefreshCw, CheckCircle2, Circle, Cloud } from 'lucide-react';
import { useStore, toast, openDialog } from '../state/store';
import { engine, reconfigureEngine } from '../state/actions';
import { formatBytes } from '../utils/misc';
import { Button, ProgressBar, SectionTitle } from './ui';

export function EnginePanel() {
  const snap = useStore((s) => s.engine);
  const result = useStore((s) => s.compile.result);
  const info = snap.info;

  useEffect(() => {
    if (snap.state === 'idle') void engine.start().catch(() => undefined);
  }, [snap.state]);

  return (
    <div className="flex h-full flex-col">
      <SectionTitle>TeX engine</SectionTitle>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 text-[13px]">
        <div className="rounded-lg border border-line bg-panel-2 p-3">
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-accent" />
            <span className="font-medium text-fg">{info?.name ?? 'WebAssembly TeX'}</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            {snap.state === 'booting' ? 'Starting…' : snap.state === 'error' ? 'Failed to start' : info ? `Ready in ${(info.initMs / 1000).toFixed(1)} s · runs in a Web Worker` : 'Not started'}
          </div>
          {snap.progress && (
            <div className="mt-2 space-y-1">
              <div className="truncate text-[11px] text-muted">{snap.progress.message}</div>
              <ProgressBar value={snap.progress.loaded} total={snap.progress.total} />
            </div>
          )}
          {snap.error && <div className="mt-2 text-xs text-danger">{snap.error}</div>}
          {info && (
            <div className="mt-2 flex flex-wrap gap-1">
              {(['pdftex', 'xetex', 'luatex'] as const).map((e) => (
                <span key={e} className={info.engines.includes(e) ? 'rounded bg-ok/15 px-1.5 py-0.5 text-[10px] font-medium text-ok' : 'rounded bg-line px-1.5 py-0.5 text-[10px] text-faint line-through'}>
                  {e === 'pdftex' ? 'pdfLaTeX' : e === 'xetex' ? 'XeLaTeX' : 'LuaLaTeX'}
                </span>
              ))}
              <span className="rounded bg-line px-1.5 py-0.5 text-[10px] text-muted">BibTeX</span>
              <span className="rounded bg-line px-1.5 py-0.5 text-[10px] text-muted">makeindex</span>
            </div>
          )}
        </div>

        {info && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">TeX Live {info.texlive} collections</div>
            <div className="space-y-1">
              {info.collections.map((c) => (
                <div key={c.id} className="flex items-start gap-2 rounded-md px-1 py-1" title={c.id}>
                  {c.loaded ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-faint" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-fg">{c.label}</div>
                    <div className="text-[11px] text-faint">{formatBytes(c.bytes)} · {c.loaded ? 'mounted' : 'mounted automatically when needed'}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {info && (
          <div className="rounded-lg border border-line p-3">
            <div className="flex items-center gap-2 font-medium text-fg">
              <Cloud className="size-4 text-accent-2" /> On-demand package shelf
            </div>
            {info.shelf.enabled ? (
              <div className="mt-1 space-y-1 text-xs text-muted">
                <div>{info.shelf.label}</div>
                <div>{info.shelf.bundles.toLocaleString()} packages & fonts available · {info.shelf.cached} cached offline</div>
                <div className="text-faint">Missing packages (TikZ, biblatex, cm-super fonts, …) are fetched automatically the first time a document needs them.</div>
              </div>
            ) : (
              <div className="mt-1 text-xs text-muted">Disabled — only the base collections are available. Enable it in Settings.</div>
            )}
          </div>
        )}

        {result && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Last build</div>
            <div className="space-y-0.5 font-mono text-[11px] text-muted">
              {result.steps.map((s, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span className={s.exitCode === 0 ? '' : 'text-warn'}>{s.tool}</span>
                  <span>{s.ms} ms</span>
                </div>
              ))}
              <div className="flex justify-between gap-2 border-t border-line pt-1 text-fg">
                <span>total ({result.passes} pass{result.passes > 1 ? 'es' : ''})</span>
                <span>{result.durationMs} ms</span>
              </div>
            </div>
            {result.fetched.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {result.fetched.map((f) => (
                  <span key={f} className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"><Package className="size-2.5" />{f}</span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reconfigureEngine}>Restart engine</Button>
          <Button
            size="sm"
            icon={<Trash2 className="size-3.5" />}
            onClick={() =>
              openDialog({
                type: 'confirm',
                title: 'Clear engine caches?',
                message: 'Downloaded TeX Live data and packages will be removed from this browser and downloaded again on the next compile. Your projects are not affected.',
                confirm: 'Clear caches',
                danger: true,
                onConfirm: async () => {
                  await engine.clearCache();
                  reconfigureEngine();
                  toast({ kind: 'success', title: 'Engine caches cleared' });
                },
              })
            }
          >
            Clear caches
          </Button>
        </div>
      </div>
    </div>
  );
}
