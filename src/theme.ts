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

const RESET_KEY = "mfs-theme-light-once";

/**
 * `lightFirst`: the four-stage workflow is drawn light, as its boards are designed. The first time
 * it is on in this browser the saved dark choice is set back to light, once; the toggle then works
 * as before and whatever is chosen stays.
 */
export function useTheme(lightFirst = false): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "light" : currentTheme(),
  );
  useEffect(() => {
    if (!lightFirst) return;
    try {
      if (localStorage.getItem(RESET_KEY) === "1") return;
      localStorage.setItem(RESET_KEY, "1");
    } catch {
      return;
    }
    setTheme("light");
  }, [lightFirst]);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
