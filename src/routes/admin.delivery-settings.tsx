import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { PAYMENT_METHOD_CATALOGUE } from "@/lib/payment-methods";
import { useDeliverySettings, useSaveDeliverySettings, useCreateDeliverySettings } from "@/lib/delivery-data";

export const Route = createFileRoute("/admin/delivery-settings")({
  head: () => ({
    meta: [
      { title: "Delivery & Rider Settings — Configuration Centre" },
      {
        name: "description",
        content:
          "Set how a property takes delivery and pickup orders: payment methods, cash on delivery, lead times, proof of delivery and rider tracking.",
      },
      { property: "og:title", content: "Delivery & Rider Settings — Configuration Centre" },
      {
        property: "og:description",
        content: "Per-property delivery, payment, proof-of-delivery and rider tracking rules.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DeliverySettingsPage,
});

type Row = Record<string, unknown>;

const num = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function DeliverySettingsPage() {
  const { can } = useAuth();
  const canEdit = can("administration", "workspace", "edit") || can("delivery", "settings", "edit");
  const { activeBranchId, activeBranch } = useBranchScope();
  const branchId = activeBranchId && activeBranchId !== "all" ? activeBranchId : null;
  const settings = useDeliverySettings(branchId);
  const save = useSaveDeliverySettings();
  const create = useCreateDeliverySettings();
  const [form, setForm] = useState<Row | null>(null);

  useEffect(() => {
    if (settings.data) setForm({ ...(settings.data as Row) });
  }, [settings.data]);

  const set = (key: string, value: unknown) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  if (!branchId) {
    return (
      <div className="p-4 md:p-6">
        <PageHeader
          eyebrow="Delivery"
          title="Delivery & Rider Settings"
          description="These rules belong to one property. Choose a property in the selector above to view and change its delivery settings."
        />
      </div>
    );
  }

  if (settings.isLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="p-4 md:p-6">
        <PageHeader
          eyebrow="Delivery"
          title="Delivery & Rider Settings"
          description="This property has no delivery rules yet. Create them to start taking delivery and pickup orders."
        />
        <div className="rounded-xl border bg-card p-6">
          <p className="text-sm text-muted-foreground">
            Nothing is configured for {activeBranch?.name ?? "this property"}. Creating the rules
            starts everything switched off except the safe defaults, so nothing goes live until you
            decide it should.
          </p>
          <Button
            className="mt-4"
            disabled={!canEdit || create.isPending}
            onClick={() => create.mutate({ branchId })}
          >
            {create.isPending ? "Creating…" : "Create delivery rules"}
          </Button>
        </div>
      </div>
    );
  }

  const methods = Array.isArray(form["allowed_payment_methods"])
    ? (form["allowed_payment_methods"] as string[])
    : [];

  const toggleMethod = (value: string, on: boolean) =>
    set(
      "allowed_payment_methods",
      on ? [...new Set([...methods, value])] : methods.filter((m) => m !== value),
    );

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        eyebrow="Delivery"
        title="Delivery & Rider Settings"
        description={`How ${activeBranch?.name ?? "this property"} takes delivery and pickup orders. Guest ordering, dispatch and the rider app all read these rules.`}
        actions={
          <Link to="/admin/delivery-zones">
            <Button variant="outline">Zones & fees</Button>
          </Link>
        }
      />

      <Section title="Ordering" description="What the property offers and the floor it accepts.">
        <Toggle
          label="Delivery orders"
          help="Turn off to stop taking delivery orders without removing any zone."
          checked={Boolean(form["delivery_enabled"])}
          onChange={(v) => set("delivery_enabled", v)}
          disabled={!canEdit}
        />
        <Toggle
          label="Collection / pickup orders"
          checked={Boolean(form["pickup_enabled"])}
          onChange={(v) => set("pickup_enabled", v)}
          disabled={!canEdit}
        />
        <Toggle
          label="Scheduled orders"
          help="Lets a customer choose a later time instead of as soon as possible."
          checked={Boolean(form["scheduled_orders_enabled"])}
          onChange={(v) => set("scheduled_orders_enabled", v)}
          disabled={!canEdit}
        />
        <NumberField
          label="Minimum order value"
          value={num(form["min_order"], 0)}
          onChange={(v) => set("min_order", v)}
          disabled={!canEdit}
        />
        <NumberField
          label="Order lead time (minutes)"
          value={num(form["order_lead_minutes"], 30)}
          onChange={(v) => set("order_lead_minutes", v)}
          disabled={!canEdit}
        />
        <NumberField
          label="Kitchen buffer before dispatch (minutes)"
          value={num(form["prep_buffer_minutes"], 10)}
          onChange={(v) => set("prep_buffer_minutes", v)}
          disabled={!canEdit}
        />
        <NumberField
          label="Customer may cancel within (minutes)"
          value={num(form["cancellation_window_minutes"], 5)}
          onChange={(v) => set("cancellation_window_minutes", v)}
          disabled={!canEdit}
        />
      </Section>

      <Section
        title="Payment"
        description="Only the methods ticked here are offered at checkout. A provider-backed method still needs its provider connected before it can collect."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {PAYMENT_METHOD_CATALOGUE.filter((m) => m.value !== "room-charge").map((method) => (
            <label key={method.value} className="flex items-start gap-3 rounded-lg border p-3">
              <Switch
                checked={methods.includes(method.value)}
                onCheckedChange={(v) => toggleMethod(method.value, v)}
                disabled={!canEdit}
              />
              <span>
                <span className="block text-sm font-medium">{method.label}</span>
                <span className="block text-xs text-muted-foreground">{method.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Charging to a room is offered automatically to a guest with a verified stay, and is not
          set here.
        </p>
        <Toggle
          label="Cash on delivery"
          checked={Boolean(form["cod_enabled"])}
          onChange={(v) => set("cod_enabled", v)}
          disabled={!canEdit}
        />
        <NumberField
          label="Most cash a rider may carry per order"
          value={num(form["cod_limit"], 0)}
          onChange={(v) => set("cod_limit", v)}
          disabled={!canEdit}
        />
        <Toggle
          label="Accept paid orders automatically"
          help="Skips manual acceptance once the money is confirmed."
          checked={Boolean(form["auto_accept_paid"])}
          onChange={(v) => set("auto_accept_paid", v)}
          disabled={!canEdit}
        />
      </Section>

      <Section title="Riders, proof and tracking" description="What happens at the door, and what the customer may see on the way.">
        <NumberField
          label="Deliveries one rider may carry at once"
          value={num(form["rider_capacity"], 3)}
          onChange={(v) => set("rider_capacity", v)}
          disabled={!canEdit}
        />
        <div className="space-y-1.5">
          <Label>Proof of delivery</Label>
          <Select
            value={String(form["pod_method"] ?? "pin")}
            onValueChange={(v) => set("pod_method", v)}
            disabled={!canEdit}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pin">Customer PIN</SelectItem>
              <SelectItem value="signature">Signature</SelectItem>
              <SelectItem value="photo">Photo at the door</SelectItem>
              <SelectItem value="none">No proof required</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>If a delivery cannot be completed</Label>
          <Select
            value={String(form["failed_delivery_policy"] ?? "dispatch-review")}
            onValueChange={(v) => set("failed_delivery_policy", v)}
            disabled={!canEdit}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dispatch-review">Send back to dispatch for a decision</SelectItem>
              <SelectItem value="return-to-store">Return to the property</SelectItem>
              <SelectItem value="retry">Try again the same day</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Toggle
          label="Rider position updates"
          help="The rider app sends its position only while carrying an active delivery."
          checked={Boolean(form["gps_tracking_enabled"])}
          onChange={(v) => set("gps_tracking_enabled", v)}
          disabled={!canEdit}
        />
        <Toggle
          label="Show the rider's position to the customer"
          help="Applies only while that customer's own delivery is on the way."
          checked={Boolean(form["customer_tracking_enabled"])}
          onChange={(v) => set("customer_tracking_enabled", v)}
          disabled={!canEdit || !form["gps_tracking_enabled"]}
        />
        <Toggle
          label="Show the rider's phone number to the customer"
          checked={Boolean(form["rider_contact_enabled"])}
          onChange={(v) => set("rider_contact_enabled", v)}
          disabled={!canEdit}
        />
        <NumberField
          label="Position update every (seconds)"
          value={num(form["location_ping_seconds"], 30)}
          onChange={(v) => set("location_ping_seconds", Math.max(10, v))}
          disabled={!canEdit}
        />
        <NumberField
          label="Keep positions for (days)"
          value={num(form["location_retention_days"], 7)}
          onChange={(v) => set("location_retention_days", Math.max(1, v))}
          disabled={!canEdit}
        />
      </Section>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => settings.data && setForm({ ...(settings.data as Row) })}
          disabled={save.isPending}
        >
          Discard changes
        </Button>
        <Button
          disabled={!canEdit || save.isPending}
          onClick={() =>
            save.mutate({
              id: String(form["id"]),
              delivery_enabled: Boolean(form["delivery_enabled"]),
              pickup_enabled: Boolean(form["pickup_enabled"]),
              scheduled_orders_enabled: Boolean(form["scheduled_orders_enabled"]),
              min_order: num(form["min_order"], 0),
              order_lead_minutes: num(form["order_lead_minutes"], 30),
              prep_buffer_minutes: num(form["prep_buffer_minutes"], 10),
              cancellation_window_minutes: num(form["cancellation_window_minutes"], 5),
              allowed_payment_methods: methods,
              cod_enabled: Boolean(form["cod_enabled"]),
              cod_limit: num(form["cod_limit"], 0),
              auto_accept_paid: Boolean(form["auto_accept_paid"]),
              rider_capacity: num(form["rider_capacity"], 3),
              pod_method: String(form["pod_method"] ?? "pin"),
              failed_delivery_policy: String(form["failed_delivery_policy"] ?? "dispatch-review"),
              gps_tracking_enabled: Boolean(form["gps_tracking_enabled"]),
              customer_tracking_enabled: Boolean(form["customer_tracking_enabled"]),
              rider_contact_enabled: Boolean(form["rider_contact_enabled"]),
              location_ping_seconds: Math.max(10, num(form["location_ping_seconds"], 30)),
              location_retention_days: Math.max(1, num(form["location_retention_days"], 7)),
            })
          }
        >
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        className="max-w-xs"
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
