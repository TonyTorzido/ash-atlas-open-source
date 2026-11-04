import { Component, type ErrorInfo, type ReactNode } from "react";
import { bugReportDiagnostics } from "../diagnostics/bugReportDiagnostics.js";

type State = { error: Error | null; generation: number };

export class StartupErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    bugReportDiagnostics.recordError({
      category: "react_error_boundary",
      name: error.name,
      message: error.message,
      stack: error.stack ?? info.componentStack ?? null,
      component: "startup-error-boundary"
    });
    console.error("Ash Atlas render failure", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-startup" role="alert">
          <strong>Ash Atlas could not finish loading</strong>
          <span>{import.meta.env.DEV ? this.state.error.message : "An unexpected rendering error occurred."}</span>
          <button type="button" onClick={() => this.setState((state) => ({ error: null, generation: state.generation + 1 }))}>Try again</button>
        </main>
      );
    }
    return <div key={this.state.generation}>{this.props.children}</div>;
  }
}
