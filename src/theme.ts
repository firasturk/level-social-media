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

/**
 * `forceLight`: the four-stage workflow is drawn light, as its boards are designed; while it is
 * on, the studio stays light whatever this browser saved, and the toggle does nothing.
 */
export function useTheme(forceLight = false): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "light" : currentTheme(),
  );
  useEffect(() => {
    if (forceLight) {
      applyTheme("light");
      setTheme("light");
      return;
    }
    applyTheme(theme);
  }, [theme, forceLight]);
  const toggle = useCallback(() => {
    if (forceLight) return;
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, [forceLight]);
  return [theme, toggle];
}
