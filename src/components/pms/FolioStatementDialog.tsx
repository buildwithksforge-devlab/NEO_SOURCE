/**
 * Folio statement document — the premium preview of one exact folio.
 *
 * The body is shared between the folio detail page's "Statement preview" tab
 * and the overlay opened from the folio list, so both surfaces print the same
 * document from the same canonical record. Branding comes from
 * `DocumentPreview`, which resolves the property identity itself.
 */
import { Receipt } from "lucide-react";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { SendToPrinterButton } from "@/components/common/SendToPrinterButton";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deriveFolioIdentity } from "@/lib/folio-identity";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { formatDateTime, money, titleCase } from "@/lib/pms";
import { useFolio, useFolioLines } from "@/lib/frontdesk-ops";
import { useFolioProjection } from "@/lib/payment-lifecycle";

type LineRow = {
  id: string;
  description: string;
  category: string;
  quantity: number;
  gross_amount: number;
  posting_date: string;
};

export function FolioStatementBody({ folioId }: { folioId: string }) {
  const folio = useFolio(folioId);
  const lines = useFolioLines(folioId);
  const projection = useFolioProjection(folioId);
  const f = folio.data as Record<string, unknown> | null | undefined;
  const currency = (f?.["currency"] as string) ?? "KES";
  const reservation = f?.["reservations"] as
    | { confirmation_number?: string; rooms?: { room_number?: string }; arrival_date?: string; departure_date?: string }
    | null
    | undefined;
  // Canonical identity — the same derivation the folio page, refunds and the
  // account ledger use, so a statement can never address a different party.
  const identity = deriveFolioIdentity(f as Record<string, unknown> | null | undefined);
  const account = identity && identity.guestName !== "—" ? identity.guestName : (identity?.companyName ?? "—");

  return (
    <QueryState
      isLoading={folio.isLoading || projection.isLoading}
      error={folio.error ?? projection.error}
      isEmpty={!f || !projection.data?.found}
      empty={
        <EmptyState
          icon={Receipt}
          title="Folio not found"
          description="It may belong to another property, or you may not have access to it."
        />
      }
    >
      {f ? (
        <DocumentPreview
          documentType="Folio statement"
          documentNumber={String(f["folio_number"] ?? "")}
          meta={[
            { label: "Opened", value: formatDateTime(f["opened_at"] as string) || "—" },
            { label: "Closed", value: formatDateTime(f["closed_at"] as string) || "Open" },
            { label: "Status", value: titleCase(String(f["status"] ?? "")) },
            { label: "Currency", value: currency },
          ]}
          addressedTo={{
            title: "Statement for",
            lines: [
              account,
              identity && identity.companyName !== "—" ? `Account ${identity.companyName}` : "Individual account",
              identity ? `Folio ${identity.folioNumber}` : "",
              reservation?.confirmation_number
                ? `Confirmation ${reservation.confirmation_number}`
                : "No linked reservation",
              reservation?.rooms?.room_number
                ? `Room ${reservation.rooms.room_number}`
                : "No room allocated",
              reservation?.arrival_date || reservation?.departure_date
                ? `Stay ${reservation?.arrival_date ?? "—"} → ${reservation?.departure_date ?? "—"}`
                : "No stay dates",
              identity && identity.billingInstructions !== "—"
                ? `Billing: ${identity.billingInstructions}`
                : "Billing: standard",
            ].filter(Boolean),
          }}
          columns={[
            { key: "date", label: "Date" },
            { key: "description", label: "Description" },
            { key: "category", label: "Category" },
            { key: "qty", label: "Qty", align: "right" },
            { key: "amount", label: "Amount", align: "right" },
          ]}
          rows={((lines.data ?? []) as unknown as LineRow[]).map((l) => ({
            date: formatDateTime(l.posting_date),
            description: l.description || "—",
            category: titleCase(l.category ?? ""),
            qty: String(Number(l.quantity ?? 0)),
            amount: money(l.gross_amount, currency),
          }))}
          totals={[
            { label: "Net charges", value: money(projection.data?.netRevenue ?? 0, currency) },
            { label: "VAT", value: money(projection.data?.tax ?? 0, currency) },
            { label: "Service charge", value: money(projection.data?.serviceCharge ?? 0, currency) },
            { label: "Gross billed", value: money(projection.data?.grossObligation ?? 0, currency) },
            { label: "Collected", value: money(projection.data?.collected ?? 0, currency) },
          ]}
          headline={{
            label: (projection.data?.outstanding ?? 0) < 0 ? "Refund due" : "Outstanding",
            value: money(projection.data?.outstanding ?? 0, currency),
          }}
          notes="Reversals appear as negative postings. This statement reflects the canonical folio record at the time of printing."
          emptyMessage="No charges have been posted to this folio yet."
        />
      ) : null}
    </QueryState>
  );
}

export function FolioStatementDialog({
  folioId,
  folioNumber,
  onOpenChange,
}: {
  folioId: string | null;
  folioNumber?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(folioId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl" data-folio-statement-dialog data-folio-id={folioId ?? ""}>
        <DialogHeader>
          <DialogTitle>Folio statement{folioNumber ? ` · ${folioNumber}` : ""}</DialogTitle>
          <DialogDescription>
            The printed statement for this exact folio, on the active property&apos;s branding.
          </DialogDescription>
        </DialogHeader>
        {folioId ? (
          <>
            <div className="flex justify-end gap-2">
              <DocumentPrintButton type="folio_statement" id={folioId} label="Print statement" />
              <SendToPrinterButton
                type="folio_statement"
                id={folioId}
                documentNumber={folioNumber ?? null}
                role="front_office"
              />
            </div>
            <FolioStatementBody folioId={folioId} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
