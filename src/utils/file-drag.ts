/**
 * Window-wide tracking of files being dragged in from the operating system.
 *
 * Only the file tree in the sidebar accepts dropped files. This module
 *  - tells components whether a file drag is in progress (so the sidebar can
 *    light up as the drop target), and
 *  - stops a drop anywhere else from doing something surprising: the browser
 *    would otherwise open the file in place of the IDE, and Monaco would paste
 *    its name into the editor.
 *
 * "In progress" is a heartbeat rather than enter/leave counting: browsers fire
 * `dragover` continuously while files are over the page, so when it stops for
 * a moment the drag has ended — dropped, cancelled with Esc, or left the
 * window — and the highlight can never get stuck.
 */
import { useSyncExternalStore } from 'react';

/** Elements that accept dropped files carry this attribute (see FileTree). */
export const DROP_ZONE_ATTR = 'data-file-drop-zone';

const HEARTBEAT_MS = 200;
let active = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setActive(next: boolean) {
  clearTimeout(timer);
  if (next) timer = setTimeout(() => setActive(false), HEARTBEAT_MS);
  if (active === next) return;
  active = next;
  for (const l of listeners) l();
}

const carriesFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
const inDropZone = (e: DragEvent) => e.target instanceof Element && !!e.target.closest(`[${DROP_ZONE_ATTR}]`);

let installed = false;

/** Install the window listeners once (idempotent). */
export function installFileDragGuard() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // Capture phase: runs before Monaco or any other element sees the event.
  window.addEventListener(
    'dragover',
    (e) => {
      if (!carriesFiles(e)) return;
      setActive(true);
      if (!inDropZone(e)) {
        e.preventDefault(); // cancelling with dropEffect "none" forbids the drop here
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        e.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener(
    'drop',
    (e) => {
      if (!carriesFiles(e)) return;
      setActive(false);
      if (!inDropZone(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener('dragend', () => setActive(false), true);
}

/** True while files from the OS are being dragged over the window. */
export function useFileDragActive(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => active,
    () => false,
  );
}
