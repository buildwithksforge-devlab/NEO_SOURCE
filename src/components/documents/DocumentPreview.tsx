/**
 * Canonical NEØ printed-document template.
 *
 * One shell renders every printable output — receipt, invoice, quotation,
 * guest folio, pro-forma, credit note, LPO, RFQ, GRN, remittance, event
 * quotation/invoice — in the approved house design: white A4 portrait, logo
 * and heavy uppercase property name upper-left, the geometric wireframe
 * cropped into the upper-right corner, right-aligned canonical document
 * metadata, a warm-brown block before the large document title, a wide item
 * table with fine rules, totals in the brown bar, notes lower-left, and three
 * icon-led contact areas above the centred "Powered by NEØ" signature.
 *
 * The template is presentation only. Money, tax, document numbers and totals
 * arrive already computed from the canonical backend and are printed verbatim;
 * nothing here recalculates financial truth. Branding is resolved from the
 * document's owning property (or the branding snapshot the caller passes for
 * an already-issued document), never from a demo or seed brand.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding";
import { useTenant } from "@/lib/tenant";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { resolveDocumentIdentity, type DocumentIdentity } from "@/lib/document-identity";
import { documentTraceCode } from "@/lib/document-trace";
import neoSymbol from "@/assets/neo-symbol.png";
import { MailGlyph, PhoneGlyph, PinGlyph, WireframeCorner } from "./DocumentArtwork";

export type DocumentMetaEntry = { label: string; value: ReactNode };

export type DocumentColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
  className?: string;
};

export type DocumentRow = Record<string, ReactNode>;

export type DocumentPartyBlock = { title: string; lines: ReactNode[] };

export type DocumentPreviewProps = {
  documentType: string;
  documentNumber?: string | null;
  /** Number label used in the metadata block, e.g. "Receipt no". */
  numberLabel?: string;
  meta?: DocumentMetaEntry[];
  addressedTo?: DocumentPartyBlock;
  /** Optional second party block printed on the right (Ship to, Property, Supplier…). */
  secondParty?: DocumentPartyBlock;
  columns: DocumentColumn[];
  rows: DocumentRow[];
  totals?: DocumentMetaEntry[];
  headline?: { label: string; value: ReactNode };
  notes?: ReactNode;
  /** Label above the notes area. The reference reads "Payment Information:". */
  notesLabel?: string;
  /**
   * Branding captured when the document was issued. Supplying it freezes the
   * printed identity so later property renames never rewrite history.
   */
  brandingSnapshot?: Partial<DocumentIdentity> | null;
  /** Line items per A4 sheet before the document paginates. */
  rowsPerPage?: number;
  emptyMessage?: string;
  className?: string;
};

const ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.25, 1.5, 2];

/**
 * Live document identity for the ACTIVE property.
 *
 * The active property's own logo/name/contact win; anything it leaves blank
 * falls back to the organisation. When no property is active (or the id does
 * not resolve) the document degrades to organisation identity — it never
 * borrows another property's mark.
 */
export function useDocumentBranding() {
  const { branding, brand } = useBranding();
  const { tenant } = useTenant();
  const { branchId } = useActivePropertyFilter();

  return useMemo(
    () =>
      resolveDocumentIdentity({
        organization: tenant.organization,
        contact: tenant.contact,
        regional: tenant.regional,
        brand,
        organisationLogo: branding.logo,
        property: branchId ? (tenant.branches.find((b) => b.id === branchId) ?? null) : null,
      }),
    [branding.logo, brand, tenant, branchId],
  );
}

/** Initials used when a tenant has configured no logo. Never a demo brand. */
export function brandInitials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(" ")
    .filter(Boolean);
  if (parts.length === 0) return "";
  return parts
    .slice(0, 3)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function DocumentPreview({
  documentType,
  documentNumber,
  numberLabel,
  meta = [],
  addressedTo,
  secondParty,
  columns,
  rows,
  totals = [],
  headline,
  notes,
  notesLabel = "Payment Information:",
  brandingSnapshot,
  rowsPerPage = 14,
  emptyMessage = "No line items on this document yet.",
  className,
}: DocumentPreviewProps) {
  const live = useDocumentBranding();
  const b: DocumentIdentity = brandingSnapshot ? { ...live, ...brandingSnapshot } : live;
  const { tenant } = useTenant();
  const [zoomIndex, setZoomIndex] = useState(3);
  const [fullscreen, setFullscreen] = useState(false);
  const zoom = ZOOM_STEPS[zoomIndex] ?? 1;

  const trace = documentTraceCode({
    organizationId: tenant.organization.id ?? null,
    propertyId: b.propertyId,
    documentType,
    documentNumber,
  });

  const pages = useMemo(() => {
    if (rows.length === 0) return [[] as DocumentRow[]];
    const chunks: DocumentRow[][] = [];
    for (let i = 0; i < rows.length; i += rowsPerPage) chunks.push(rows.slice(i, i + rowsPerPage));
    return chunks;
  }, [rows, rowsPerPage]);

  const initials = brandInitials(b.tradingName);
  const contacts: { key: string; label: string; value: string; glyph: ReactNode }[] = [
    { key: "phone", label: "Phone", value: b.propertyPhone, glyph: <PhoneGlyph /> },
    { key: "mail", label: "Mail", value: b.propertyEmail, glyph: <MailGlyph /> },
    { key: "address", label: "Address", value: b.propertyAddress, glyph: <PinGlyph /> },
  ];

  return (
    <div
      className={cn(
        "neo-doc-frame overflow-hidden rounded-2xl border border-border/70 bg-muted/40",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0 bg-background",
        className,
      )}
      data-document-preview
    >
      <div
        data-print-hide
        className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-background/80 px-3 py-2 backdrop-blur"
      >
        <p className="neo-line-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {documentType}
          {documentNumber ? ` · ${documentNumber}` : ""}
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            className="size-11"
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
          >
            <Minus className="size-4" />
          </Button>
          <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            className="size-11"
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Fit to width"
            className="size-11"
            onClick={() => setZoomIndex(3)}
          >
            <RotateCcw className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            className="size-11"
            onClick={() => setFullscreen((v) => !v)}
          >
            {fullscreen ? <X className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        </div>
      </div>

      <div
        className={cn(
          "neo-doc-scroll overflow-auto p-3 sm:p-6",
          fullscreen ? "h-[calc(100dvh-3.25rem)]" : "max-h-[70vh]",
        )}
        style={{ touchAction: "pan-x pan-y pinch-zoom", WebkitOverflowScrolling: "touch" }}
      >
        <div
          className="mx-auto flex w-fit flex-col gap-6 origin-top"
          style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
        >
          {pages.map((pageRows, pageIndex) => {
            const lastPage = pageIndex === pages.length - 1;
            const firstIndex = pageIndex * rowsPerPage;
            return (
              <article
                key={pageIndex}
                className="neo-doc-sheet relative"
                data-document-page={pageIndex + 1}
              >
                <WireframeCorner className="neo-doc-wireframe" />

                <header className="relative flex items-start gap-4">
                  {b.logo ? (
                    <img
                      src={b.logo}
                      alt={`${b.tradingName} logo`}
                      data-document-logo
                      className="h-14 w-auto max-w-[42mm] object-contain"
                    />
                  ) : (
                    <span
                      data-document-logo
                      data-document-logo-placeholder
                      className="flex h-14 w-14 shrink-0 items-center justify-center border border-black/25 text-sm font-bold tracking-[0.12em] text-black"
                    >
                      {initials}
                    </span>
                  )}
                  <div className="min-w-0">
                    <h1
                      data-document-trading-name
                      className="max-w-[95mm] text-[22px] font-extrabold uppercase leading-[1.05] tracking-[0.01em] text-black"
                    >
                      {b.tradingName}
                    </h1>
                    {/* The registered entity and tax identity are legal
                        requirements on a printed document, so they follow the
                        trading name rather than living only in the footer. */}
                    <p data-document-legal-name className="mt-1 text-[10px] text-black/70">
                      {b.legalName}
                    </p>
                    {b.taxId ? (
                      <p data-document-tax-id className="text-[10px] text-black/70">
                        {b.taxLabel}: {b.taxId}
                      </p>
                    ) : null}
                  </div>
                </header>

                <div className="relative mt-10 flex items-start justify-between gap-6">
                  <div className="min-w-0">
                    <div
                      data-document-title-block
                      className="h-[7mm] w-[30mm]"
                      style={{ background: "var(--doc-brown)" }}
                    />
                    <h2
                      data-document-title
                      className="-mt-[3mm] ml-[14mm] text-[30px] font-extrabold uppercase leading-none tracking-[0.01em] text-black"
                    >
                      {documentType}
                    </h2>
                  </div>
                  <div className="shrink-0 text-right text-[11px] leading-[1.5] text-black">
                    {documentNumber ? (
                      <p className="text-[13px] font-bold">
                        {numberLabel ?? `${documentType} no`} : {documentNumber}
                      </p>
                    ) : null}
                    <dl>
                      {meta.map((m) => (
                        <div key={m.label} className="flex justify-end gap-2">
                          <dt>{m.label}:</dt>
                          <dd className="font-medium">{m.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {trace ? (
                      <p
                        data-document-trace
                        className="mt-1 font-mono text-[8px] tracking-[0.06em] text-black/55"
                      >
                        {trace}
                      </p>
                    ) : null}
                  </div>
                </div>

                {pageIndex === 0 && (addressedTo || secondParty) ? (
                  <section className="mt-8 flex items-start justify-between gap-8" data-print-keep>
                    {addressedTo ? (
                      <div className="min-w-0 max-w-[85mm]">
                        <p className="text-[11px] font-bold uppercase tracking-[0.04em] text-black">
                          {addressedTo.title}
                        </p>
                        <div className="mt-1 space-y-0.5 break-words text-[13px] text-black">
                          {addressedTo.lines.map((line, i) => (
                            <p key={i} className={i === 0 ? "font-bold uppercase" : "opacity-80"}>
                              {line}
                            </p>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div />
                    )}
                    {secondParty ? (
                      <div className="min-w-0 max-w-[85mm] text-right">
                        <p className="text-[11px] font-bold uppercase tracking-[0.04em] text-black">
                          {secondParty.title}
                        </p>
                        <div className="mt-1 space-y-0.5 break-words text-[13px] text-black">
                          {secondParty.lines.map((line, i) => (
                            <p key={i} className={i === 0 ? "font-bold uppercase" : "opacity-80"}>
                              {line}
                            </p>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </section>
                ) : null}

                <table className="mt-10 w-full border-collapse text-[12px] text-black">
                  <thead>
                    <tr style={{ borderBottom: "1.5px solid #4a6fa5" }}>
                      <th className="w-[14mm] py-2 text-left font-bold uppercase tracking-[0.04em]">
                        No.
                      </th>
                      {columns.map((c) => (
                        <th
                          key={c.key}
                          className={cn(
                            "py-2 font-bold uppercase tracking-[0.04em]",
                            c.align === "right" ? "text-right" : "text-left",
                            c.className,
                          )}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 ? (
                      <tr>
                        <td colSpan={columns.length + 1} className="py-8 text-center opacity-60">
                          {emptyMessage}
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((r, i) => (
                        <tr key={i} className="neo-doc-row">
                          <td className="py-2 align-top tabular-nums">{firstIndex + i + 1}</td>
                          {columns.map((c) => (
                            <td
                              key={c.key}
                              className={cn(
                                "py-2 align-top",
                                c.align === "right" ? "text-right tabular-nums" : "text-left",
                                c.className,
                              )}
                            >
                              {r[c.key] ?? "—"}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>

                {lastPage ? (
                  <section className="mt-6 flex flex-col items-end gap-3" data-print-keep>
                    <dl className="w-full max-w-[85mm] space-y-1.5 text-[12px] text-black">
                      {totals.map((t) => (
                        <div key={t.label} className="flex justify-between gap-6">
                          <dt className="font-bold">{t.label}</dt>
                          <dd className="tabular-nums">{t.value}</dd>
                        </div>
                      ))}
                    </dl>
                    {headline ? (
                      <div
                        data-document-total-band
                        className="flex w-full max-w-[85mm] items-center justify-between gap-6 px-3 py-2 text-[13px] font-bold text-white"
                        style={{ background: "var(--doc-brown)" }}
                      >
                        <span className="uppercase tracking-[0.04em]">{headline.label}</span>
                        <span className="tabular-nums">{headline.value}</span>
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {lastPage && notes ? (
                  <section
                    className="mt-4 max-w-[95mm] text-[11px] leading-relaxed text-black"
                    data-print-keep
                  >
                    <p className="font-bold">{notesLabel}</p>
                    <div className="mt-1 opacity-80">{notes}</div>
                  </section>
                ) : null}

                {lastPage ? (
                  <footer className="mt-12" data-print-keep>
                    <div className="h-px w-full" style={{ background: "var(--doc-brown)" }} />
                    <div className="mt-4 grid grid-cols-3 gap-4 text-[11px] text-black">
                      {contacts.map((c) => (
                        <div key={c.key} className="flex items-start gap-2">
                          <span className="mt-[2px] shrink-0">{c.glyph}</span>
                          <span className="min-w-0">
                            <span className="block font-bold">{c.label}</span>
                            <span className="block break-words opacity-80">
                              {c.value || "Not configured"}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-8 text-center text-[9px] tracking-[0.08em] text-black/60">
                      Powered by NEØ
                    </p>
                    <p className="text-center text-[8px] text-black/50">
                      Built by AI, Data &amp; Marketing by Wambui
                    </p>
                  </footer>
                ) : null}

                <p
                  data-document-page-number
                  className="mt-3 text-right text-[9px] text-black/50"
                >
                  Page {pageIndex + 1} of {pages.length}
                </p>

                {/* The permanent house mark, set into the existing lower-right
                    margin so it signs the sheet without displacing anything. */}
                <img
                  src={neoSymbol}
                  alt="NEØ"
                  data-document-house-mark
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-[8mm] right-[10mm] h-[9mm] w-[9mm] object-contain"
                />
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
