/**
 * Responsive source generation for hotel-published media.
 *
 * Hotels publish their own photographs, so NEØ never re-hosts or re-encodes
 * them. What it can do honestly is ask the origin for a correctly sized
 * rendition when the origin supports it, so a phone is not made to download a
 * desktop-resolution original. When an origin offers no such control the
 * original is used unchanged — a wrong `srcset` would be worse than none.
 */

export const GUEST_THUMB_WIDTHS = [64, 128, 192] as const;
export const GUEST_CARD_WIDTHS = [320, 480, 640] as const;
export const GUEST_HERO_WIDTHS = [480, 768, 1024, 1440, 1920] as const;

/** Storage renditions the backend can generate on demand. */
function supabaseRendition(url: string, width: number): string | null {
  const marker = "/storage/v1/object/public/";
  if (!url.includes(marker)) return null;
  const rendered = url.replace(marker, "/storage/v1/render/image/public/");
  const join = rendered.includes("?") ? "&" : "?";
  return `${rendered}${join}width=${width}&quality=70&resize=cover`;
}

/** Origins that accept an explicit width query parameter. */
function queryRendition(url: string, width: number): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.endsWith("unsplash.com")) {
      parsed.searchParams.set("w", String(width));
      parsed.searchParams.set("q", "70");
      parsed.searchParams.set("auto", "format");
      return parsed.toString();
    }
    if (host.endsWith("cloudinary.com") || host.endsWith("imgix.net")) {
      parsed.searchParams.set("w", String(width));
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a `srcset` for the widths the origin can genuinely serve, or null
 * when it cannot serve any — the caller then renders the original alone.
 */
export function responsiveSrcSet(
  src: string | null | undefined,
  widths: readonly number[],
): string | null {
  if (!src) return null;
  if (src.startsWith("data:") || src.startsWith("blob:")) return null;
  const entries: string[] = [];
  for (const width of widths) {
    const candidate = supabaseRendition(src, width) ?? queryRendition(src, width);
    if (!candidate) return null;
    entries.push(`${candidate} ${width}w`);
  }
  return entries.join(", ");
}

/** The best single source for the given display width, when supported. */
export function sizedSource(src: string | null | undefined, width: number): string | null {
  if (!src) return null;
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  return supabaseRendition(src, width) ?? queryRendition(src, width) ?? src;
}
