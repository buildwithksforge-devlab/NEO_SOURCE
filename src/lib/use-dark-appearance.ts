import { useEffect, useState } from "react";

/**
 * Resolves whether the shell is currently painting in dark appearance.
 * Kept separate from the tenant provider so presentation code (logo choice,
 * chart palettes) can follow the appearance without owning theme state.
 */
export function useIsDarkAppearance(theme: "light" | "dark" | "system"): boolean {
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return theme === "dark" || (theme === "system" && systemDark);
}
