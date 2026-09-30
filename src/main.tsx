import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './index.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { toast } from './state/store';

// Errors outside React rendering (event handlers, promises) must not fail silently.
// Benign browser noise and cancelled Monaco/pdf.js operations are ignored.
const IGNORED = /ResizeObserver loop|^Canceled$|AbortError|RenderingCancelled/;
let lastReport = 0;
function report(err: unknown) {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (IGNORED.test(msg) || (err instanceof Error && IGNORED.test(err.name))) return;
  console.error('[TexBrowser] uncaught', err);
  if (Date.now() - lastReport < 3000) return; // one toast per burst
  lastReport = Date.now();
  toast({ kind: 'error', title: 'Unexpected error', message: msg.slice(0, 300) });
}
window.addEventListener('error', (e) => report(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report(e.reason));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary area="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
