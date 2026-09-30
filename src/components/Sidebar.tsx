import { Files, ListTree, History, Cpu, Settings, Keyboard, CircleHelp } from 'lucide-react';
import { Github } from './icons';
import { useStore, setState, openDialog, type SidebarView } from '../state/store';
import { FileTree } from './FileTree';
import { OutlinePanel } from './OutlinePanel';
import { GitHubPanel } from './GitHubPanel';
import { HistoryPanel } from './HistoryPanel';
import { EnginePanel } from './EnginePanel';
import { clsx } from './ui';
import { newProjectDialog } from '../state/actions';

const VIEWS: { id: SidebarView; label: string; icon: React.ReactNode }[] = [
  { id: 'files', label: 'Files', icon: <Files className="size-[18px]" /> },
  { id: 'outline', label: 'Outline', icon: <ListTree className="size-[18px]" /> },
  { id: 'github', label: 'GitHub', icon: <Github className="size-[18px]" /> },
  { id: 'history', label: 'History', icon: <History className="size-[18px]" /> },
  { id: 'engine', label: 'TeX engine & packages', icon: <Cpu className="size-[18px]" /> },
];

export function ActivityBar() {
  const sidebar = useStore((s) => s.sidebar);
  const btn = (active: boolean, label: string, icon: React.ReactNode, onClick: () => void) => (
    <button
      key={label}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'focus-ring relative flex size-10 items-center justify-center rounded-lg transition-colors',
        active ? 'text-fg before:absolute before:-left-1.5 before:h-5 before:w-0.5 before:rounded-full before:bg-accent' : 'text-faint hover:text-fg',
      )}
    >
      {icon}
    </button>
  );
  return (
    <nav className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2 sm:flex" aria-label="Sidebar views">
      {VIEWS.map((v) => btn(sidebar === v.id, v.label, v.icon, () => setState({ sidebar: sidebar === v.id ? null : v.id })))}
      <div className="flex-1" />
      {btn(false, 'Help & templates', <CircleHelp className="size-[18px]" />, () => newProjectDialog())}
      {btn(false, 'Keyboard shortcuts', <Keyboard className="size-[18px]" />, () => openDialog({ type: 'shortcuts' }))}
      {btn(false, 'Settings', <Settings className="size-[18px]" />, () => openDialog({ type: 'settings' }))}
    </nav>
  );
}

export function Sidebar() {
  const sidebar = useStore((s) => s.sidebar);
  return (
    <aside className="h-full border-r border-line bg-panel" aria-label="Sidebar">
      {sidebar === 'files' && <FileTree />}
      {sidebar === 'outline' && <OutlinePanel />}
      {sidebar === 'github' && <GitHubPanel />}
      {sidebar === 'history' && <HistoryPanel />}
      {sidebar === 'engine' && <EnginePanel />}
    </aside>
  );
}
