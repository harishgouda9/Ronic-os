import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; fallbackTitle?: string };
type State = { error: Error | null };

export class MiniShellErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Mini computer error boundary caught:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="msh-root msh-center" style={{ padding: 16 }}>
        <div className="msh-welcome-card" style={{ maxWidth: 420 }}>
          <p className="msh-welcome-kicker" style={{ color: "var(--msh-red)" }}>Desktop view alert</p>
          <h2 style={{ margin: "6px 0 8px", fontSize: 18 }}>
            {this.props.fallbackTitle || "Desktop view could not render"}
          </h2>
          <p className="msh-welcome-sub" style={{ fontSize: 12 }}>
            {this.state.error.message || String(this.state.error)}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="msh-taskbar-app on"
              onClick={() => this.setState({ error: null })}
              style={{ padding: "6px 12px", cursor: "pointer" }}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }
}

