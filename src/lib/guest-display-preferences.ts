import { useCallback, useEffect, useState } from "react";
export const GUEST_DISPLAY_KEY = "neo.guest.display-preferences";
export type GuestDisplayPrefs = {
  appearance: "system" | "light" | "dark";
  reducedMotion: boolean;
  largerText: boolean;
  highContrast: boolean;
};
export const DEFAULT_GUEST_DISPLAY: GuestDisplayPrefs = {
  appearance: "system",
  reducedMotion: false,
  largerText: false,
  highContrast: false,
};
export function parseGuestDisplay(value: unknown): GuestDisplayPrefs {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    appearance: ["system", "light", "dark"].includes(String(v["appearance"]))
      ? (v["appearance"] as GuestDisplayPrefs["appearance"])
      : "system",
    reducedMotion: v["reducedMotion"] === true,
    largerText: v["largerText"] === true,
    highContrast: v["highContrast"] === true,
  };
}
let memory = DEFAULT_GUEST_DISPLAY;
let memoryOnly = false;
function paint(prefs: GuestDisplayPrefs) { if (typeof document !== "undefined") document.documentElement.dataset["guestAppearance"] = prefs.appearance; }
const eventName = "neo:guest-display";
function read(): GuestDisplayPrefs {
  if (typeof window === "undefined") return DEFAULT_GUEST_DISPLAY;
  try {
    const raw = window.localStorage.getItem(GUEST_DISPLAY_KEY);
    return raw === null ? (memoryOnly ? memory : DEFAULT_GUEST_DISPLAY) : parseGuestDisplay(JSON.parse(raw));
  } catch {
    return memory;
  }
}
export function useGuestDisplayPrefs() {
  const [prefs, setPrefs] = useState(DEFAULT_GUEST_DISPLAY);
  useEffect(() => {
    const apply = (next: GuestDisplayPrefs) => { paint(next); setPrefs(next); };
    apply(read());
    const refresh = () => { memoryOnly = false; apply(read()); };
    const sameTab = (event: Event) => apply(parseGuestDisplay((event as CustomEvent).detail));
    window.addEventListener("storage", refresh);
    window.addEventListener(eventName, sameTab);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(eventName, sameTab);
    };
  }, []);
  const setPref = useCallback(
    <K extends keyof GuestDisplayPrefs>(key: K, value: GuestDisplayPrefs[K]) => {
      const next = parseGuestDisplay({ ...read(), [key]: value });
      memory = next;
      paint(next);
      setPrefs(next);
      try {
        window.localStorage.setItem(GUEST_DISPLAY_KEY, JSON.stringify(next));
        memoryOnly = false;
      } catch {
        memoryOnly = true;
        /* This device can still use the preference without persistent storage. */
      }
      window.dispatchEvent(new CustomEvent(eventName, { detail: next }));
    },
    [],
  );
  return { prefs, setPref };
}
