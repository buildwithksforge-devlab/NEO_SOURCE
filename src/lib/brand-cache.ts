/**
 * Brand pre-paint cache.
 *
 * The tenant's brand tokens only arrive after the workspace hydrates from the
 * database, so the very first paint used to show the neutral default theme and
 * then snap to the tenant palette. The last confirmed tokens for this browser
 * are cached and re-applied by a tiny inline script in the document head, so
 * the first painted frame is already the tenant's own theme. The cache is only
 * ever a copy of what the database already returned, and it is discarded on
 * sign-out with the rest of the session caches.
 */

export const BRAND_CACHE_KEY = "neo.brand.v1";

/** Launch-frame lockup, kept apart from the workspace theme cache. */
export const LOCKUP_CACHE_KEY = "neo.lockup.v1";

export type CachedBrand = {
  primary: string;
  accent: string;
  secondary: string;
  background: string;
  foreground: string;
  font: string;
  theme: "light" | "dark" | "system";
  favicon?: string | undefined;
  logo?: string | undefined;
  /** Property or workspace name shown in the launch lockup. */
  name?: string | undefined;
};

export function writeBrandCache(brand: CachedBrand) {
  try {
    window.localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(brand));
  } catch {
    /* private mode or quota — the theme simply applies after hydration */
  }
}

export function readBrandCache(): CachedBrand | null {
  try {
    const raw = window.localStorage.getItem(BRAND_CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedBrand) : null;
  } catch {
    return null;
  }
}

export function clearBrandCache() {
  try {
    window.localStorage.removeItem(BRAND_CACHE_KEY);
    window.localStorage.removeItem(LOCKUP_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Warms the browser cache for the tenant logo so the shell never pops in. */
export function preloadBrandImage(url: string | null | undefined) {
  if (!url || typeof document === "undefined") return;
  const existing = document.querySelector<HTMLLinkElement>(`link[data-neo-brand-preload]`);
  if (existing?.href === url) return;
  const link = existing ?? document.createElement("link");
  link.rel = "preload";
  link.as = "image";
  link.href = url;
  link.setAttribute("data-neo-brand-preload", "");
  if (!existing) document.head.appendChild(link);
}

/**
 * Runs before the app renders. Kept dependency-free and defensive: any failure
 * simply leaves the default theme in place.
 */
export const BRAND_BOOT_SCRIPT = `(function(){try{
var r=JSON.parse(localStorage.getItem(${JSON.stringify(BRAND_CACHE_KEY)})||"null");
if(!r)return;
var k=r.theme==="dark"||(r.theme==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark",k);
var d=[];
if(r.primary)d.push("--brand:"+r.primary);
if(r.accent)d.push("--brand-accent:"+r.accent);
if(r.font)d.push("--font-sans:"+r.font);
if(!k){
if(r.secondary)d.push("--secondary:"+r.secondary);
if(r.background)d.push("--background:"+r.background);
if(r.foreground)d.push("--foreground:"+r.foreground);}
if(d.length){var t=document.getElementById("neo-brand-boot")||document.createElement("style");
t.id="neo-brand-boot";t.textContent=":root{"+d.join(";")+"}";
if(!t.parentNode)document.head.appendChild(t);}
if(r.favicon){var l=document.querySelector("link[rel='icon']");if(l)l.href=r.favicon;}
}catch(e){}})();`;



/**
 * Remembers the property lockup (name + logo + hues) used by the launch frame.
 *
 * The guest companion is opened straight into one hotel, so the very first
 * painted frame should already be that hotel's own name and mark rather than
 * the neutral NEØ default. Only values the database already returned are
 * stored, and the existing theme cache is preserved.
 */
export function writeLaunchLockup(lockup: {
  name?: string | null;
  logo?: string | null;
  primary?: string | null;
  secondary?: string | null;
  background?: string | null;
}) {
  let current: CachedBrand | null = null;
  try {
    const raw = window.localStorage.getItem(LOCKUP_CACHE_KEY);
    current = raw ? (JSON.parse(raw) as CachedBrand) : readBrandCache();
  } catch {
    current = null;
  }
  const next: CachedBrand = {
    primary: lockup.primary || current?.primary || "#18C4C8",
    accent: current?.accent || "#D5AF63",
    secondary: lockup.secondary || current?.secondary || "#020A1C",
    background: lockup.background || current?.background || "#020A1C",
    foreground: current?.foreground || "#F7F9FC",
    font: current?.font || "",
    theme: current?.theme || "dark",
    favicon: current?.favicon,
    logo: lockup.logo || current?.logo,
    name: lockup.name || current?.name,
  };
  try {
    window.localStorage.setItem(LOCKUP_CACHE_KEY, JSON.stringify(next));
  } catch {
    /* private mode — the launch frame simply keeps the NEØ mark */
  }
  preloadBrandImage(next.logo);
}
