import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/** Shows a recovery screen instead of a blank page if a screen fails unexpectedly. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('INVPORTIQ screen error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6" role="alert">
        <div className="max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
          <AlertTriangle className="mx-auto mb-3 size-10 text-amber-600" />
          <h1 className="text-lg font-semibold text-ink">Something went wrong on this screen</h1>
          <p className="mt-2 text-sm text-muted">No data was lost. Reload the page to continue. If it keeps happening, tell the administrator.</p>
          <button
            type="button"
            onClick={() => window.location.assign('/')}
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-800 px-5 text-sm font-semibold text-white hover:bg-brand-900"
          >
            <RotateCcw className="size-4" /> Reload
          </button>
        </div>
      </div>
    );
  }
}
