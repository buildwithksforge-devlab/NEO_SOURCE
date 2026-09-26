import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventSourceKey, newEventAttemptKey } from "@/lib/events-data";

/**
 * Contract tests for the corrective Events migration. The fixture is dumped
 * from the deployed database (function definitions, policies, constraints and
 * triggers), so these assertions fail if deployment drifts from the promised
 * contract.
 */
const SQL = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/events-contract.sql"), "utf8");
const DATA_LAYER = readFileSync(join(process.cwd(), "src/lib/events-data.ts"), "utf8");
const BOOKINGS_UI = readFileSync(join(process.cwd(), "src/routes/_shell.events.bookings.index.tsx"), "utf8");
const LEDGER = readFileSync(join(process.cwd(), "docs/repair/final-consolidated-repair-ledger.md"), "utf8");

const policy = (table: string, cmd: string): string[] =>
  SQL.split("\n").filter((l) => l.includes(`ON public.${table} FOR ${cmd}`));

describe("events idempotency and numbering contract", () => {
  it("keys retries per tenant, not globally", () => {
    expect(SQL).toContain("PRIMARY KEY (organization_id, key) -- event_booking_idempotency");
  });

  it("enforces one reference per property", () => {
    expect(SQL).toMatch(/UNIQUE INDEX event_bookings_org_branch_reference_key[\s\S]*organization_id, branch_id, event_reference/);
  });

  it("allocates the reference server-side and never trusts a client reference", () => {
    const create = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_booking_create"));
    expect(create).toContain("next_document_number('event_booking', 'EVT', v_branch)");
    expect(create).not.toContain("_payload->>'event_reference'");
    expect(DATA_LAYER).toContain("event_reference: _ignoredReference");
  });

  it("requires a submission token for every client creation", () => {
    const create = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_booking_create"));
    expect(create).toContain("nullif(btrim(coalesce(_payload->>'idempotency_key', '')), '')");
    expect(create).toMatch(/v_idem IS NULL[\s\S]{0,200}RAISE EXCEPTION/);
    expect(DATA_LAYER).toContain("idempotency_key: idempotencyKey");
  });

  it("issues a fresh token per form attempt and reuses it across retries of that attempt", () => {
    // Two attempts must never collide, even with byte-identical event details.
    const first = newEventAttemptKey();
    const second = newEventAttemptKey();
    expect(first).not.toBe(second);
    // The hook holds one token for the attempt, and rotates only deliberately.
    expect(DATA_LAYER).toContain("export function useEventAttemptKey()");
    expect(DATA_LAYER).toContain("const reset = useCallback(() => setKey(newEventAttemptKey()), []);");
    expect(BOOKINGS_UI).toContain("idempotency_key: attempt.key");
    expect(BOOKINGS_UI).toMatch(/onSuccess: \(\) => \{[\s\S]{0,120}attempt\.reset\(\);/);
    expect(BOOKINGS_UI).toMatch(/onOpenChange=\{\(open\) => \{[\s\S]{0,200}attempt\.reset\(\);/);
  });

  it("keys each conversion to its source record so a retry cannot duplicate", () => {
    // A source converts exactly once, so a source-derived key is correct there.
    expect(DATA_LAYER).toContain('eventSourceKey("enquiry", enquiryId)');
    expect(DATA_LAYER).toContain('eventSourceKey("quotation", quotationId)');
    expect(eventSourceKey("enquiry", "abc")).toBe("enquiry:abc");
  });

  it("serialises concurrent creations on the tenant and key before checking", () => {
    const create = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_booking_create"));
    const lockAt = create.indexOf("pg_advisory_xact_lock");
    const lookupAt = create.indexOf("FROM public.event_booking_idempotency i");
    const insertAt = create.indexOf("INSERT INTO public.event_bookings");
    expect(lockAt).toBeGreaterThan(-1);
    // The lock is taken BEFORE the existence check and before any insert, so a
    // second concurrent call waits and then returns the first call's event.
    expect(lockAt).toBeLessThan(lookupAt);
    expect(lookupAt).toBeLessThan(insertAt);
    expect(create).toContain("hashtextextended('neo_event_booking_create:' || v_org::text || ':' || v_idem, 0)");
  });
});

describe("events creation validation contract", () => {
  const create = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_booking_create"));

  it.each([
    ["An event name is required."],
    ["An event date is required."],
    ["A start time and an end time are required."],
    ["The event must end after it starts."],
    ["The selected property is not an active property in this workspace."],
    ["The selected event type does not belong to this workspace."],
    ["The selected customer does not belong to this workspace."],
    ["The selected corporate account does not belong to this workspace."],
    ["The selected coordinator does not belong to this workspace."],
    ["The selected venue is not available at this property."],
    ["The linked quotation belongs to a different property."],
    ["The linked enquiry belongs to a different property."],
  ])("rejects invalid input: %s", (message) => {
    expect(create).toContain(message);
  });

  it("requires the create capability and property scope", () => {
    expect(create).toContain("has_permission('events'::text, 'bookings'::text, 'create'::text)");
    expect(create).toContain("neo_branch_in_scope(v_branch)");
  });
});

describe("events dependency property enforcement", () => {
  it.each([
    "event_requirements",
    "event_menus",
    "event_milestones",
    "event_vendors",
    "event_change_requests",
    "event_guest_counts",
  ])("inherits and validates the parent event on %s", (table) => {
    expect(SQL).toContain(`tg_neo_event_dependency ON ${table}`);
  });

  it("inherits branch on event_room_blocks", () => {
    expect(SQL).toContain("tg_neo_event_child_branch ON event_room_blocks");
  });

  it("scopes reservations through the booking, or the resource when there is no booking", () => {
    expect(SQL).toContain("tg_neo_event_reservation_guard ON event_resource_reservations");
    const guard = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_reservation_guard"));
    expect(guard).toContain("The selected resource belongs to a different property than the event.");
    expect(guard).toContain("A reservation must reference an event or a resource.");
  });

  it.each(["event_menu_items", "event_quotation_items", "event_package_items"])(
    "scopes %s through its parent record",
    (table) => {
      expect(SQL).toContain(`tg_neo_event_grandchild ON ${table}`);
    },
  );

  it.each(["event_documents", "event_activity_logs"])("scopes %s through the event or enquiry", (table) => {
    expect(SQL).toContain(`tg_neo_event_trace ON ${table}`);
  });

  it("rejects cross-organisation relationships everywhere", () => {
    expect(SQL).toContain("This record belongs to a different organisation than its event.");
    expect(SQL).toContain("This line belongs to a different organisation than its parent record.");
    expect(SQL).toContain("The event and the enquiry belong to different organisations.");
  });
});

describe("events feature-level backend authorisation", () => {
  it.each([
    ["event_bookings", "bookings", "view"],
    ["event_enquiries", "enquiries", "view"],
    ["event_quotations", "quotations", "view"],
    ["event_venues", "venues", "view"],
    ["event_resources", "resources", "view"],
    ["event_packages", "packages", "view"],
    ["event_billing_items", "billing", "view"],
    ["event_department_requirements", "readiness", "view"],
    ["event_feedback", "feedback", "view"],
  ])("%s reads require events.%s.%s", (table, feature, action) => {
    const rows = policy(table, "SELECT");
    expect(rows.length, `${table} needs a staff read policy`).toBeGreaterThan(0);
    expect(rows.join("\n")).toContain(`'${feature}'::text, '${action}'::text`);
  });

  it.each(["event_bookings", "event_enquiries", "event_quotations", "event_venues", "event_packages", "event_resources"])(
    "%s writes are permission checked, not merely branch scoped",
    (table) => {
      const inserts = policy(table, "INSERT").join("\n");
      expect(inserts).toContain("has_permission('events'::text");
      const updates = policy(table, "UPDATE").join("\n");
      expect(updates).toContain("has_permission('events'::text");
    },
  );

  it("keeps event types organisation-wide", () => {
    expect(policy("event_types", "SELECT").join("\n")).toContain("current_org_id()");
  });

  it("keeps event_packages property scoped", () => {
    expect(policy("event_packages", "SELECT").join("\n")).toContain("neo_branch_in_scope");
  });
});

describe("events rollup redaction", () => {
  const ws = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_workspace"));

  it("requires bookings.view to read the workspace at all", () => {
    expect(ws).toContain("The events.bookings.view permission is required.");
  });

  it.each([
    ["billing", "v_financial"],
    ["readiness", "v_readiness"],
    ["resources", "v_resources"],
    ["feedback", "v_feedback"],
  ])("redacts the %s rollup without its permission", (feature, flag) => {
    expect(ws).toContain(`${flag} boolean := public.has_permission('events', '${feature}', 'view')`);
    expect(ws).toContain(`CASE WHEN ${flag} THEN`);
  });

  it("exposes a thin billing projection gated on events.billing.view", () => {
    const billing = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_billing"));
    expect(billing).toContain("The events.billing.view permission is required.");
    expect(billing).toContain("neo_branch_in_scope");
    expect(DATA_LAYER).toContain('guardedRpc(db, "neo_event_billing"');
  });

  it("keeps event_bookings as the one canonical event entity", () => {
    const billing = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_billing"));
    expect(billing).toContain("FROM event_bookings b");
  });
});

describe("events transfer coverage", () => {
  const transfer = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_booking_transfer"));

  it("requires the transfer capability, a reason and scope on both properties", () => {
    expect(transfer).toContain("The events.bookings.transfer permission is required.");
    expect(transfer).toContain("A reason is required to transfer an event to another property.");
    expect(transfer).toContain("Both the current and destination property must be within your access scope.");
  });

  it.each([
    "event_billing_items",
    "event_department_requirements",
    "banquet_event_orders",
    "event_feedback",
    "venue_blocks",
    "event_room_blocks",
  ])("moves %s with the event", (table) => {
    expect(transfer).toContain(`UPDATE public.${table} SET branch_id = _branch`);
  });

  it("releases incompatible venue, resource and room holds and records them", () => {
    expect(transfer).toContain("released on property transfer");
    expect(transfer).toContain("resource_reservations_released");
    expect(transfer).toContain("room_blocks_released");
    expect(transfer).toContain("events.booking.transferred");
  });

  it("resolves a reference collision at the destination audibly", () => {
    expect(transfer).toContain("old_reference");
    expect(transfer).toContain("new_reference");
    expect(transfer).toContain("reference_reallocated");
    // A colliding reference is renumbered for the destination property.
    expect(transfer).toMatch(/next_document_number\('event_booking', 'EVT', _branch\)/);
    expect(DATA_LAYER).toContain("reference_reallocated");
  });
});

describe("events cross-property trace contract", () => {
  const guard = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_trace_guard"));

  it("rejects a trace that links an event and an enquiry at different properties", () => {
    expect(guard).toContain("v_booking_branch");
    expect(guard).toContain("v_enquiry_branch");
    expect(guard).toMatch(/v_booking_branch <> v_enquiry_branch[\s\S]{0,200}RAISE EXCEPTION/);
  });
});

describe("transfer preserves the same-property invariant for future moves", () => {
  const transfer = SQL.slice(SQL.indexOf("FUNCTION public.neo_event_booking_transfer"));

  it("refuses a destination property that is not active", () => {
    expect(transfer).toMatch(/AND active\)[\s\S]{0,120}The destination property is not active\./);
  });

  it("detaches an incompatible enquiry and quotation instead of moving or deleting them", () => {
    // The source records themselves are never re-branded or removed.
    expect(transfer).not.toMatch(/UPDATE public\.event_enquiries SET branch_id/);
    expect(transfer).not.toMatch(/UPDATE public\.event_quotations SET branch_id/);
    expect(transfer).not.toMatch(/DELETE FROM public\.event_(enquiries|quotations|billing_items)/);
    expect(transfer).toContain("v_detached_enquiry := v_enquiry;");
    expect(transfer).toContain("v_detached_quotation := v_quotation;");
    expect(transfer).toContain("enquiry_id = CASE WHEN v_detached_enquiry IS NOT NULL THEN NULL ELSE enquiry_id END");
    expect(transfer).toContain("quotation_id = CASE WHEN v_detached_quotation IS NOT NULL THEN NULL ELSE quotation_id END");
  });

  it("keeps a compatible source linked", () => {
    // Detachment is conditional on the source sitting at a different property.
    expect(transfer).toMatch(/FROM public\.event_enquiries e\s*\n\s*WHERE e\.id = v_enquiry AND e\.branch_id IS DISTINCT FROM _branch/);
    expect(transfer).toMatch(/FROM public\.event_quotations q\s*\n\s*WHERE q\.id = v_quotation AND q\.branch_id IS DISTINCT FROM _branch/);
  });

  it("keeps history and documents on the event and clears only the incompatible enquiry link", () => {
    expect(transfer).toMatch(/UPDATE public\.event_activity_logs l\s*\n\s*SET enquiry_id = NULL[\s\S]{0,320}l\.booking_id = _booking/);
    expect(transfer).toMatch(/UPDATE public\.event_documents d\s*\n\s*SET enquiry_id = NULL[\s\S]{0,320}d\.booking_id = _booking/);
    expect(transfer).not.toMatch(/UPDATE public\.event_(activity_logs|documents)[\s\S]{0,120}SET booking_id = NULL/);
    expect(transfer).toContain("GET DIAGNOSTICS v_traces_detached = ROW_COUNT;");
    expect(transfer).toContain("GET DIAGNOSTICS v_documents_detached = ROW_COUNT;");
  });

  it("runs the detachments inside the same transfer statement block, before the immutable log row", () => {
    const traceAt = transfer.indexOf("v_traces_detached = ROW_COUNT");
    const logAt = transfer.indexOf("INSERT INTO public.event_activity_logs (organization_id");
    expect(traceAt).toBeGreaterThan(-1);
    expect(traceAt).toBeLessThan(logAt);
  });

  it("records every detachment in the transfer activity detail and the return payload", () => {
    for (const key of ["detached_enquiry_id", "detached_quotation_id", "traces_detached", "documents_detached"]) {
      // Once in the immutable activity detail, once in the returned payload.
      expect(transfer.split(`'${key}'`).length - 1).toBe(2);
    }
  });
});



describe("Zawadi Springs preservation statement", () => {
  it("states exactly two Zawadi events with their preserved values", () => {
    expect(LEDGER).toContain("exactly two Zawadi Springs event bookings");
    expect(LEDGER).toContain("EVT-3001");
    expect(LEDGER).toContain("1,071,840");
    expect(LEDGER).toContain("535,920");
    expect(LEDGER).toContain("2026-09-07");
    expect(LEDGER).toContain("EVT-3002");
    expect(LEDGER).toContain("1,633,280");
    expect(LEDGER).toContain("2026-10-01");
  });

  it("no longer claims eight Zawadi events", () => {
    expect(LEDGER).not.toContain("all 8 Zawadi events");
  });
});
