/**
 * Thermal (80mm) variant of the canonical document.
 *
 * A till roll cannot carry the A4 furniture — no wireframe, no brown bar, no
 * three-column footer — so the design is reduced to its identity: the property
 * name in heavy uppercase, the canonical document number and trace code, the
 * line items, the totals printed verbatim, and the centred "Powered by NEØ".
 * The data contract is identical to the A4 sheet, so a receipt reprinted on A4
 * and on the till shows the same numbers.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useTenant } from "@/lib/tenant";
import { documentTraceCode } from "@/lib/document-trace";
import { useDocumentBranding } from "./DocumentPreview";
import type { DocumentIdentity } from "@/lib/document-identity";

export type ThermalReceiptProps = {
  documentType: string;
  documentNumber?: string | null;
  meta?: { label: string; value: ReactNode }[];
  lines: { description: ReactNode; quantity?: ReactNode; amount: ReactNode }[];
  totals?: { label: string; value: ReactNode }[];
  headline?: { label: string; value: ReactNode };
  notes?: ReactNode;
  brandingSnapshot?: Partial<DocumentIdentity> | null;
  className?: string;
};

export function ThermalReceipt({
  documentType,
  documentNumber,
  meta = [],
  lines,
  totals = [],
  headline,
  notes,
  brandingSnapshot,
  className,
}: ThermalReceiptProps) {
  const live = useDocumentBranding();
  const b: DocumentIdentity = brandingSnapshot ? { ...live, ...brandingSnapshot } : live;
  const { tenant } = useTenant();
  const trace = documentTraceCode({
    organizationId: tenant.organization.id ?? null,
    propertyId: b.propertyId,
    documentType,
    documentNumber,
  });

  return (
    <article
      data-document-thermal
      className={cn("neo-doc-thermal mx-auto bg-white p-2 text-[11px] leading-tight text-black", className)}
    >
      <header className="text-center">
        <p data-document-trading-name className="text-[13px] font-extrabold uppercase">
          {b.tradingName}
        </p>
        {b.propertyAddress ? <p className="opacity-80">{b.propertyAddress}</p> : null}
        {b.propertyPhone ? <p className="opacity-80">{b.propertyPhone}</p> : null}
        {b.taxId ? (
          <p className="opacity-80">
            {b.taxLabel}: {b.taxId}
          </p>
        ) : null}
      </header>

      <p className="mt-2 border-y border-dashed border-black/50 py-1 text-center font-bold uppercase">
        {documentType}
      </p>
      {documentNumber ? <p className="text-center font-semibold">{documentNumber}</p> : null}
      {meta.map((m) => (
        <p key={m.label} className="flex justify-between gap-2">
          <span>{m.label}</span>
          <span>{m.value}</span>
        </p>
      ))}

      <ul className="mt-2 space-y-1 border-t border-dashed border-black/50 pt-2">
        {lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span className="min-w-0 break-words">
              {l.quantity ? `${l.quantity} × ` : ""}
              {l.description}
            </span>
            <span className="shrink-0 tabular-nums">{l.amount}</span>
          </li>
        ))}
      </ul>

      <div className="mt-2 space-y-0.5 border-t border-dashed border-black/50 pt-2">
        {totals.map((t) => (
          <p key={t.label} className="flex justify-between gap-2">
            <span>{t.label}</span>
            <span className="tabular-nums">{t.value}</span>
          </p>
        ))}
        {headline ? (
          <p
            data-document-total-band
            className="flex justify-between gap-2 border-t border-black/60 pt-1 text-[12px] font-extrabold uppercase"
          >
            <span>{headline.label}</span>
            <span className="tabular-nums">{headline.value}</span>
          </p>
        ) : null}
      </div>

      {notes ? <div className="mt-2 text-center opacity-80">{notes}</div> : null}
      {trace ? (
        <p data-document-trace className="mt-2 text-center font-mono text-[8px] opacity-70">
          {trace}
        </p>
      ) : null}
      <p className="mt-2 text-center text-[9px] tracking-[0.08em] opacity-70">Powered by NEØ</p>
      <p className="text-center text-[8px] opacity-60">Built by AI, Data &amp; Marketing by Wambui</p>
    </article>
  );
}
