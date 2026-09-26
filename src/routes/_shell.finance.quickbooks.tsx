import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { BookOpenCheck, CircleAlert, RefreshCw } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { NotConfiguredNotice, QueryState } from "@/components/pms/PmsShared";
import { formatDateTime, lpoStatusTone, titleCase, type Row } from "@/lib/procurement";
import { useAccountingSyncLog, useQuickBooksConnection } from "@/lib/procurement-data";

export const Route = createFileRoute("/_shell/finance/quickbooks")({
  head: () => ({
    meta: [
      { title: "QuickBooks Sync — NEØ" },
      {
        name: "description",
        content:
          "Accounting export status, mapped ledgers and the full QuickBooks synchronisation log.",
      },
      { property: "og:title", content: "QuickBooks Sync — NEØ" },
      {
        property: "og:description",
        content:
          "Accounting export status, mapped ledgers and the full QuickBooks synchronisation log.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function Page() {
  const connection = useQuickBooksConnection();
  const log = useAccountingSyncLog();

  const conn = (connection.data ?? null) as Row | null;
  const connected = Boolean(conn && String(conn["status"] ?? "") === "connected");
  const rows = (log.data ?? []) as Row[];
  const failed = rows.filter((r) => String(r["status"] ?? "") === "failed").length;
  const synced = rows.filter((r) => String(r["status"] ?? "") === "synced").length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Accounting Integration"
        title="QuickBooks"
        description="Journals, supplier invoices, payments and revenue postings are exported to QuickBooks once real credentials are connected and a sandbox test passes."
      />

      {!connected ? (
        <NotConfiguredNotice
          label="QuickBooks is not configured"
          steps={[
            "Add QuickBooks Online credentials in Platform → Integrations.",
            "Complete the server-side OAuth authorisation for your company file.",
            "Map the chart of accounts, tax codes and departments to QuickBooks classes.",
            "Run a sandbox sync test — the connection stays 'Not configured' until it passes.",
          ]}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Connection"
          value={connected ? "Connected" : "Not configured"}
          hint={conn ? titleCase(String(conn["status"] ?? "")) : "No credentials stored"}
          icon={BookOpenCheck}
          tone={connected ? "success" : "warning"}
        />
        <StatCard
          label="Last sync"
          value={conn?.["last_sync_at"] ? formatDateTime(conn["last_sync_at"]) : "Never"}
          hint="Most recent successful export"
          icon={RefreshCw}
        />
        <StatCard label="Records synced" value={String(synced)} hint="In the visible log window" />
        <StatCard
          label="Failed records"
          value={String(failed)}
          hint="Require attention before closing the period"
          icon={CircleAlert}
          tone={failed > 0 ? "warning" : "default"}
        />
      </div>

      <SectionCard
        title="Synchronisation log"
        description="Every attempted export with its document, status and error message. Entries are never removed."
      >
        <QueryState
          isLoading={log.isLoading}
          error={log.error}
          isEmpty={rows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No synchronisation has been attempted yet.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li
                key={String(r["id"])}
                className="flex items-start justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{`${titleCase(String(r["entity_type"] ?? "Record"))} · ${String(r["entity_reference"] ?? r["entity_id"] ?? "")}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${String(r["direction"] ?? "outbound")} · ${formatDateTime(r["created_at"])}${r["error_message"] ? ` · ${String(r["error_message"])}` : ""}`}
                  </p>
                </div>
                <StatusPill tone={lpoStatusTone(String(r["status"] ?? ""))}>
                  {titleCase(String(r["status"] ?? "pending"))}
                </StatusPill>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/finance/quickbooks">
      <Page />
    </OpsGuard>
  );
}
