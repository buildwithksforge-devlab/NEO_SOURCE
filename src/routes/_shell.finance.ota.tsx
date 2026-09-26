import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, num, shortDate, titleCase } from "@/lib/finance";
import { useOtaReceivables } from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/ota")({
  head: financeHead(
    "OTA Settlements & Virtual Cards",
    "Commission, expected net settlement, virtual card collection status and settlement reconciliation.",
  ),
  component: () => (
    <FinanceGuard feature="ota" action="view">
      <OtaPage />
    </FinanceGuard>
  ),
});

function OtaPage() {
  const receivables = useOtaReceivables();
  const rows = receivables.data ?? [];

  const gross = rows.reduce((s, r) => s + num(r["gross_amount"]), 0);
  const commission = rows.reduce((s, r) => s + num(r["commission_amount"]), 0);
  const expected = rows.reduce((s, r) => s + num(r["net_expected"]), 0);
  const collected = rows.reduce((s, r) => s + num(r["collected_amount"]), 0);

  const vccRows: Record<string, unknown>[] = rows.flatMap((r) =>
    ((r["ota_vcc_records"] ?? []) as Record<string, unknown>[]).map((v) => ({
      ...v,
      provider: r["provider"],
      guest: r["guest_name"],
    })),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="OTA Settlements & Virtual Cards"
        description="Booking value, commission and the amount actually expected from each channel — plus which virtual cards are ready to charge, collected or expiring."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Gross booking value" value={money(gross)} />
        <StatCard label="Commission" value={money(commission)} tone="warning" />
        <StatCard label="Net expected" value={money(expected)} />
        <StatCard
          label="Uncollected"
          value={money(expected - collected)}
          tone={expected - collected > 0 ? "warning" : "success"}
        />
      </div>

      <SectionCard
        title="Channel receivables"
        description="One row per OTA reservation, with commission and settlement status."
      >
        <FinanceQueryState
          isLoading={receivables.isLoading}
          error={receivables.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="No OTA receivables"
              description="Bookings received from connected channels appear here with their commission and expected settlement."
            />
          }
        >
          <DataTable
            head={[
              "Provider",
              "Reference",
              "Guest",
              "Gross",
              "Commission",
              "Net expected",
              "Collected",
              "Settlement",
              "Status",
            ]}
          >
            {rows.map((r) => (
              <tr key={String(r["id"])}>
                <td className="py-2 pr-4">{titleCase(String(r["provider"]))}</td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {String(r["reservation_reference"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{String(r["guest_name"] ?? "—")}</td>
                <td className="py-2 pr-4">{money(r["gross_amount"])}</td>
                <td className="py-2 pr-4">
                  {money(r["commission_amount"])}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({num(r["commission_rate"])}%)
                  </span>
                </td>
                <td className="py-2 pr-4">{money(r["net_expected"])}</td>
                <td className="py-2 pr-4">{money(r["collected_amount"])}</td>
                <td className="py-2 pr-4">{shortDate(r["settlement_date"])}</td>
                <td className="py-2 pr-4">
                  <FinStatus value={String(r["collection_status"])} />
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Virtual credit cards"
        description="Charge windows and collection outcomes. Cards nearing expiry should be actioned first."
      >
        <FinanceQueryState
          isLoading={receivables.isLoading}
          error={receivables.error}
          isEmpty={vccRows.length === 0}
          empty={
            <FinanceEmpty
              title="No virtual cards"
              description="Virtual card details supplied by channels appear here once a booking is imported."
            />
          }
        >
          <DataTable
            head={[
              "Provider",
              "Guest",
              "Card",
              "Activates",
              "Expires",
              "Chargeable",
              "Charged",
              "Status",
            ]}
          >
            {vccRows.map((v) => (
              <tr key={String(v["id"])}>
                <td className="py-2 pr-4">{titleCase(String(v["provider"]))}</td>
                <td className="py-2 pr-4">{String(v["guest"] ?? "—")}</td>
                <td className="py-2 pr-4 font-mono text-xs">
                  •••• {String(v["card_last_four"] ?? "····")}
                </td>
                <td className="py-2 pr-4">{shortDate(v["activation_date"])}</td>
                <td className="py-2 pr-4">{shortDate(v["expiry_date"])}</td>
                <td className="py-2 pr-4">{money(v["chargeable_amount"])}</td>
                <td className="py-2 pr-4">{money(v["charged_amount"])}</td>
                <td className="py-2 pr-4">
                  <FinStatus value={String(v["status"])} />
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}
