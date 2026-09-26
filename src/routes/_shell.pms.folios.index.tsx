import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Receipt } from "lucide-react";
import { Atomic, PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, FolioStatusBadge, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { FolioStatementDialog } from "@/components/pms/FolioStatementDialog";
import { FOLIO_STATUSES, money, titleCase } from "@/lib/pms";
import { useCloseFolio, useDeparturesPendingSettlement, useFolioDirectory } from "@/lib/pms-data";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/pms/folios/")({
  head: () => ({
    meta: [
      { title: "Folios — NEØ" },
      {
        name: "description",
        content: "Every guest, corporate and group folio with live charges, payments and balances.",
      },
      { property: "og:title", content: "Folios — NEØ" },
      {
        property: "og:description",
        content: "Every guest, corporate and group folio with live charges, payments and balances.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="folios.view">
      <FoliosPage />
    </PmsGuard>
  ),
});

function FoliosPage() {
  const [status, setStatus] = useState("open");
  // Clicking a folio number presents that exact folio as a premium document
  // overlay; the operational folio page stays reachable from the row actions.
  const [preview, setPreview] = useState<{ id: string; number: string } | null>(null);
  const folios = useFolioDirectory(status);
  const rows = folios.data ?? [];
  const outstanding = rows.reduce((sum, f) => sum + Number(f.balance ?? 0), 0);

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Folios"
        description="Guest, corporate and group folios across the property. Balances are read straight from posted charges and payments."
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-48" aria-label="Filter folios by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {FOLIO_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <DeparturesPendingSettlement />


      <SectionCard
        title={`${rows.length} folio(s)`}
        description={`Outstanding balance in this view: ${money(outstanding)}`}
      >
        <QueryState
          isLoading={folios.isLoading}
          error={folios.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Receipt}
              title="No folios yet"
              description="Folios open automatically when a reservation is checked in, or when a corporate or group account is billed."
            />
          }
        >
          <TableScroll>
            <Table className="neo-list-rows">
              <TableHeader>
                <TableRow>
                  <TableHead className="neo-sticky-col">Folio</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Charges</TableHead>
                  <TableHead className="text-right">Payments</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="neo-sticky-col whitespace-nowrap font-medium">
                      <button
                        type="button"
                        data-folio-open={f.id}
                        onClick={() => setPreview({ id: f.id, number: String(f.folio_number) })}
                        className="text-primary hover:underline"
                      >
                        {f.folio_number}
                      </button>
                    </TableCell>
                    <TableCell>
                      <span
                        className="neo-line-1 max-w-[16rem]"
                        title={
                          f.customers?.full_name ??
                          f.corporate_accounts?.legal_name ??
                          f.group_bookings?.name ??
                          "—"
                        }
                      >
                        {f.customers?.full_name ??
                          f.corporate_accounts?.legal_name ??
                          f.group_bookings?.name ??
                          "—"}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{titleCase(f.folio_type)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <FolioStatusBadge status={f.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Atomic>{money(f.total_charges, f.currency ?? "KES")}</Atomic>
                    </TableCell>
                    <TableCell className="text-right">
                      <Atomic>{money(f.total_payments, f.currency ?? "KES")}</Atomic>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      <Atomic>{money(f.balance, f.currency ?? "KES")}</Atomic>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Link
                        to="/pms/folios/$id"
                        params={{ id: f.id }}
                        className="mr-3 text-sm font-medium text-primary hover:underline"
                      >
                        Open folio
                      </Link>
                      {f.reservation_id ? (
                        <Link
                          to="/pms/reservations/$id"
                          params={{ id: f.reservation_id }}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          Open reservation
                        </Link>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <FolioStatementDialog
        folioId={preview?.id ?? null}
        folioNumber={preview?.number ?? null}
        onOpenChange={(open) => (open ? undefined : setPreview(null))}
      />
    </div>
  );
}

/**
 * Departures that never finished.
 *
 * The guest has left, but the bill is still open. Either money is still owed —
 * in which case a cashier settles it on the folio — or the bill is square and
 * nobody closed it, which this queue does directly.
 */
function DeparturesPendingSettlement() {
  const departures = useDeparturesPendingSettlement();
  const close = useCloseFolio();
  const rows = departures.data ?? [];
  if (departures.isLoading || rows.length === 0) return null;
  const owed = rows.reduce((sum, f) => sum + Number(f.balance ?? 0), 0);

  return (
    <SectionCard
      title={`${rows.length} departed guest(s) with an open bill`}
      description={`${money(owed)} left uncollected. Settle on the folio, then close it.`}
    >
      <TableScroll>
        <Table className="neo-list-rows">
          <TableHeader>
            <TableRow>
              <TableHead>Folio</TableHead>
              <TableHead>Guest</TableHead>
              <TableHead>Reservation</TableHead>
              <TableHead className="text-right">Charges</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="whitespace-nowrap font-medium">{f.folio_number}</TableCell>
                <TableCell>{f.customers?.full_name ?? "—"}</TableCell>
                <TableCell>{f.reservations?.confirmation_number ?? "—"}</TableCell>
                <TableCell className="text-right">{money(f.total_charges)}</TableCell>
                <TableCell className="text-right">{money(f.total_payments)}</TableCell>
                <TableCell className="text-right font-medium">{money(f.balance)}</TableCell>
                <TableCell className="text-right">
                  {Number(f.balance ?? 0) === 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={close.isPending}
                      onClick={() =>
                        close.mutate({ folio: f.id, reason: "Departure settlement completed" })
                      }
                    >
                      Close folio
                    </Button>
                  ) : (
                    <Button asChild size="sm">
                      <Link to="/pms/folios/$id" params={{ id: f.id }}>
                        Settle
                      </Link>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    </SectionCard>
  );
}

