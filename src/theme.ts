import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "mfs-theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

/** Light is the studio default (the designs are light); the header toggle overrides it per browser. */
const DEFAULT_THEME: Theme = "light";

export function currentTheme(): Theme {
  return stored() ?? DEFAULT_THEME;
}

export function applyTheme(theme: Theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* private mode */
    }
  }
}

/** Apply the saved theme (or the light default) before first paint. */
export function initTheme() {
  applyTheme(currentTheme(), false);
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "light" : currentTheme(),
  );
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
