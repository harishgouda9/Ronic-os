import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };

type State = { error: Error | null };

// A crash in any screen used to white-screen the whole desktop window with
// no way back. This boundary keeps the shell alive, names the error, and
// offers the same recovery path as Ctrl+Shift+R.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Ronic OS screen crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app">
        <div className="center-card stack">
          <h1 className="title">A screen stopped working</h1>
          <p className="muted">{this.state.error.message || String(this.state.error)}</p>
          <p className="faint">The workspace itself is fine. Reload to come back to chat.</p>
          <div className="row-actions">
            <button className="btn" onClick={() => window.location.reload()}>Reload Ronic OS</button>
            <button
              className="btn ghost"
              onClick={() => {
                try {
                  sessionStorage.removeItem("ronic.screen");
                } catch {
                  /* fall back to chat regardless */
                }
                window.location.reload();
              }}
            >
              Reload on the chat screen
            </button>
          </div>
        </div>
      </div>
    );
  }
}
