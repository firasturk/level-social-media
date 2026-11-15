import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, toast } from "sonner";
import "./styles.css";
import "./editor-dark.css";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { markLoadedCleanly } from "./lib/lazy";
import { initTheme } from "./theme";
import { installGlobalHandlers, wrapToasts } from "./lib/errorLog";

// The error log, before anything renders: every error or warning toast the user is shown is also
// written down (no call site changes), and so is anything that breaks uncaught.
wrapToasts(toast);
installGlobalHandlers();

initTheme();
markLoadedCleanly();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Toaster richColors position="top-center" />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
