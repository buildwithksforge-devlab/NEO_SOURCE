import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/admin/finance-periods")({
  head: () => ({
    meta: [
      { title: "Financial Years & Periods — Configuration Centre" },
      {
        name: "description",
        content:
          "Define the financial year and accounting periods every revenue posting is dated into. Finance cannot post before these exist.",
      },
      { property: "og:title", content: "Financial Years & Periods — Configuration Centre" },
      { property: "og:description", content: "Canonical financial calendar for the organisation." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FinancePeriodsPage,
});

function FinancePeriodsPage() {
  const { can, organizationId } = useAuth();
  const canEdit = can("administration", "workspace", "edit") || can("finance", "period", "edit");

  const years = useQuery({
    queryKey: ["config-collection", "financial_years", organizationId, "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("financial_years")
        .select("id, name, starts_on, ends_on, status")
        .order("starts_on", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const yearOptions = useMemo(
    () => (years.data ?? []).map((year) => ({ value: year.id, label: year.name })),
    [years.data],
  );

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Finance"
        title="Financial Years & Periods"
        description="Every journal entry is dated into an open accounting period. Until a financial year and its periods exist, revenue from rooms, restaurant, events and delivery cannot post — go-live stays blocked."
      />

      <div className="space-y-6">
        <ConfigCollection
          table="financial_years"
          title="Financial years"
          description="The organisation's reporting years. Close a year only after all its periods are closed."
          singular="Financial year"
          select="id, name, starts_on, ends_on, status"
          orderBy="starts_on"
          auditModule="finance"
          canEdit={canEdit}
          statusField="status"
          activeValue="open"
          inactiveValue="closed"
          activeLabel="Open"
          inactiveLabel="Closed"
          propertyScoped={false}
          fields={[
            { name: "name", label: "Year name", type: "text", required: true, placeholder: "FY 2026" },
            { name: "starts_on", label: "Starts on", type: "date", required: true },
            { name: "ends_on", label: "Ends on", type: "date", required: true },
            {
              name: "status",
              label: "Status",
              type: "select",
              defaultValue: "open",
              options: [
                { value: "open", label: "Open" },
                { value: "closed", label: "Closed" },
              ],
            },
          ]}
          renderSummary={(row) => (
            <span>
              {String(row["starts_on"] ?? "—")} → {String(row["ends_on"] ?? "—")}
            </span>
          )}
        />

        <ConfigCollection
          table="accounting_periods"
          title="Accounting periods"
          description="Usually one period per calendar month. Postings are rejected outside an open period."
          singular="Period"
          select="id, name, financial_year_id, starts_on, ends_on, status"
          orderBy="starts_on"
          auditModule="finance"
          canEdit={canEdit && yearOptions.length > 0}
          statusField="status"
          activeValue="open"
          inactiveValue="closed"
          activeLabel="Open"
          inactiveLabel="Closed"
          propertyScoped={false}
          fields={[
            { name: "name", label: "Period name", type: "text", required: true, placeholder: "January 2026" },
            {
              name: "financial_year_id",
              label: "Financial year",
              type: "select",
              required: true,
              options: yearOptions,
            },
            { name: "starts_on", label: "Starts on", type: "date", required: true },
            { name: "ends_on", label: "Ends on", type: "date", required: true },
            {
              name: "status",
              label: "Status",
              type: "select",
              defaultValue: "open",
              options: [
                { value: "open", label: "Open" },
                { value: "closed", label: "Closed" },
              ],
            },
          ]}
          renderSummary={(row) => (
            <span>
              {String(row["starts_on"] ?? "—")} → {String(row["ends_on"] ?? "—")}
            </span>
          )}
        >
          {yearOptions.length === 0 ? (
            <p className="mb-4 rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              Create a financial year first — a period must belong to one.
            </p>
          ) : null}
        </ConfigCollection>
      </div>
    </div>
  );
}
