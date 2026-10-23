import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import "./styles.css";
import "./editor-dark.css";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { markLoadedCleanly } from "./lib/lazy";
import { initTheme } from "./theme";

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
