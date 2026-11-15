import { Component, type ErrorInfo, type ReactNode } from "react";
import { isStaleChunkError } from "./lib/lazy";
import { reportError } from "./lib/errorLog";

/** Keeps a crash in one screen from blanking the whole page: shows what happened and a reload. */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui] render failed", error, info.componentStack);
    // The error log: the screen that failed to render, with the components nearest the failure.
    const where = (info.componentStack ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("\n")
      .split(window.location.origin)
      .join("");
    reportError("crash", error?.message || "A screen failed to render.", `${isStaleChunkError(error) ? "Shown as: The app was updated\n" : ""}${where}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isStaleChunkError(error);
    return (
      <div className="crash-screen" role="alert">
        <h1>{stale ? "The app was updated" : "Something went wrong on this screen"}</h1>
        <p>
          {stale
            ? "A newer version was published while this page was open. Reload to continue; your batches and settings are saved."
            : "Reload the page to continue. Your batches and settings are saved on the server."}
        </p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        {!stale && <pre>{error.message}</pre>}
      </div>
    );
  }
}
