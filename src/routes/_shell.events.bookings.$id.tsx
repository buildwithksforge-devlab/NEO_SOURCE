import { useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, FileText, ShieldAlert } from "lucide-react";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DataTable,
  EventsEmpty,
  EventsGuard,
  EventsQueryState,
  FormDialog,
  NotConfigured,
  Pill,
  RecordForm,
} from "@/components/events/EventsShared";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import {
  DEPARTMENT_KEYS,
  READINESS_STATES,
  SERVICE_STYLES,
  beoTone,
  bookingTone,
  formatDate,
  formatDateTime,
  formatMoney,
  num,
  paymentTone,
  readinessTone,
  titleCase,
  type Row,
} from "@/lib/events";
import {
  useBeos,
  useBooking,
  useBillingItems,
  useConfirmBooking,
  useDepartmentRequirements,
  useDepartmentsLite,
  useEventActivity,
  useEventInsert,
  useEventInvoice,
  useEventMenus,
  useEventRequirements,
  useEventRoomBlocks,
  useEventUpdate,
  useMilestones,
  usePublishBeo,
  useEnsureBeo,
  useReviseBeo,
} from "@/lib/events-data";

export const Route = createFileRoute("/_shell/events/bookings/$id")({
  head: () => ({
    meta: [
      { title: "Event Profile — NEØ" },
      {
        name: "description",
        content:
          "Central event profile: timeline, banquet event order, department readiness, catering, accommodation and billing.",
      },
      { property: "og:title", content: "Event Profile — NEØ" },
      {
        property: "og:description",
        content: "Timeline, BEO, department readiness, catering and billing for one event.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <EventsGuard>
      <Page />
    </EventsGuard>
  ),
});

function Page() {
  const { id } = useParams({ from: "/_shell/events/bookings/$id" });
  const { can } = useAuth();
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;

  const booking = useBooking(id);
  const milestones = useMilestones(id);
  const requirements = useDepartmentRequirements(id);
  const beos = useBeos(id);
  const menus = useEventMenus(id);
  const billing = useBillingItems(id);
  const eventInvoice = useEventInvoice(id);

  const stock = useEventRequirements(id);
  const rooms = useEventRoomBlocks(id);
  const activity = useEventActivity(id);
  const departments = useDepartmentsLite();

  const confirm = useConfirmBooking();
  const addRequirement = useEventInsert("event_department_requirements", "Department requirement");
  const addMenu = useEventInsert("event_menus", "Event menu");
  const addBilling = useEventInsert("event_billing_items", "Billing line");
  const addStock = useEventInsert("event_requirements", "Stock requirement");
  const updateRequirement = useEventUpdate("event_department_requirements", "Readiness");
  const updateBooking = useEventUpdate("event_bookings", "Event");
  const reviseBeo = useReviseBeo();
  const ensureBeo = useEnsureBeo();
  const publishBeo = usePublishBeo();

  const [overrideReason, setOverrideReason] = useState("");

  const b = booking.data;
  const canFinancials = can("events", "financials");

  if (booking.isLoading) return <div className="h-64 animate-pulse rounded-xl bg-muted" />;
  if (!b) {
    return (
      <EventsEmpty
        title="Event not found"
        description="This event does not exist, or it belongs to another organisation."
        action={
          <Button variant="outline" asChild>
            <Link to="/events/bookings">Back to bookings</Link>
          </Button>
        }
      />
    );
  }

  const guests = num(b["final_guests"]) || num(b["guaranteed_guests"]) || num(b["expected_guests"]);
  const balance = num(b["total_amount"]) - num(b["paid_amount"]);
  const latestBeo = ((beos.data ?? []) as Row[]).slice(-1)[0] ?? null;
  const reqRows = (requirements.data ?? []) as Row[];
  const billingRows = (billing.data ?? []) as Row[];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Event ${String(b["event_reference"])}`}
        title={String(b["event_name"] || "Event profile")}
        description={`${formatDate(b["event_date"])} · ${String((b["event_venues"] as Row | null)?.["name"] ?? "No venue")} · ${guests} guests`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/events/bookings">
                <ArrowLeft className="size-4" />
                All bookings
              </Link>
            </Button>
            <DocumentPrintButton
              type="beo"
              id={latestBeo ? String(latestBeo["id"]) : null}
              label="Print BEO"
              size="default"
            />
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Booking status"
          value={titleCase(String(b["status"]))}
          icon={CheckCircle2}
        />
        <StatCard
          label="Guests"
          value={String(guests)}
          icon={FileText}
          hint={`${num(b["adults"])} adults · ${num(b["children"])} children`}
        />
        {canFinancials ? (
          <>
            <StatCard
              label="Deposit"
              value={`${formatMoney(symbol, b["deposit_paid"])} / ${formatMoney(symbol, b["deposit_required"])}`}
              icon={FileText}
            />
            <StatCard
              label="Outstanding balance"
              value={formatMoney(symbol, balance)}
              icon={FileText}
            />
          </>
        ) : (
          <div className="sm:col-span-2 rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
            Financial details are hidden — the{" "}
            <span className="font-mono text-xs">events.financials</span> permission is required.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={bookingTone(String(b["status"]))} value={String(b["status"])} />
        <Pill tone={paymentTone(String(b["payment_status"]))} value={String(b["payment_status"])} />
        {can("events", "confirm") &&
        !["confirmed", "in-planning", "ready", "in-progress", "completed", "closed"].includes(
          String(b["status"]),
        ) ? (
          <FormDialog
            trigger={<Button size="sm">Confirm booking</Button>}
            title="Confirm event booking"
            description="Reserves the venue for the setup-to-breakdown window, seeds the timeline, generates department tasks and drafts the BEO. Running it twice never duplicates anything."
          >
            {(close) => (
              <div className="space-y-3">
                <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                  Confirmation requirements: accepted quotation, deposit received or approved
                  corporate credit. A manager override needs the{" "}
                  <span className="font-mono text-xs">events.override</span> permission and a
                  reason.
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="override">
                    Override reason (only if confirming without deposit/credit)
                  </Label>
                  <Input
                    id="override"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                  />
                </div>
                <Button
                  disabled={confirm.isPending}
                  onClick={() =>
                    confirm.mutate({ bookingId: id, overrideReason }, { onSuccess: () => close() })
                  }
                >
                  Confirm event
                </Button>
              </div>
            )}
          </FormDialog>
        ) : null}
        {can("events", "edit") ? (
          <FormDialog
            trigger={
              <Button size="sm" variant="outline">
                Update guest count
              </Button>
            }
            title="Update guest count"
            description="Guest-count changes recalculate catering quantities. Approved menus are versioned, never silently overwritten."
          >
            {(close) => (
              <RecordForm
                submitLabel="Save guest count"
                initial={{
                  guaranteed_guests: num(b["guaranteed_guests"]),
                  final_guests: num(b["final_guests"]),
                }}
                fields={[
                  { name: "guaranteed_guests", label: "Guaranteed guests", type: "number" },
                  { name: "final_guests", label: "Final guests", type: "number" },
                  { name: "adults", label: "Adults", type: "number" },
                  { name: "children", label: "Children", type: "number" },
                ]}
                onSubmit={(values) =>
                  updateBooking.mutate({ id, values }, { onSuccess: () => close() })
                }
              />
            )}
          </FormDialog>
        ) : null}
      </div>

      <Tabs defaultValue="profile">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="beo">Banquet Event Order</TabsTrigger>
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="catering">Catering</TabsTrigger>
          <TabsTrigger value="stores">Stores</TabsTrigger>
          <TabsTrigger value="rooms">Accommodation</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4 space-y-6">
          <SectionCard title="Event details" description="Operational source data">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[
                ["Client", String((b["customers"] as Row | null)?.["full_name"] ?? "—")],
                [
                  "Corporate account",
                  String((b["corporate_accounts"] as Row | null)?.["legal_name"] ?? "—"),
                ],
                ["Primary contact", String(b["primary_contact"] || "—")],
                ["Event type", String((b["event_types"] as Row | null)?.["name"] ?? "—")],
                ["Setup", formatDateTime(b["setup_at"])],
                ["Start", formatDateTime(b["start_at"])],
                ["End", formatDateTime(b["end_at"])],
                ["Breakdown", formatDateTime(b["breakdown_at"])],
                ["Service style", titleCase(String(b["service_style"]))],
                ["Seating layout", titleCase(String(b["seating_layout"]))],
                ["Colour theme", String(b["colour_theme"] || "—")],
                ["VIP details", String(b["vip_details"] || "—")],
                ["Dietary requirements", String(b["dietary_requirements"] || "—")],
                ["Allergy warnings", String(b["allergy_warnings"] || "—")],
                ["Photography consent", b["photography_consent"] ? "Granted" : "Not granted"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">{k}</p>
                  <p className="text-sm font-medium">{v}</p>
                </div>
              ))}
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          <SectionCard
            title="Event timeline"
            description="Milestones with responsibility and due dates"
          >
            <EventsQueryState
              isLoading={milestones.isLoading}
              error={milestones.error}
              isEmpty={(milestones.data ?? []).length === 0}
              empty={
                <EventsEmpty
                  title="No milestones yet"
                  description="Milestones are seeded when the event booking is confirmed."
                />
              }
            >
              <ol className="space-y-2">
                {((milestones.data ?? []) as Row[]).map((m) => {
                  const overdue =
                    !m["completed_at"] && m["due_at"] && new Date(String(m["due_at"])) < new Date();
                  return (
                    <li
                      key={String(m["id"])}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                    >
                      <span className="text-sm font-medium">{String(m["label"])}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {m["due_at"] ? <span>Due {formatDateTime(m["due_at"])}</span> : null}
                        <Pill
                          tone={m["completed_at"] ? "success" : overdue ? "destructive" : "default"}
                          value={m["completed_at"] ? "completed" : overdue ? "overdue" : "upcoming"}
                        />
                      </span>
                    </li>
                  );
                })}
              </ol>
            </EventsQueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="beo" className="mt-4 space-y-6">
          <SectionCard
            title="Banquet Event Order"
            description="Approved operational source of truth. Material changes create a new revision; client pricing is never shown to departments."
            actions={
              can("events", "beo") ? (
                !latestBeo ? (
                  <Button
                    size="sm"
                    disabled={ensureBeo.isPending}
                    onClick={() => ensureBeo.mutate(id)}
                  >
                    Raise banquet event order
                  </Button>
                ) : (
                <div className="flex gap-2">

                  <FormDialog
                    trigger={
                      <Button size="sm" variant="outline">
                        Create revision
                      </Button>
                    }
                    title="Create BEO revision"
                    description="The current revision is preserved and marked superseded."
                  >
                    {(close) => (
                      <RecordForm
                        submitLabel="Create revision"
                        fields={[
                          {
                            name: "change_summary",
                            label: "Change summary",
                            type: "textarea",
                            span: true,
                            required: true,
                          },
                        ]}
                        onSubmit={(values) =>
                          reviseBeo.mutate(
                            {
                              beo: latestBeo,
                              changeSummary: String(values["change_summary"] ?? ""),
                            },
                            { onSuccess: () => close() },
                          )
                        }
                      />
                    )}
                  </FormDialog>
                  {String(latestBeo["status"]) !== "published" ? (
                    <Button size="sm" onClick={() => publishBeo.mutate(String(latestBeo["id"]))}>
                      Publish to departments
                    </Button>
                  ) : null}
                </div>
                )
              ) : null

            }
          >
            {latestBeo ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{String(latestBeo["beo_number"])}</span>
                  <span className="text-sm text-muted-foreground">
                    Revision {num(latestBeo["revision"])}
                  </span>
                  <Pill
                    tone={beoTone(String(latestBeo["status"]))}
                    value={String(latestBeo["status"])}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {[
                    ["Setup", formatDateTime(latestBeo["setup_at"])],
                    ["Guest arrival", formatDateTime(latestBeo["guest_arrival_at"])],
                    ["Serving times", String(latestBeo["serving_times"] || "—")],
                    ["Breakdown", formatDateTime(latestBeo["breakdown_at"])],
                    ["Guaranteed guests", String(num(latestBeo["guaranteed_guests"]))],
                    ["Seating layout", String(latestBeo["seating_layout"] || "—")],
                    ["Menu summary", String(latestBeo["menu_summary"] || "—")],
                    ["Beverage service", String(latestBeo["beverage_service"] || "—")],
                    ["Allergies", String(latestBeo["allergies"] || "—")],
                    ["Equipment", String(latestBeo["equipment"] || "—")],
                    ["Décor", String(latestBeo["decor"] || "—")],
                    ["Emergency contacts", String(latestBeo["emergency_contacts"] || "—")],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-lg border border-border px-3 py-2">
                      <p className="text-xs text-muted-foreground">{k}</p>
                      <p className="text-sm font-medium">{v}</p>
                    </div>
                  ))}
                </div>
                {String(latestBeo["change_summary"] || "") ? (
                  <p className="text-sm text-muted-foreground">
                    Change summary: {String(latestBeo["change_summary"])}
                  </p>
                ) : null}
              </div>
            ) : (
              <EventsEmpty
                title="No banquet event order yet"
                description="Raise the banquet event order to hand this event to kitchen, housekeeping, front office and billing."

              />
            )}
          </SectionCard>

          <SectionCard title="Revision history" description="Every revision is preserved">
            <EventsQueryState
              isLoading={beos.isLoading}
              error={beos.error}
              isEmpty={(beos.data ?? []).length === 0}
              empty={
                <EventsEmpty
                  title="No revisions"
                  description="Revisions appear once a BEO exists."
                />
              }
            >
              <DataTable head={["BEO", "Revision", "Status", "Published", "Change summary"]}>
                {((beos.data ?? []) as Row[]).map((r) => (
                  <tr key={String(r["id"])}>
                    <td className="py-2 pr-4 font-mono text-xs">{String(r["beo_number"])}</td>
                    <td className="py-2 pr-4">{num(r["revision"])}</td>
                    <td className="py-2 pr-4">
                      <Pill tone={beoTone(String(r["status"]))} value={String(r["status"])} />
                    </td>
                    <td className="py-2 pr-4">{formatDateTime(r["published_at"])}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {String(r["change_summary"] || "—")}
                    </td>
                  </tr>
                ))}
              </DataTable>
            </EventsQueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="departments" className="mt-4">
          <SectionCard
            title="Department requirements & readiness"
            description="Tasks are created in the central Task Management system when the booking is confirmed."
            actions={
              can("events", "edit") ? (
                <FormDialog
                  trigger={<Button size="sm">Add requirement</Button>}
                  title="Add department requirement"
                  description="Assign work to a department. Confirming the booking turns each requirement into a task."
                >
                  {(close) => (
                    <RecordForm
                      submitLabel="Add requirement"
                      fields={[
                        {
                          name: "department_key",
                          label: "Department",
                          type: "select",
                          options: DEPARTMENT_KEYS.map((d) => ({ value: d, label: titleCase(d) })),
                          required: true,
                        },
                        {
                          name: "department_id",
                          label: "Link to configured department",
                          type: "select",
                          options: ((departments.data ?? []) as Row[]).map((d) => ({
                            value: String(d["id"]),
                            label: String(d["name"]),
                          })),
                        },
                        { name: "requirement", label: "Requirement", required: true, span: true },
                        { name: "detail", label: "Detail", type: "textarea", span: true },
                        { name: "required_by", label: "Required by", type: "datetime-local" },
                      ]}
                      onSubmit={(values) =>
                        addRequirement.mutate(
                          { ...values, booking_id: id },
                          { onSuccess: () => close() },
                        )
                      }
                    />
                  )}
                </FormDialog>
              ) : null
            }
          >
            <EventsQueryState
              isLoading={requirements.isLoading}
              error={requirements.error}
              isEmpty={reqRows.length === 0}
              empty={
                <EventsEmpty
                  title="No department requirements"
                  description="Add the work each department must complete for this event."
                />
              }
            >
              <DataTable
                head={["Department", "Requirement", "Required by", "Readiness", "Blocker", ""]}
              >
                {reqRows.map((r) => (
                  <tr key={String(r["id"])}>
                    <td className="py-2 pr-4">
                      {String(
                        (r["departments"] as Row | null)?.["name"] ??
                          titleCase(String(r["department_key"])),
                      )}
                    </td>
                    <td className="py-2 pr-4">{String(r["requirement"])}</td>
                    <td className="py-2 pr-4">{formatDateTime(r["required_by"])}</td>
                    <td className="py-2 pr-4">
                      <Pill
                        tone={readinessTone(String(r["readiness"]))}
                        value={String(r["readiness"])}
                      />
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {String(r["blocker"] || "—")}
                    </td>
                    <td className="py-2 pr-4">
                      {can("events", "readiness") ? (
                        <FormDialog
                          trigger={
                            <Button size="sm" variant="outline">
                              Update
                            </Button>
                          }
                          title="Update readiness"
                          description="Department staff report progress and blockers here."
                        >
                          {(close) => (
                            <RecordForm
                              submitLabel="Save"
                              initial={{
                                readiness: String(r["readiness"]),
                                blocker: String(r["blocker"]),
                              }}
                              fields={[
                                {
                                  name: "readiness",
                                  label: "Readiness",
                                  type: "select",
                                  options: READINESS_STATES.map((s) => ({
                                    value: s,
                                    label: titleCase(s),
                                  })),
                                },
                                { name: "blocker", label: "Blocker", type: "textarea", span: true },
                              ]}
                              onSubmit={(values) =>
                                updateRequirement.mutate(
                                  { id: String(r["id"]), values },
                                  { onSuccess: () => close() },
                                )
                              }
                            />
                          )}
                        </FormDialog>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </DataTable>
            </EventsQueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="catering" className="mt-4">
          <SectionCard
            title="Event menus"
            description="Linked to restaurant menu items and approved recipes so kitchen production and costing stay consistent."
            actions={
              can("events", "edit") ? (
                <FormDialog
                  trigger={<Button size="sm">Add menu</Button>}
                  title="Add event menu"
                  description="Buffet, plated, tea break or custom service."
                >
                  {(close) => (
                    <RecordForm
                      submitLabel="Add menu"
                      fields={[
                        { name: "name", label: "Menu name", required: true, span: true },
                        {
                          name: "service_style",
                          label: "Service style",
                          type: "select",
                          options: SERVICE_STYLES.map((s) => ({ value: s, label: titleCase(s) })),
                        },
                        { name: "service_at", label: "Service time", type: "datetime-local" },
                        { name: "guest_count", label: "Guest count", type: "number" },
                        { name: "price_per_person", label: "Price per person", type: "number" },
                        { name: "allergens", label: "Allergens", type: "textarea", span: true },
                      ]}
                      onSubmit={(values) =>
                        addMenu.mutate({ ...values, booking_id: id }, { onSuccess: () => close() })
                      }
                    />
                  )}
                </FormDialog>
              ) : null
            }
          >
            <EventsQueryState
              isLoading={menus.isLoading}
              error={menus.error}
              isEmpty={(menus.data ?? []).length === 0}
              empty={
                <EventsEmpty
                  title="No menus yet"
                  description="Add the catering plan so Kitchen and Stores can prepare."
                />
              }
            >
              <DataTable head={["Menu", "Service", "Time", "Guests", "Per person", "Version"]}>
                {((menus.data ?? []) as Row[]).map((m) => (
                  <tr key={String(m["id"])}>
                    <td className="py-2 pr-4 font-medium">{String(m["name"])}</td>
                    <td className="py-2 pr-4">{titleCase(String(m["service_style"]))}</td>
                    <td className="py-2 pr-4">{formatDateTime(m["service_at"])}</td>
                    <td className="py-2 pr-4">{num(m["guest_count"])}</td>
                    <td className="py-2 pr-4">
                      {canFinancials ? formatMoney(symbol, m["price_per_person"]) : "—"}
                    </td>
                    <td className="py-2 pr-4">v{num(m["version"])}</td>
                  </tr>
                ))}
              </DataTable>
            </EventsQueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="stores" className="mt-4">
          <SectionCard
            title="Stock requirements"
            description="Planned, reserved, issued, consumed, returned and wasted quantities. Reserving never deducts stock — Phase 9 issuing does."
            actions={
              can("events", "edit") ? (
                <FormDialog
                  trigger={<Button size="sm">Add requirement</Button>}
                  title="Add stock requirement"
                  description="Stores checks availability first; shortages go to Procurement."
                >
                  {(close) => (
                    <RecordForm
                      submitLabel="Add requirement"
                      fields={[
                        { name: "description", label: "Item", required: true, span: true },
                        { name: "unit", label: "Unit" },
                        { name: "planned_qty", label: "Planned quantity", type: "number" },
                        { name: "required_at", label: "Required by", type: "datetime-local" },
                      ]}
                      onSubmit={(values) =>
                        addStock.mutate({ ...values, booking_id: id }, { onSuccess: () => close() })
                      }
                    />
                  )}
                </FormDialog>
              ) : null
            }
          >
            <EventsQueryState
              isLoading={stock.isLoading}
              error={stock.error}
              isEmpty={(stock.data ?? []).length === 0}
              empty={
                <EventsEmpty
                  title="No stock requirements"
                  description="Add what this event needs from Stores."
                />
              }
            >
              <DataTable
                head={[
                  "Item",
                  "Unit",
                  "Planned",
                  "Reserved",
                  "Issued",
                  "Consumed",
                  "Returned",
                  "Wasted",
                  "Variance",
                  "Status",
                ]}
              >
                {((stock.data ?? []) as Row[]).map((r) => (
                  <tr key={String(r["id"])}>
                    <td className="py-2 pr-4">
                      {String(
                        r["description"] || (r["stock_items"] as Row | null)?.["name"] || "—",
                      )}
                    </td>
                    <td className="py-2 pr-4">{String(r["unit"])}</td>
                    <td className="py-2 pr-4">{num(r["planned_qty"])}</td>
                    <td className="py-2 pr-4">{num(r["reserved_qty"])}</td>
                    <td className="py-2 pr-4">{num(r["issued_qty"])}</td>
                    <td className="py-2 pr-4">{num(r["consumed_qty"])}</td>
                    <td className="py-2 pr-4">{num(r["returned_qty"])}</td>
                    <td className="py-2 pr-4">{num(r["wasted_qty"])}</td>
                    <td className="py-2 pr-4">{num(r["planned_qty"]) - num(r["consumed_qty"])}</td>
                    <td className="py-2 pr-4">
                      <Pill tone="info" value={String(r["status"])} />
                    </td>
                  </tr>
                ))}
              </DataTable>
            </EventsQueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="rooms" className="mt-4">
          <SectionCard
            title="Accommodation"
            description="Room blocks use the Front Office PMS as the single source of room inventory — no separate rooms are created here."
          >
            <EventsQueryState
              isLoading={rooms.isLoading}
              error={rooms.error}
              isEmpty={(rooms.data ?? []).length === 0}
              empty={
                <EventsEmpty
                  title="No room blocks"
                  description="Add a room block from Front Office to link accommodation to this event."
                />
              }
            >
              <DataTable
                head={[
                  "Room type",
                  "Blocked",
                  "Picked up",
                  "Occupancy",
                  "Arrival",
                  "Departure",
                  "Billing",
                  "Release",
                ]}
              >
                {((rooms.data ?? []) as Row[]).map((r) => (
                  <tr key={String(r["id"])}>
                    <td className="py-2 pr-4">
                      {String((r["room_types"] as Row | null)?.["name"] ?? "—")}
                    </td>
                    <td className="py-2 pr-4">{num(r["rooms_blocked"])}</td>
                    <td className="py-2 pr-4">{num(r["rooms_picked_up"])}</td>
                    <td className="py-2 pr-4">{titleCase(String(r["occupancy"]))}</td>
                    <td className="py-2 pr-4">{formatDate(r["arrival_date"])}</td>
                    <td className="py-2 pr-4">{formatDate(r["departure_date"])}</td>
                    <td className="py-2 pr-4">{titleCase(String(r["billing_route"]))}</td>
                    <td className="py-2 pr-4">{formatDate(r["release_date"])}</td>
                  </tr>
                ))}
              </DataTable>
            </EventsQueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="billing" className="mt-4 space-y-6">
          {canFinancials ? (
            <>
              {eventInvoice.data ? (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 p-3">
                  <span className="text-sm text-muted-foreground">
                    Invoice {eventInvoice.data.invoice_number ?? "issued"}
                    {eventInvoice.data.status ? ` · ${titleCase(eventInvoice.data.status)}` : ""}
                  </span>
                  <DocumentPrintButton
                    type="invoice"
                    id={eventInvoice.data.id}
                    label="View / Print Invoice"
                  />
                </div>
              ) : null}
              <SectionCard
                title="Event billing"
                description="One consolidated financial summary — it reuses the existing Finance numbering and folio architecture."
                actions={
                  can("events", "edit") ? (
                    <FormDialog
                      trigger={<Button size="sm">Add line</Button>}
                      title="Add billing line"
                      description="Discounts, complimentary items and price overrides require Approval Centre sign-off."
                    >
                      {(close) => (
                        <RecordForm
                          submitLabel="Add line"
                          fields={[
                            {
                              name: "description",
                              label: "Description",
                              required: true,
                              span: true,
                            },
                            { name: "category", label: "Category" },
                            { name: "quantity", label: "Quantity", type: "number" },
                            { name: "unit_price", label: "Unit price", type: "number" },
                            { name: "tax_rate", label: "Tax rate %", type: "number" },
                            { name: "is_complimentary", label: "Complimentary", type: "checkbox" },
                          ]}
                          onSubmit={(values) =>
                            addBilling.mutate(
                              {
                                ...values,
                                booking_id: id,
                                line_total: num(values["quantity"]) * num(values["unit_price"]),
                              },
                              { onSuccess: () => close() },
                            )
                          }
                        />
                      )}
                    </FormDialog>
                  ) : null
                }
              >
                <EventsQueryState
                  isLoading={billing.isLoading}
                  error={billing.error}
                  isEmpty={billingRows.length === 0}
                  empty={
                    <EventsEmpty
                      title="No billing lines"
                      description="Charges accumulate here as the event is planned and delivered."
                    />
                  }
                >
                  <DataTable
                    head={["Description", "Category", "Qty", "Unit price", "Line total", "Comp"]}
                  >
                    {billingRows.map((r) => (
                      <tr key={String(r["id"])}>
                        <td className="py-2 pr-4">{String(r["description"])}</td>
                        <td className="py-2 pr-4">{titleCase(String(r["category"]))}</td>
                        <td className="py-2 pr-4">{num(r["quantity"])}</td>
                        <td className="py-2 pr-4">{formatMoney(symbol, r["unit_price"])}</td>
                        <td className="py-2 pr-4">{formatMoney(symbol, r["line_total"])}</td>
                        <td className="py-2 pr-4">{r["is_complimentary"] ? "Yes" : "—"}</td>
                      </tr>
                    ))}
                  </DataTable>
                  <div className="mt-3 flex justify-end gap-6 text-sm">
                    <span className="text-muted-foreground">Charged</span>
                    <span className="font-semibold">
                      {formatMoney(
                        symbol,
                        billingRows.reduce((s, r) => s + num(r["line_total"]), 0),
                      )}
                    </span>
                  </div>
                </EventsQueryState>
              </SectionCard>
              <NotConfigured
                label="Payment gateway"
                note="No payment provider is connected, so deposits and balances are recorded manually against the existing Finance ledger."
              />
            </>
          ) : (
            <SectionCard title="Restricted" description="Financial permission required">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldAlert className="size-4" />
                Event financials are only visible with the{" "}
                <span className="font-mono text-xs">events.financials</span> permission.
              </p>
            </SectionCard>
          )}
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <SectionCard
            title="Activity history"
            description="Append-only event activity; sensitive actions also write to the central audit trail"
          >
            <EventsQueryState
              isLoading={activity.isLoading}
              error={activity.error}
              isEmpty={(activity.data ?? []).length === 0}
              empty={
                <EventsEmpty
                  title="No activity yet"
                  description="Confirmations, revisions and changes are recorded here."
                />
              }
            >
              <ol className="space-y-2">
                {((activity.data ?? []) as Row[]).map((a) => (
                  <li
                    key={String(a["id"])}
                    className="rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {titleCase(String(a["action"]).replace(/\./g, " "))}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(a["created_at"])}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </EventsQueryState>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
