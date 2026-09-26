/**
 * The shared state machine.
 *
 * Every significant record in NEØ — a reservation, a payment, a folio, a POS
 * order, a kitchen ticket, a goods receipt, a stock movement, a requisition, a
 * purchase order, a supplier invoice, an event booking, a work order — moves
 * through a named sequence of states. Until now each module owned its own
 * status vocabulary and wrote it directly, which is why Finance, PMS, Stores,
 * KDS, Events and room operations could each hold a different opinion about the
 * same transaction.
 *
 * This module is the single definition of those sequences: which states exist,
 * which transitions are legal, who owns the record at each state, and what the
 * next action is. It is pure and holds no queries — writing goes through
 * `canonical-state.ts`, which refuses a transition this file does not allow, and
 * persists it to `canonical_transaction_states` with its history row.
 *
 * Read models (dashboards, module pages, registers) project from that table
 * rather than deriving state locally, so agreement is structural, not a habit.
 */

export type EntityKind =
  | "reservation"
  | "payment"
  | "folio"
  | "pos_order"
  | "kds_ticket"
  | "grn"
  | "stock_movement"
  | "requisition"
  | "purchase_order"
  | "supplier_invoice"
  | "event_booking"
  | "work_order";

export type StateDefinition = {
  /** Canonical state token stored in `operational_state`. */
  state: string;
  label: string;
  /** States this one may legally move to. Empty means terminal. */
  next: readonly string[];
  /** Role or desk holding the record here. */
  owner: string;
  /** The single next required action, or null when nothing is owed. */
  nextAction: string | null;
  terminal?: boolean;
};

export type WorkflowDefinition = {
  kind: EntityKind;
  label: string;
  /** Posting module the canonical state row is filed under. */
  module: string;
  states: readonly StateDefinition[];
};

const s = (
  state: string,
  label: string,
  owner: string,
  nextAction: string | null,
  next: readonly string[],
): StateDefinition => ({ state, label, owner, nextAction, next, terminal: next.length === 0 });

/**
 * Cancellation and failure are legal from anywhere that is not terminal: an
 * operator abandoning work is a real transition, not an illegal one, and it
 * must be recorded rather than left as a stale in-flight state.
 */
export const UNIVERSAL_EXITS = ["cancelled", "failed"] as const;

const RESERVATION: WorkflowDefinition = {
  kind: "reservation",
  label: "Reservation",
  module: "pms",
  states: [
    s("enquiry", "Enquiry", "Reservations", "Confirm the booking", ["reserved"]),
    s("reserved", "Reserved", "Reservations", "Collect the deposit", ["deposit_held", "checked_in"]),
    s("deposit_held", "Deposit held", "Front Office", "Assign a room and check in", ["checked_in"]),
    s("checked_in", "Checked in", "Front Office", "Post charges to the folio", ["in_house"]),
    s("in_house", "In house", "Front Office", "Check the guest out", ["checked_out"]),
    s("checked_out", "Checked out", "Front Office", "Settle the folio", ["settled"]),
    s("settled", "Settled", "Finance", null, []),
    s("cancelled", "Cancelled", "Reservations", null, []),
    s("failed", "Failed", "Front Office", "Investigate and retry", ["reserved"]),
  ],
};

const PAYMENT: WorkflowDefinition = {
  kind: "payment",
  label: "Payment",
  module: "finance",
  states: [
    s("requested", "Requested", "Cashier", "Collect or confirm the payment", ["processing", "cancelled"]),
    s("processing", "Processing", "Cashier", "Await confirmation", ["captured", "failed"]),
    s("captured", "Captured", "Cashier", "Post to the ledger", ["posted", "reversed"]),
    s("posted", "Posted", "Finance", "Reconcile against the till", ["reconciled", "reversed"]),
    s("reconciled", "Reconciled", "Finance", null, []),
    s("reversed", "Reversed", "Finance", null, []),
    s("failed", "Failed", "Cashier", "Retry the collection", ["requested"]),
    s("cancelled", "Cancelled", "Cashier", null, []),
  ],
};

const FOLIO: WorkflowDefinition = {
  kind: "folio",
  label: "Folio",
  module: "pms",
  states: [
    s("open", "Open", "Front Office", "Post charges as they occur", ["charges_posted", "cancelled"]),
    s("charges_posted", "Charges posted", "Front Office", "Take settlement", ["settling"]),
    s("settling", "Settling", "Cashier", "Confirm the payment", ["settled", "failed"]),
    s("settled", "Settled", "Finance", "Close the folio", ["closed"]),
    s("closed", "Closed", "Finance", null, []),
    s("failed", "Failed", "Cashier", "Retry settlement", ["settling"]),
    s("cancelled", "Cancelled", "Front Office", null, []),
  ],
};

const POS_ORDER: WorkflowDefinition = {
  kind: "pos_order",
  label: "POS order",
  module: "pos",
  states: [
    s("draft", "Draft", "Waiter", "Send the order to the kitchen", ["sent", "cancelled"]),
    s("sent", "Sent", "Kitchen", "Prepare the items", ["ready", "failed"]),
    s("ready", "Ready", "Waiter", "Serve the guest", ["served"]),
    s("served", "Served", "Waiter", "Raise the bill", ["billed"]),
    s("billed", "Billed", "Cashier", "Take payment", ["paid"]),
    s("paid", "Paid", "Finance", "Post revenue to the ledger", ["posted"]),
    s("posted", "Posted", "Finance", null, []),
    s("failed", "Failed", "Kitchen", "Resolve routing and resend", ["draft"]),
    s("cancelled", "Cancelled", "Waiter", null, []),
  ],
};

const KDS_TICKET: WorkflowDefinition = {
  kind: "kds_ticket",
  label: "Kitchen ticket",
  module: "kitchen",
  states: [
    s("queued", "Queued", "Station", "Start preparation", ["preparing", "cancelled"]),
    s("preparing", "Preparing", "Station", "Mark ready when plated", ["ready", "failed"]),
    s("ready", "Ready", "Waiter", "Collect and serve", ["collected"]),
    s("collected", "Collected", "Waiter", null, []),
    s("failed", "Failed", "Kitchen Manager", "Requeue the ticket", ["queued"]),
    s("cancelled", "Cancelled", "Kitchen Manager", null, []),
  ],
};

const GRN: WorkflowDefinition = {
  kind: "grn",
  label: "Goods receipt",
  module: "procurement",
  states: [
    s("draft", "Draft", "Receiving Clerk", "Record accepted quantities", ["received", "cancelled"]),
    s("received", "Received", "Store Keeper", "Accept the goods into store", ["accepted"]),
    s("accepted", "Accepted", "Store Keeper", "Recognise inventory", ["inventory_recognised"]),
    s("inventory_recognised", "Inventory recognised", "Finance", "Post the GRNI accrual", ["posted"]),
    s("posted", "Posted", "Finance", "Match against the supplier invoice", ["matched", "reversed"]),
    s("matched", "Matched", "Finance", null, []),
    s("reversed", "Reversed", "Finance", null, []),
    s("failed", "Failed", "Finance", "Resolve the posting error and retry", ["accepted"]),
    s("cancelled", "Cancelled", "Receiving Clerk", null, []),
  ],
};

const STOCK_MOVEMENT: WorkflowDefinition = {
  kind: "stock_movement",
  label: "Stock movement",
  module: "inventory",
  states: [
    s("pending", "Pending", "Store Keeper", "Confirm the movement", ["recorded", "cancelled"]),
    s("recorded", "Recorded", "Store Keeper", "Post the valuation", ["posted", "reversed"]),
    s("posted", "Posted", "Finance", null, []),
    s("reversed", "Reversed", "Store Keeper", null, []),
    s("failed", "Failed", "Store Keeper", "Investigate and re-record", ["pending"]),
    s("cancelled", "Cancelled", "Store Keeper", null, []),
  ],
};

const REQUISITION: WorkflowDefinition = {
  kind: "requisition",
  label: "Requisition",
  module: "inventory",
  states: [
    s("draft", "Draft", "Department", "Submit to Stores", ["submitted", "cancelled"]),
    s("submitted", "Submitted", "Store Keeper", "Reserve stock or raise a shortage", [
      "reserved",
      "shortage",
      "rejected",
    ]),
    s("reserved", "Reserved", "Store Keeper", "Issue the stock", ["issued"]),
    s("shortage", "Shortage", "Store Keeper", "Raise a purchase request or part-issue", ["reserved", "issued"]),
    s("issued", "Issued", "Department", "Acknowledge receipt at destination", ["received", "failed"]),
    s("received", "Received", "Department", null, []),
    s("rejected", "Rejected", "Department", null, []),
    s("failed", "Failed", "Store Keeper", "Re-issue or reverse", ["reserved"]),
    s("cancelled", "Cancelled", "Department", null, []),
  ],
};

const PURCHASE_ORDER: WorkflowDefinition = {
  kind: "purchase_order",
  label: "Purchase order",
  module: "procurement",
  states: [
    s("draft", "Draft", "Procurement", "Submit for approval", ["pending_approval", "cancelled"]),
    s("pending_approval", "Pending approval", "Approver", "Approve or decline", ["approved", "rejected"]),
    s("approved", "Approved", "Procurement", "Issue the order to the supplier", ["issued"]),
    s("issued", "Issued", "Supplier", "Receive the goods", ["partially_received", "received"]),
    s("partially_received", "Partially received", "Receiving Clerk", "Receive the balance", ["received", "closed"]),
    s("received", "Received", "Procurement", "Close the order", ["closed"]),
    s("closed", "Closed", "Procurement", null, []),
    s("rejected", "Rejected", "Procurement", null, []),
    s("failed", "Failed", "Procurement", "Reissue the order", ["approved"]),
    s("cancelled", "Cancelled", "Procurement", null, []),
  ],
};

const SUPPLIER_INVOICE: WorkflowDefinition = {
  kind: "supplier_invoice",
  label: "Supplier invoice",
  module: "finance",
  states: [
    s("captured", "Captured", "Finance", "Match against order and receipt", ["matching", "cancelled"]),
    s("matching", "Matching", "Accountant", "Resolve variances", ["matched", "held"]),
    s("held", "Held", "Finance Manager", "Approve the variance or reject", ["matched", "rejected"]),
    s("matched", "Matched", "Finance Manager", "Approve the payable", ["approved"]),
    s("approved", "Approved", "Finance Manager", "Schedule the payment", ["scheduled"]),
    s("scheduled", "Scheduled", "Finance Manager", "Release the payment", ["released"]),
    s("released", "Released", "Finance", "Confirm settlement", ["paid", "failed"]),
    s("paid", "Paid", "Finance", "Post the journal", ["journalled"]),
    s("journalled", "Journalled", "Finance", null, []),
    s("rejected", "Rejected", "Finance", null, []),
    s("failed", "Failed", "Finance", "Retry the release", ["scheduled"]),
    s("cancelled", "Cancelled", "Finance", null, []),
  ],
};

const EVENT_BOOKING: WorkflowDefinition = {
  kind: "event_booking",
  label: "Event",
  module: "events",
  states: [
    s("enquiry", "Enquiry", "Sales & Events", "Prepare a quotation", ["quoted", "cancelled"]),
    s("quoted", "Quoted", "Sales & Events", "Confirm the booking", ["booked", "lost"]),
    s("booked", "Booked", "Sales & Events", "Collect the deposit", ["deposit_held"]),
    s("deposit_held", "Deposit held", "Departments", "Confirm departmental readiness", ["ready"]),
    s("ready", "Ready", "Sales & Events", "Deliver the event", ["delivered"]),
    s("delivered", "Delivered", "Finance", "Raise the invoice", ["invoiced"]),
    s("invoiced", "Invoiced", "Finance", "Collect payment", ["paid"]),
    s("paid", "Paid", "Finance", null, []),
    s("lost", "Lost", "Sales & Events", null, []),
    s("failed", "Failed", "Sales & Events", "Re-confirm the booking", ["booked"]),
    s("cancelled", "Cancelled", "Sales & Events", null, []),
  ],
};

const WORK_ORDER: WorkflowDefinition = {
  kind: "work_order",
  label: "Work order",
  module: "maintenance",
  states: [
    s("reported", "Fault reported", "Maintenance Manager", "Take the room out of order if needed", [
      "out_of_order",
      "assigned",
      "cancelled",
    ]),
    s("out_of_order", "Out of order", "Maintenance Manager", "Assign an officer", ["assigned"]),
    s("assigned", "Assigned", "Maintenance Officer", "Carry out the repair", ["in_repair"]),
    s("in_repair", "In repair", "Maintenance Officer", "Submit for inspection", ["inspection", "failed"]),
    s("inspection", "Inspection", "Maintenance Manager", "Pass or return the work", ["cleared", "in_repair"]),
    s("cleared", "Cleared", "Housekeeping", "Release the room to ready", ["ready"]),
    s("ready", "Ready", "Front Office", null, []),
    s("failed", "Failed", "Maintenance Manager", "Reassign the work", ["assigned"]),
    s("cancelled", "Cancelled", "Maintenance Manager", null, []),
  ],
};

export const WORKFLOWS: Record<EntityKind, WorkflowDefinition> = {
  reservation: RESERVATION,
  payment: PAYMENT,
  folio: FOLIO,
  pos_order: POS_ORDER,
  kds_ticket: KDS_TICKET,
  grn: GRN,
  stock_movement: STOCK_MOVEMENT,
  requisition: REQUISITION,
  purchase_order: PURCHASE_ORDER,
  supplier_invoice: SUPPLIER_INVOICE,
  event_booking: EVENT_BOOKING,
  work_order: WORK_ORDER,
};

export const ENTITY_KINDS = Object.keys(WORKFLOWS) as EntityKind[];

export const normaliseState = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

export function workflowFor(kind: EntityKind): WorkflowDefinition {
  return WORKFLOWS[kind];
}

export function stateDefinition(kind: EntityKind, state: string): StateDefinition | null {
  const token = normaliseState(state);
  return WORKFLOWS[kind].states.find((d) => d.state === token) ?? null;
}

export function isKnownState(kind: EntityKind, state: string): boolean {
  return stateDefinition(kind, state) !== null;
}

/** The first state of a workflow — where a newly created record starts. */
export function initialState(kind: EntityKind): string {
  return WORKFLOWS[kind].states[0]!.state;
}

export function allowedTransitions(kind: EntityKind, from: string): readonly string[] {
  const def = stateDefinition(kind, from);
  if (!def) return [];
  if (def.terminal) return [];
  const exits = UNIVERSAL_EXITS.filter(
    (exit) => isKnownState(kind, exit) && !def.next.includes(exit) && exit !== def.state,
  );
  return [...def.next, ...exits];
}

export function transitionAllowed(kind: EntityKind, from: string, to: string): boolean {
  const target = normaliseState(to);
  if (normaliseState(from) === target) return true; // idempotent replay of the same state
  return allowedTransitions(kind, from).includes(target);
}

/**
 * Modules must not set a status directly. They ask for a transition, and an
 * illegal one fails loudly here rather than quietly leaving two modules
 * disagreeing about the same record.
 */
export function assertTransition(kind: EntityKind, from: string, to: string): void {
  if (!isKnownState(kind, to)) {
    throw new Error(`${WORKFLOWS[kind].label}: "${to}" is not a state of this workflow.`);
  }
  if (!transitionAllowed(kind, from, to)) {
    const legal = allowedTransitions(kind, from);
    throw new Error(
      `${WORKFLOWS[kind].label}: cannot move from "${normaliseState(from)}" to "${normaliseState(to)}".` +
        (legal.length ? ` Allowed from here: ${legal.join(", ")}.` : " This state is final."),
    );
  }
}

export function nextActionFor(kind: EntityKind, state: string): string | null {
  return stateDefinition(kind, state)?.nextAction ?? null;
}

export function ownerFor(kind: EntityKind, state: string): string | null {
  return stateDefinition(kind, state)?.owner ?? null;
}

export function isTerminal(kind: EntityKind, state: string): boolean {
  return stateDefinition(kind, state)?.terminal === true;
}

/**
 * The identity every canonical record must carry. A record missing any of
 * these cannot be traced, reconciled or safely retried, so the write path
 * refuses it instead of persisting a half-identified transaction.
 */
export type CanonicalFacts = {
  kind: EntityKind;
  /** Immutable source record id. */
  sourceId: string;
  organizationId: string;
  branchId: string | null;
  reference: string | null;
  state: string;
  actorId: string | null;
  idempotencyKey: string;
  amount?: number | null;
  currency?: string | null;
  /** Downstream handoffs raised by this record, keyed by handoff name. */
  downstream?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  blocker?: string | null;
};

export const REQUIRED_FACTS = [
  "sourceId",
  "organizationId",
  "state",
  "idempotencyKey",
] as const satisfies readonly (keyof CanonicalFacts)[];

export function missingCanonicalFacts(facts: Partial<CanonicalFacts>): string[] {
  const missing = REQUIRED_FACTS.filter((key) => {
    const value = facts[key];
    return value === null || value === undefined || String(value).trim() === "";
  }).map(String);
  if (facts.kind && facts.state && !isKnownState(facts.kind, facts.state)) missing.push("state");
  return [...new Set(missing)];
}
