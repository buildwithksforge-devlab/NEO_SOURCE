/**
 * Brand artwork normalisation.
 *
 * Logos, favicons and splash images are persisted inside the organisation's
 * branding record (`organization_settings.brand`), so the encoded artwork has
 * to stay small enough to survive a normal database write and a normal page
 * hydration. A 4 MB camera-resolution PNG encoded as base64 grew past 5 MB and
 * the workspace write silently failed, which is what made an uploaded logo
 * "disappear" after a refresh.
 *
 * Every upload is therefore downscaled to a sensible on-screen size before it
 * is stored. Nothing about where branding lives changed — only the size of what
 * is written.
 */

/** Longest edge kept for stored brand artwork. */
export const BRAND_IMAGE_MAX_EDGE = 640;

/** Hard ceiling for the encoded string written to the branding record. */
export const BRAND_IMAGE_MAX_ENCODED_BYTES = 400_000;

export function encodedByteLength(dataUrl: string | null | undefined): number {
  if (!dataUrl) return 0;
  return dataUrl.length;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image could not be decoded."));
    img.src = src;
  });
}

/**
 * Returns a bounded PNG/WebP data URL for the uploaded file. SVG is kept as-is
 * (already small and resolution independent). If the browser cannot rasterise
 * the file, the original data URL is returned when it is already small enough.
 */
export async function normaliseBrandImage(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  if (file.type === "image/svg+xml") {
    if (encodedByteLength(original) <= BRAND_IMAGE_MAX_ENCODED_BYTES) return original;
    throw new Error("That vector logo is too large — export a simplified version under 300 KB.");
  }

  let image: HTMLImageElement;
  try {
    image = await loadImage(original);
  } catch {
    if (encodedByteLength(original) <= BRAND_IMAGE_MAX_ENCODED_BYTES) return original;
    throw new Error("That image could not be processed — use a PNG, JPEG or WebP file.");
  }

  const scale = Math.min(1, BRAND_IMAGE_MAX_EDGE / Math.max(image.width, image.height || 1));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    if (encodedByteLength(original) <= BRAND_IMAGE_MAX_ENCODED_BYTES) return original;
    throw new Error("That image could not be processed in this browser.");
  }
  ctx.drawImage(image, 0, 0, width, height);

  // Transparency matters for a logo, so PNG first; fall back to progressively
  // stronger WebP compression only when PNG is still too heavy.
  const candidates = [
    canvas.toDataURL("image/png"),
    canvas.toDataURL("image/webp", 0.9),
    canvas.toDataURL("image/webp", 0.75),
    canvas.toDataURL("image/webp", 0.6),
  ];
  const fitted = candidates.find((c) => encodedByteLength(c) <= BRAND_IMAGE_MAX_ENCODED_BYTES);
  if (fitted) return fitted;
  throw new Error("That image is too detailed to store — upload a simpler logo file.");
}

/** Picks the artwork that suits the resolved appearance, with a fallback. */
export function pickThemedLogo(
  logoLight: string | null | undefined,
  logoDark: string | null | undefined,
  dark: boolean,
): string | null {
  const preferred = dark ? logoDark : logoLight;
  return preferred || (dark ? logoLight : logoDark) || null;
}
