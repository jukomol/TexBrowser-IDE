/**
 * Error boundaries: a rendering error anywhere must never leave the user with a
 * blank page (React unmounts the whole tree on an uncaught render error). The
 * app-level boundary shows a recovery card with the error; the dialog boundary
 * just closes the broken dialog and reports it in a toast.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Copy, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from './ui';

interface Props {
  children: ReactNode;
  /** Where the boundary sits, shown in the report ("app", "dialog", …). */
  area: string;
  /** Render nothing on error and call this instead of showing the recovery card. */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.area}] render error`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? '' });
    this.props.onError?.(error);
  }

  reset = () => this.setState({ error: null, stack: '' });

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    if (this.props.onError) {
      // Recover on the next render (e.g. the next dialog that opens).
      queueMicrotask(this.reset);
      return null;
    }
    const details = `${error.name}: ${error.message}\n${error.stack ?? ''}\n\nComponent stack:${stack}\n\n${navigator.userAgent}`;
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6">
        <div className="w-full max-w-lg rounded-xl border border-danger/40 bg-panel p-5 shadow-pop">
          <div className="flex items-center gap-2 text-sm font-semibold text-danger">
            <AlertTriangle className="size-4" /> Something went wrong in the {this.props.area}
          </div>
          <p className="mt-2 text-[13px] text-fg">
            Your files are safe — they are saved in this browser. You can try again, or reload the page.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bg/60 p-3 font-mono text-[11px] text-muted">
            {error.name}: {error.message}
          </pre>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" icon={<RotateCcw className="size-3.5" />} onClick={this.reset}>Try again</Button>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => location.reload()}>Reload page</Button>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard?.writeText(details)}>Copy error details</Button>
          </div>
        </div>
      </div>
    );
  }
}
