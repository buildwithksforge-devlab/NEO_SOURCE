/**
 * Print-safe vector furniture for the canonical NEØ document.
 *
 * Everything here is SVG, never a bitmap: the reference drawing and the footer
 * icons must stay crisp at A4 print resolution and must not sit behind the
 * document text as a flattened background.
 */
import { DOCUMENT_INK, wireframeSegments } from "@/lib/document-artwork";

/** The geometric wireframe globe, cropped into the upper-right corner. */
export function WireframeCorner({ className }: { className?: string }) {
  const segments = wireframeSegments({ x: 0, y: -34, width: 190, height: 190 });
  return (
    <svg
      viewBox="0 0 190 130"
      role="presentation"
      aria-hidden="true"
      data-document-artwork="wireframe"
      className={className}
      preserveAspectRatio="xMaxYMin meet"
    >
      <g stroke={DOCUMENT_INK} strokeWidth="0.5" fill="none" vectorEffect="non-scaling-stroke">
        {segments.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
        ))}
      </g>
    </svg>
  );
}

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: DOCUMENT_INK,
  "aria-hidden": true as const,
};

export function PhoneGlyph() {
  return (
    <svg {...ICON_PROPS} data-document-icon="phone">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <rect x="8.6" y="4" width="6.8" height="14" fill="#fff" />
    </svg>
  );
}

export function MailGlyph() {
  return (
    <svg {...ICON_PROPS} data-document-icon="mail">
      <path d="M2 5h20v14H2z" />
      <path d="M2 5l10 7 10-7" stroke="#fff" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

export function PinGlyph() {
  return (
    <svg {...ICON_PROPS} data-document-icon="address">
      <path d="M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z" />
      <circle cx="12" cy="9" r="2.6" fill="#fff" />
    </svg>
  );
}
