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
      className={cn(
        "neo-doc-thermal mx-auto bg-white px-2 py-3 text-[11px] leading-[1.35] text-black",
        className,
      )}
    >
      <header className="text-center">
        <p
          data-document-trading-name
          className="text-[14px] font-black uppercase leading-tight tracking-[0.04em]"
        >
          {b.tradingName}
        </p>
        {b.propertyAddress ? <p className="mt-0.5 text-[10px]">{b.propertyAddress}</p> : null}
        {b.propertyPhone ? <p className="text-[10px]">{b.propertyPhone}</p> : null}
        {b.taxId ? (
          <p className="text-[10px]">
            {b.taxLabel}: {b.taxId}
          </p>
        ) : null}
      </header>

      <div className="my-2 border-y border-dashed border-black py-1.5 text-center">
        <p className="font-extrabold uppercase tracking-[0.08em]">
          {documentType === "pos_receipt" ? "RECEIPT" : documentType.replace(/_/g, " ")}
        </p>
        {documentNumber ? (
          <p className="mt-0.5 font-mono text-[10px] font-semibold">{documentNumber}</p>
        ) : null}
      </div>
      {meta.length ? (
        <div className="space-y-0.5">
          {meta.map((m) => (
            <p key={m.label} className="flex items-start justify-between gap-3">
              <span className="shrink-0 text-[10px]">{m.label}</span>
              <span className="min-w-0 text-right text-[10px] font-medium">{m.value}</span>
            </p>
          ))}
        </div>
      ) : null}

      <div className="mt-2 border-t border-dashed border-black pt-1.5">
        <div className="mb-1 flex justify-between gap-2 border-b border-black pb-1 text-[9px] font-bold uppercase">
          <span>Item</span>
          <span>Amount</span>
        </div>

        <ul className="space-y-1.5">
          {lines.map((l, i) => (
            <li key={i} className="flex items-start justify-between gap-2">
              <span className="min-w-0 flex-1 break-words pr-1">
                {l.quantity ? (
                  <span className="mr-1 font-semibold">{l.quantity} ×</span>
                ) : null}
                {l.description}
              </span>
              <span className="shrink-0 font-medium tabular-nums">{l.amount}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-2 space-y-0.5 border-t border-dashed border-black pt-1.5">
        {totals.map((t) => (
          <p key={t.label} className="flex justify-between gap-3">
            <span>{t.label}</span>
            <span className="font-medium tabular-nums">{t.value}</span>
          </p>
        ))}
        {headline ? (
          <p
            data-document-total-band
            className="mt-1 flex justify-between gap-3 border-y-2 border-black py-1.5 text-[13px] font-black uppercase"
          >
            <span>{headline.label}</span>
            <span className="tabular-nums">{headline.value}</span>
          </p>
        ) : null}
      </div>

      {notes ? <div className="mt-2 text-center text-[10px]">{notes}</div> : null}

      <div className="mt-3 border-t border-dashed border-black pt-2 text-center">
        <p className="font-semibold">Thank you for your business.</p>

        {trace ? (
          <p data-document-trace className="mt-2 break-all font-mono text-[7px]">
            {trace}
          </p>
        ) : null}

        <p className="mt-2 text-[8px] tracking-[0.08em]">Powered by NEØ</p>
        <p className="text-[7px]">Built by AI, Data &amp; Marketing by Wambui</p>
      </div>
    </article>
  );
}
