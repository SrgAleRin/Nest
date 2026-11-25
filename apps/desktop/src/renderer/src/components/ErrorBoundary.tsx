import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FatalScreen } from './Boot';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * A renderer crash otherwise leaves a blank window with no way back. Sessions
 * live in the main process, so reloading the window reconnects to them.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Nest interface crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <FatalScreen
        title="The interface hit an unexpected error"
        message={error.message}
        details={error.stack}
        hint="Running sessions stay alive until Nest exits. Reloading the window reconnects to them."
        actionLabel="Reload Nest"
        onAction={() => window.location.reload()}
      />
    );
  }
}
