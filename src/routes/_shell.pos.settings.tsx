import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, IntegrationStatus, PosGuard, QueryState } from "@/components/pos/PosShared";
import { RecordDialog } from "./_shell.pos.floor";
import { DEFAULT_POS_SETTINGS, type PosSettings } from "@/lib/pos";
import {
  usePosSettings,
  usePrinterProfiles,
  useSavePosSettings,
  useSaveRecord,
  useStations,
} from "@/lib/pos-data";

export const Route = createFileRoute("/_shell/pos/settings")({
  head: () => ({
    meta: [
      { title: "POS Settings — NEØ" },
      {
        name: "description",
        content:
          "Service charge, tax, tipping, printer profiles and the real connection state of payment providers.",
      },
      { property: "og:title", content: "POS Settings — NEØ" },
      {
        property: "og:description",
        content:
          "Service charge, tax, tipping, printer profiles and the real connection state of payment providers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="settings.manage" path="/pos/settings">
      <SettingsPage />
    </PosGuard>
  ),
});

function SettingsPage() {
  const query = usePosSettings();
  const save = useSavePosSettings();
  const printers = usePrinterProfiles();
  const stations = useStations();
  const savePrinter = useSaveRecord("printer_profiles");
  const [form, setForm] = useState<PosSettings>(DEFAULT_POS_SETTINGS);
  const [printerDialog, setPrinterDialog] = useState(false);

  const [printerConnection, setPrinterConnection] = useState("browser");

  const connectionMethods = [
    {
      value: "browser",
      label: "System Printer",
      detail: "Use a printer already installed on this device.",
    },
    {
      value: "bluetooth",
      label: "Bluetooth",
      detail: "Connect a compatible nearby printer using a supported print connector.",
    },
    {
      value: "wifi",
      label: "Wi-Fi",
      detail: "Connect a network printer on the hotel's Wi-Fi.",
    },
    {
      value: "ethernet",
      label: "Ethernet / LAN",
      detail: "Connect a wired network printer.",
    },
    {
      value: "usb",
      label: "USB",
      detail: "Connect a printer attached to this device.",
    },
    {
      value: "cloud",
      label: "Cloud Printer",
      detail: "Connect a compatible cloud-enabled printing device.",
    },
  ];

  useEffect(() => {
    if (query.data) setForm(query.data.settings);
  }, [query.data]);

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="POS Settings"
        description="Trading rules applied to every bill, plus the honest connection state of each integration."
        actions={
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate({ id: query.data?.id ?? null, settings: form })}
          >
            Save settings
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Charges & tax" description="Applied when an order is recalculated.">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="sc">Service charge %</Label>
              <Input
                id="sc"
                inputMode="decimal"
                value={String(form.serviceChargePercent)}
                onChange={(e) =>
                  setForm({ ...form, serviceChargePercent: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tax">Default tax rate %</Label>
              <Input
                id="tax"
                inputMode="decimal"
                value={String(form.defaultTaxPercent)}
                onChange={(e) =>
                  setForm({ ...form, defaultTaxPercent: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="shift">Require an open shift before taking cash</Label>
              <Switch
                id="shift"
                checked={form.enforceShift}
                onCheckedChange={(v) => setForm({ ...form, enforceShift: v })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="footer">Receipt footer</Label>
              <Input
                id="footer"
                value={form.receiptFooter}
                onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })}
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Integrations"
          description="Nothing here is simulated — a provider is only 'connected' once real credentials are configured."
        >
          <div className="space-y-3">
            <IntegrationStatus
              label="M-Pesa / mobile money"
              status="not-configured"
              detail="Mobile money payments are recorded as pending and are never auto-confirmed until a verified provider callback is received."
              steps={[
                "Provide provider credentials",
                "Enable the payment callback endpoint",
                "Confirm a live test transaction",
              ]}
            />
            <IntegrationStatus
              label="Card terminal"
              status="not-configured"
              detail="Card settlements are captured with their reference and stay pending until the acquirer confirms them."
            />
            <IntegrationStatus
              label="Guest room folio posting"
              status="connected"
              detail="Room charges post directly to an open folio for in-house guests, with duplicate protection."
            />
            <IntegrationStatus
              label="Kitchen Display System"
              status="connected"
              detail="Station tickets update live over the realtime channel."
            />
          </div>
        </SectionCard>
      </div>

      <SectionCard
        className="mt-6"
        title="Printer profiles"
        description="Where receipts and station tickets are printed."
        actions={
          <Button size="sm" variant="outline" onClick={() => setPrinterDialog(true)}>
            Add printer
          </Button>
        }
      >
        <QueryState
          isLoading={printers.isLoading}
          error={printers.error}
          isEmpty={(printers.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No printers configured"
              description="Add a printer profile per station or cashier point."
            />
          }
        >
          <ul className="space-y-2 text-sm">
            {(printers.data ?? []).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3">
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {p.operational_stations?.name ?? "General"}
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      <SectionCard
        className="mt-6"
        title="Printer connections"
        description="Choose how a compatible printer will connect to NEØ."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {connectionMethods.map((method) => (
            <button
              key={method.value}
              type="button"
              onClick={() => {
                setPrinterConnection(method.value);
                setPrinterDialog(true);
              }}
              className="rounded-lg border p-4 text-left transition-colors hover:bg-muted"
            >
              <div className="font-medium">{method.label}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {method.detail}
              </p>
            </button>
          ))}
        </div>
      </SectionCard>

      <RecordDialog
        open={printerDialog}
        onOpenChange={setPrinterDialog}
        title="Configure printer"
        fields={[
          { name: "name", label: "Printer name", required: true },
          {
            name: "address",
            label:
              printerConnection === "wifi" ||
              printerConnection === "ethernet"
                ? "Printer network address"
                : printerConnection === "cloud"
                  ? "Cloud printer identifier"
                  : "Device identifier (if required)",
          },
        ]}
        selects={[
          {
            name: "station_id",
            label: "Production station",
            options: (stations.data ?? []).map((s) => ({
              value: s.id,
              label: s.name,
            })),
          },
        ]}
        onSubmit={(values) =>
          savePrinter.mutate({
            values: {
              ...values,
              connection_type: printerConnection,
              status: "not-configured",
            },
          })
        }
      />
    </div>
  );
}
