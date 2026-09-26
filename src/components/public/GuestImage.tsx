/**
 * Guest-facing image with reserved space.
 *
 * Every guest image occupies its final box before the bytes arrive: the
 * wrapper owns the aspect ratio, the `<img>` carries intrinsic width and
 * height, and the placeholder shown while there is no artwork is exactly the
 * same size as the photograph that may replace it. Nothing on the page can
 * move because an image finished loading.
 */
import type { ReactNode } from "react";
import { GUEST_CARD_WIDTHS, responsiveSrcSet } from "@/lib/responsive-image";
import { brandFallback } from "@/lib/public-apps";

export function GuestImage({
  src,
  alt,
  width,
  height,
  sizes,
  widths = GUEST_CARD_WIDTHS,
  priority = false,
  className = "",
  imageClassName = "",
  rounded = "rounded-xl",
  fallback,
}: {
  src?: string | null;
  /** Empty string marks the image as decorative. */
  alt: string;
  width: number;
  height: number;
  sizes?: string;
  widths?: readonly number[];
  /** True only for a genuine above-the-fold LCP image. */
  priority?: boolean;
  className?: string;
  imageClassName?: string;
  rounded?: string;
  /** Shown, at the identical size, when the property published no artwork. */
  fallback?: ReactNode;
}) {
  const srcSet = responsiveSrcSet(src, widths);
  return (
    <span
      className={`relative block shrink-0 overflow-hidden bg-black/5 ${rounded} ${className}`}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      {src ? (
        <img
          src={src}
          {...(srcSet ? { srcSet, sizes: sizes ?? `${width}px` } : {})}
          alt={alt}
          width={width}
          height={height}
          loading={priority ? "eager" : "lazy"}
          decoding={priority ? "sync" : "async"}
          {...(priority ? { fetchPriority: "high" as const } : {})}
          className={`absolute inset-0 size-full object-cover ${imageClassName}`}
        />
      ) : (
        <span
          className="absolute inset-0 flex items-center justify-center"
          style={{ color: brandFallback.steel }}
          aria-hidden
        >
          {fallback}
        </span>
      )}
    </span>
  );
}
