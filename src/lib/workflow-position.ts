/**
 * Where a record stands, who holds it, and what happens next.
 *
 * A status word on its own ("Scheduled", "Accepted", "Blocked") tells an
 * operator nothing they can act on. It does not say whose desk the record is
 * on, what the next move is, whether they are allowed to make it, why it is
 * stuck, or what it will do to the ledger. Every conveyor in NEØ — guest money
 * and procurement alike — answers those questions the same way, from here.
 *
 * This module is a pure reader over records the modules already hold. It
 * decides nothing and writes nothing: authority still lives in RLS and the
 * authenticated RPCs, and a permitted role listed here is a statement of who
 * the workflow expects, not a grant. The UI asks `permittedRoles`/`permission`
 * only to decide what to *offer*; the database still decides what happens.
 */

export type ConveyorKey =
  | "guest-money"
  | "procurement-ap"
  | "maintenance"
  | "stores-issue";

export type WorkflowPosition = {
  conveyor: ConveyorKey;
  /** Ordered stage list for this conveyor, so progress is visible. */
  stages: readonly string[];
  /** Current stage — always one of `stages`. */
  stage: string;
  stageIndex: number;
  /** Plain-language owner, e.g. "Finance Manager". */
  owner: string;
  /** Role that owns the stage. */
  owningRole: string;
  /** The action that got it here, if known. */
  previousAction: string | null;
  /** The single next required action, or null when the record is finished. */
  nextAction: string | null;
  /** Roles the workflow expects to perform `nextAction`. */
  permittedRoles: readonly string[];
  /** Capability the UI should check before offering the action. */
  permission: { module: string; feature: string; action: string } | null;
  /** Precise reason the next action cannot be taken yet, or null. */
  blocker: string | null;
  /** What the next action will do to the books. */
  financialConsequence: string | null;
  /** Terminal records need no owner prompt. */
  complete: boolean;
};

/** Related record an operator should be able to click through to. */
export type RelatedReference = {
  label: string;
  value: string;
  to?: string;
};

const FINANCE_MANAGER = "Finance Manager";
const ACCOUNTANT = "Accountant";
const OWNER = "Owner/Director";

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

// ---------------------------------------------------------------------------
// Procurement and AP
// ---------------------------------------------------------------------------

export const PROCUREMENT_STAGES = [
  "Requisition",
  "Approved",
  "PO issued",
  "GRN accepted",
  "Inventory recognised",
  "GRNI posted",
  "Invoice captured",
  "Matched",
  "AP approved",
  "Payment scheduled",
  "Payment approved",
  "Released",
  "Paid",
  "Journalised",
] as const;

export type SupplierPaymentRecord = {
  status?: string | null;
  amount?: number | null;
  journal_id?: string | null;
  approved_by?: string | null;
  released_by?: string | null;
  requested_by?: string | null;
  invoice_id?: string | null;
  supplier_id?: string | null;
  hold_reason?: string | null;
  scheduled_date?: string | null;
};

/**
 * A scheduled payment is not a paid one.
 *
 * Scheduling only states an intention; approval and release are separate
 * human acts, and only settlement writes the journal. Each of those three is
 * a distinct stage with its own owner so a payment cannot drift from "we mean
 * to pay this" to "the supplier has been paid" without someone standing
 * behind it.
 */
export function supplierPaymentPosition(row: SupplierPaymentRecord): WorkflowPosition {
  const status = norm(row.status);
  const held = (row.hold_reason ?? "").trim() || null;
  const base = {
    conveyor: "procurement-ap" as const,
    stages: PROCUREMENT_STAGES,
    owningRole: FINANCE_MANAGER,
    owner: FINANCE_MANAGER,
    permittedRoles: [FINANCE_MANAGER, OWNER],
    complete: false,
  };

  switch (status) {
    case "draft":
    case "scheduled":
      return {
        ...base,
        stage: "Payment scheduled",
        stageIndex: PROCUREMENT_STAGES.indexOf("Payment scheduled"),
        owner: ACCOUNTANT,
        owningRole: ACCOUNTANT,
        previousAction: "Payment scheduled against a matched invoice",
        nextAction: "Submit for approval",
        permittedRoles: [ACCOUNTANT, FINANCE_MANAGER, OWNER],
        permission: { module: "finance", feature: "ap", action: "edit" },
        blocker: held ?? (row.invoice_id ? null : "No supplier invoice is linked to this payment."),
        financialConsequence: "None yet — scheduling does not move money or post a journal.",
      };
    case "awaiting_approval":
    case "submitted":
    case "pending_approval":
      return {
        ...base,
        stage: "Payment scheduled",
        stageIndex: PROCUREMENT_STAGES.indexOf("Payment scheduled"),
        previousAction: "Submitted for approval",
        nextAction: "Approve payment",
        permission: { module: "finance", feature: "payment", action: "approve" },
        blocker: held,
        financialConsequence: "Approval authorises release; still no ledger entry.",
      };
    case "approved":
      return {
        ...base,
        stage: "Payment approved",
        stageIndex: PROCUREMENT_STAGES.indexOf("Payment approved"),
        previousAction: `Approved${row.approved_by ? "" : ""}`,
        nextAction: "Release for payment",
        permission: { module: "finance", feature: "payment", action: "approve" },
        blocker: held,
        financialConsequence: "Release commits the funds to the supplier's payment run.",
      };
    case "released":
      return {
        ...base,
        stage: "Released",
        stageIndex: PROCUREMENT_STAGES.indexOf("Released"),
        previousAction: "Released for payment",
        nextAction: "Confirm payment made",
        permission: { module: "finance", feature: "payment", action: "approve" },
        blocker: held,
        financialConsequence: "Settlement clears the payable and reduces the bank balance.",
      };
    case "paid":
    case "settled":
      return {
        ...base,
        stage: row.journal_id ? "Journalised" : "Paid",
        stageIndex: PROCUREMENT_STAGES.indexOf(row.journal_id ? "Journalised" : "Paid"),
        previousAction: "Payment settled",
        nextAction: row.journal_id ? null : "Post the payment journal",
        permission: row.journal_id ? null : { module: "finance", feature: "journals", action: "post" },
        blocker: row.journal_id ? null : "The settlement journal has not been written yet.",
        financialConsequence: row.journal_id
          ? "Payable cleared and bank reduced."
          : "Pending — the payable is not yet cleared in the ledger.",
        complete: Boolean(row.journal_id),
      };
    case "failed":
    case "rejected":
    case "cancelled":
      return {
        ...base,
        stage: "Payment scheduled",
        stageIndex: PROCUREMENT_STAGES.indexOf("Payment scheduled"),
        previousAction: status === "rejected" ? "Approval refused" : "Payment attempt failed",
        nextAction: "Review and reschedule",
        permission: { module: "finance", feature: "ap", action: "edit" },
        blocker: held ?? "The payment did not complete and needs a decision.",
        financialConsequence: "None — no journal was written.",
      };
    default:
      return {
        ...base,
        stage: "Payment scheduled",
        stageIndex: PROCUREMENT_STAGES.indexOf("Payment scheduled"),
        previousAction: null,
        nextAction: "Confirm the payment's status",
        permission: { module: "finance", feature: "ap", action: "edit" },
        blocker: `Unrecognised payment status "${row.status ?? "none"}".`,
        financialConsequence: null,
      };
  }
}

export type SupplierInvoiceRecord = {
  status?: string | null;
  match_status?: string | null;
  hold_reason?: string | null;
  grn_id?: string | null;
  po_id?: string | null;
  matched_amount?: number | null;
  total_amount?: number | null;
  journal_id?: string | null;
};

export function supplierInvoicePosition(row: SupplierInvoiceRecord): WorkflowPosition {
  const status = norm(row.status);
  const match = norm(row.match_status);
  const held = (row.hold_reason ?? "").trim() || null;
  const base = {
    conveyor: "procurement-ap" as const,
    stages: PROCUREMENT_STAGES,
    owner: ACCOUNTANT,
    owningRole: ACCOUNTANT,
    permittedRoles: [ACCOUNTANT, FINANCE_MANAGER, OWNER],
    complete: false,
  };

  if (status === "held" || held) {
    return {
      ...base,
      stage: "Matched",
      stageIndex: PROCUREMENT_STAGES.indexOf("Matched"),
      previousAction: "Three-way match attempted",
      nextAction: "Resolve the matching exception",
      owner: FINANCE_MANAGER,
      owningRole: FINANCE_MANAGER,
      permittedRoles: [FINANCE_MANAGER, OWNER],
      permission: { module: "finance", feature: "ap", action: "edit" },
      blocker: held ?? "The invoice is held outside tolerance.",
      financialConsequence: "No payable is raised while the invoice is held.",
    };
  }

  if (status === "accepted" || status === "matched" || status === "approved") {
    return {
      ...base,
      stage: row.journal_id ? "AP approved" : "Matched",
      stageIndex: PROCUREMENT_STAGES.indexOf(row.journal_id ? "AP approved" : "Matched"),
      previousAction: "Invoice accepted against the receipt",
      nextAction: row.journal_id ? "Schedule payment" : "Post the payable",
      owner: FINANCE_MANAGER,
      owningRole: FINANCE_MANAGER,
      permittedRoles: [FINANCE_MANAGER, OWNER],
      permission: { module: "finance", feature: "ap", action: "create" },
      blocker: null,
      financialConsequence: row.journal_id
        ? "Payable is on the ledger and awaiting a payment run."
        : "Posting clears GRNI and raises the supplier payable with VAT.",
    };
  }

  return {
    ...base,
    stage: "Invoice captured",
    stageIndex: PROCUREMENT_STAGES.indexOf("Invoice captured"),
    previousAction: "Invoice captured by Finance",
    nextAction: match === "matched" ? "Accept the invoice" : "Run the three-way match",
    permission: { module: "finance", feature: "ap", action: "edit" },
    blocker: row.grn_id
      ? null
      : "No goods receipt is linked, so the invoice cannot be matched three ways.",
    financialConsequence: "Matching decides whether a payable may be raised.",
  };
}

export type GrnRecord = {
  status?: string | null;
  posting_status?: string | null;
  journal_id?: string | null;
  po_id?: string | null;
};

/**
 * Operationally "Posted" and financially "Posted" are different claims.
 *
 * A storekeeper accepting goods completes a receipt; it does not write a
 * journal. Keeping the two apart is what stops a GRN that Finance has never
 * seen from being reported as recognised.
 */
export function grnPosition(row: GrnRecord): WorkflowPosition {
  const status = norm(row.status);
  const posting = norm(row.posting_status);
  const financePosted = posting === "posted" || Boolean(row.journal_id);
  const base = {
    conveyor: "procurement-ap" as const,
    stages: PROCUREMENT_STAGES,
    complete: false,
  };

  if (status === "draft" || status === "pending" || !status) {
    return {
      ...base,
      stage: "PO issued",
      stageIndex: PROCUREMENT_STAGES.indexOf("PO issued"),
      owner: "Storekeeper",
      owningRole: "Storekeeper",
      previousAction: "Purchase order issued to the supplier",
      nextAction: "Receive and accept the delivery",
      permittedRoles: ["Storekeeper", "Stores Manager", OWNER],
      permission: { module: "inventory", feature: "grn", action: "create" },
      blocker: row.po_id ? null : "This receipt is not linked to a purchase order.",
      financialConsequence: "Acceptance recognises inventory and accrues GRNI.",
    };
  }

  if (!financePosted) {
    return {
      ...base,
      stage: "Inventory recognised",
      stageIndex: PROCUREMENT_STAGES.indexOf("Inventory recognised"),
      owner: ACCOUNTANT,
      owningRole: ACCOUNTANT,
      previousAction: "Goods accepted into store",
      nextAction: "Post the GRNI accrual to Finance",
      permittedRoles: [ACCOUNTANT, FINANCE_MANAGER, OWNER],
      permission: { module: "finance", feature: "journals", action: "post" },
      blocker: posting === "blocked" ? "Finance has blocked this receipt — see the exception register." : null,
      financialConsequence: "Debit inventory, credit goods-received-not-invoiced.",
    };
  }

  return {
    ...base,
    stage: "GRNI posted",
    stageIndex: PROCUREMENT_STAGES.indexOf("GRNI posted"),
    owner: FINANCE_MANAGER,
    owningRole: FINANCE_MANAGER,
    previousAction: "GRNI accrual posted",
    nextAction: "Capture the supplier invoice",
    permittedRoles: [FINANCE_MANAGER, ACCOUNTANT, OWNER],
    permission: { module: "finance", feature: "ap", action: "create" },
    blocker: null,
    financialConsequence: "Invoice capture will clear GRNI and raise the payable.",
  };
}

// ---------------------------------------------------------------------------
// Guest money
// ---------------------------------------------------------------------------

export const GUEST_MONEY_STAGES = [
  "Reservation",
  "Deposit",
  "Room assigned",
  "Checked in",
  "Folio open",
  "Settled",
  "Checked out",
  "Posted to Finance",
] as const;

export type StayRecord = {
  status?: string | null;
  room_id?: string | null;
  deposit_required?: number | null;
  deposit_paid?: number | null;
  folio_balance?: number | null;
  folio_status?: string | null;
  posted?: boolean | null;
};

export function stayPosition(row: StayRecord): WorkflowPosition {
  const status = norm(row.status);
  const required = Number(row.deposit_required ?? 0);
  const paid = Number(row.deposit_paid ?? 0);
  const depositOutstanding = required > 0 && paid + 0.005 < required;
  const balance = Number(row.folio_balance ?? 0);
  const base = {
    conveyor: "guest-money" as const,
    stages: GUEST_MONEY_STAGES,
    complete: false,
  };

  if (status === "checked_out" || status === "departed") {
    return {
      ...base,
      stage: row.posted ? "Posted to Finance" : "Checked out",
      stageIndex: GUEST_MONEY_STAGES.indexOf(row.posted ? "Posted to Finance" : "Checked out"),
      owner: row.posted ? FINANCE_MANAGER : ACCOUNTANT,
      owningRole: row.posted ? FINANCE_MANAGER : ACCOUNTANT,
      previousAction: "Guest checked out",
      nextAction: row.posted ? null : "Post the stay revenue to Finance",
      permittedRoles: [ACCOUNTANT, FINANCE_MANAGER, OWNER],
      permission: row.posted ? null : { module: "finance", feature: "journals", action: "post" },
      blocker: balance > 0.005 ? `Folio still carries a balance of ${balance.toFixed(2)}.` : null,
      financialConsequence: row.posted
        ? "Revenue and settlement are on the ledger."
        : "Posting recognises room and outlet revenue against settlement.",
      complete: Boolean(row.posted) && balance <= 0.005,
    };
  }

  if (status === "in_house" || status === "checked_in") {
    return {
      ...base,
      stage: balance <= 0.005 ? "Settled" : "Folio open",
      stageIndex: GUEST_MONEY_STAGES.indexOf(balance <= 0.005 ? "Settled" : "Folio open"),
      owner: balance > 0.005 ? "Cashier" : "Front Office",
      owningRole: balance > 0.005 ? "Cashier" : "Front Office Agent",
      previousAction: "Guest checked in",
      nextAction: balance > 0.005 ? "Settle the folio balance" : "Check the guest out",
      permittedRoles: balance > 0.005 ? ["Cashier", FINANCE_MANAGER, OWNER] : ["Front Office Agent", OWNER],
      permission:
        balance > 0.005
          ? { module: "pms", feature: "folio", action: "edit" }
          : { module: "pms", feature: "checkout", action: "edit" },
      blocker: balance > 0.005 ? `Outstanding balance of ${balance.toFixed(2)}.` : null,
      financialConsequence:
        balance > 0.005
          ? "Settlement records the payment against the folio and the till."
          : "Checkout releases the room to Housekeeping and closes the folio.",
    };
  }

  if (!row.room_id) {
    return {
      ...base,
      stage: depositOutstanding ? "Deposit" : "Reservation",
      stageIndex: GUEST_MONEY_STAGES.indexOf(depositOutstanding ? "Deposit" : "Reservation"),
      owner: depositOutstanding ? "Cashier" : "Front Office",
      owningRole: depositOutstanding ? "Cashier" : "Front Office Agent",
      previousAction: "Reservation confirmed",
      nextAction: depositOutstanding ? "Collect the pre-arrival deposit" : "Assign a room",
      permittedRoles: depositOutstanding
        ? ["Cashier", FINANCE_MANAGER, OWNER]
        : ["Front Office Agent", OWNER],
      permission: depositOutstanding
        ? { module: "pms", feature: "deposit", action: "create" }
        : { module: "pms", feature: "reservation", action: "edit" },
      blocker: null,
      financialConsequence: depositOutstanding
        ? "The deposit is held as a liability until the stay earns it."
        : "None — assignment does not move money.",
    };
  }

  return {
    ...base,
    stage: "Room assigned",
    stageIndex: GUEST_MONEY_STAGES.indexOf("Room assigned"),
    owner: "Front Office",
    owningRole: "Front Office Agent",
    previousAction: "Room assigned",
    nextAction: "Check the guest in",
    permittedRoles: ["Front Office Agent", OWNER],
    permission: { module: "pms", feature: "checkin", action: "edit" },
    blocker: depositOutstanding
      ? `Deposit of ${(required - paid).toFixed(2)} is still outstanding.`
      : null,
    financialConsequence: "Check-in opens the folio and starts accommodation charges.",
  };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export const MAINTENANCE_STAGES = [
  "Fault reported",
  "Out of order",
  "Work order assigned",
  "Repair",
  "Inspection",
  "Housekeeping",
  "Ready",
] as const;

export type WorkOrderRecord = {
  status?: string | null;
  assigned_to?: string | null;
  requires_inspection?: boolean | null;
  inspected_at?: string | null;
  requires_housekeeping?: boolean | null;
  housekeeping_cleared_at?: string | null;
  room_id?: string | null;
};

/**
 * A repaired room is not automatically a sellable room.
 *
 * Inspection and, where the work was dirty, housekeeping stand between
 * "the fault is fixed" and "a guest may be sold this room". Skipping either
 * is how an out-of-order room quietly re-enters availability.
 */
export function workOrderPosition(row: WorkOrderRecord): WorkflowPosition {
  const status = norm(row.status);
  const base = {
    conveyor: "maintenance" as const,
    stages: MAINTENANCE_STAGES,
    complete: false,
  };
  const needsInspection = row.requires_inspection !== false && !row.inspected_at;
  const needsHousekeeping = Boolean(row.requires_housekeeping) && !row.housekeeping_cleared_at;

  if (status === "completed" || status === "repaired" || status === "done") {
    if (needsInspection) {
      return {
        ...base,
        stage: "Inspection",
        stageIndex: MAINTENANCE_STAGES.indexOf("Inspection"),
        owner: "Maintenance Supervisor",
        owningRole: "Maintenance Supervisor",
        previousAction: "Repair completed",
        nextAction: "Inspect and sign off the repair",
        permittedRoles: ["Maintenance Supervisor", "Operations Manager", OWNER],
        permission: { module: "maintenance", feature: "workorder", action: "approve" },
        blocker: "The repair has not been inspected.",
        financialConsequence: null,
      };
    }
    if (needsHousekeeping) {
      return {
        ...base,
        stage: "Housekeeping",
        stageIndex: MAINTENANCE_STAGES.indexOf("Housekeeping"),
        owner: "Housekeeping Supervisor",
        owningRole: "Housekeeping Supervisor",
        previousAction: "Repair inspected",
        nextAction: "Clean and release the room",
        permittedRoles: ["Housekeeping Supervisor", "Operations Manager", OWNER],
        permission: { module: "housekeeping", feature: "task", action: "edit" },
        blocker: "The room still needs cleaning after the work.",
        financialConsequence: null,
      };
    }
    return {
      ...base,
      stage: "Ready",
      stageIndex: MAINTENANCE_STAGES.indexOf("Ready"),
      owner: "Front Office",
      owningRole: "Front Office Agent",
      previousAction: "Repair cleared",
      nextAction: null,
      permittedRoles: [],
      permission: null,
      blocker: null,
      financialConsequence: null,
      complete: true,
    };
  }

  if (status === "in_progress" || status === "assigned") {
    return {
      ...base,
      stage: row.assigned_to ? "Repair" : "Work order assigned",
      stageIndex: MAINTENANCE_STAGES.indexOf(row.assigned_to ? "Repair" : "Work order assigned"),
      owner: row.assigned_to ? "Assigned technician" : "Maintenance Supervisor",
      owningRole: row.assigned_to ? "Technician" : "Maintenance Supervisor",
      previousAction: "Work order raised",
      nextAction: row.assigned_to ? "Complete the repair" : "Assign a technician",
      permittedRoles: ["Technician", "Maintenance Supervisor", OWNER],
      permission: { module: "maintenance", feature: "workorder", action: "edit" },
      blocker: null,
      financialConsequence: null,
    };
  }

  return {
    ...base,
    stage: row.room_id ? "Out of order" : "Fault reported",
    stageIndex: MAINTENANCE_STAGES.indexOf(row.room_id ? "Out of order" : "Fault reported"),
    owner: "Maintenance Supervisor",
    owningRole: "Maintenance Supervisor",
    previousAction: "Fault reported",
    nextAction: "Raise and assign the work order",
    permittedRoles: ["Maintenance Supervisor", "Operations Manager", OWNER],
    permission: { module: "maintenance", feature: "workorder", action: "create" },
    blocker: null,
    financialConsequence: null,
  };
}

// ---------------------------------------------------------------------------
// Stores issue
// ---------------------------------------------------------------------------

export const STORES_STAGES = [
  "Requisition",
  "Approved",
  "Issued",
  "Received",
  "Balanced",
] as const;

export type RequisitionRecord = {
  status?: string | null;
  issued_quantity?: number | null;
  requested_quantity?: number | null;
  received_quantity?: number | null;
  rejection_reason?: string | null;
};

export function requisitionPosition(row: RequisitionRecord): WorkflowPosition {
  const status = norm(row.status);
  const requested = Number(row.requested_quantity ?? 0);
  const issued = Number(row.issued_quantity ?? 0);
  const received = Number(row.received_quantity ?? 0);
  const base = { conveyor: "stores-issue" as const, stages: STORES_STAGES, complete: false };

  if (status === "rejected") {
    return {
      ...base,
      stage: "Requisition",
      stageIndex: 0,
      owner: "Requesting department",
      owningRole: "Department Manager",
      previousAction: "Requisition rejected",
      nextAction: "Revise and resubmit",
      permittedRoles: ["Department Manager", OWNER],
      permission: { module: "inventory", feature: "requisition", action: "create" },
      blocker: row.rejection_reason ?? "The requisition was rejected.",
      financialConsequence: "None — no stock moved.",
    };
  }

  if (status === "received" || (received > 0 && received >= issued && issued > 0)) {
    const short = issued > received;
    return {
      ...base,
      stage: short ? "Received" : "Balanced",
      stageIndex: STORES_STAGES.indexOf(short ? "Received" : "Balanced"),
      owner: short ? "Stores Manager" : "Requesting department",
      owningRole: short ? "Stores Manager" : "Department Manager",
      previousAction: "Destination acknowledged the receipt",
      nextAction: short ? "Resolve the shortage" : null,
      permittedRoles: short ? ["Stores Manager", OWNER] : [],
      permission: short ? { module: "inventory", feature: "issue", action: "edit" } : null,
      blocker: short ? `${(issued - received).toFixed(2)} issued but not received.` : null,
      financialConsequence: short
        ? "The shortage stays on the source store until it is written off or found."
        : "Source store reduced, destination increased.",
      complete: !short,
    };
  }

  if (status === "issued" || issued > 0) {
    const partial = issued + 0.0001 < requested;
    return {
      ...base,
      stage: "Issued",
      stageIndex: STORES_STAGES.indexOf("Issued"),
      owner: "Requesting department",
      owningRole: "Department Manager",
      previousAction: partial ? "Partially issued from store" : "Issued from store",
      nextAction: "Acknowledge receipt at the destination",
      permittedRoles: ["Department Manager", "Storekeeper", OWNER],
      permission: { module: "inventory", feature: "issue", action: "edit" },
      blocker: null,
      financialConsequence: "Stock is in transit; balances settle on acknowledgement.",
    };
  }

  if (status === "approved") {
    return {
      ...base,
      stage: "Approved",
      stageIndex: STORES_STAGES.indexOf("Approved"),
      owner: "Storekeeper",
      owningRole: "Storekeeper",
      previousAction: "Requisition approved",
      nextAction: "Issue the stock",
      permittedRoles: ["Storekeeper", "Stores Manager", OWNER],
      permission: { module: "inventory", feature: "issue", action: "create" },
      blocker: null,
      financialConsequence: "Issuing reduces the source store balance.",
    };
  }

  return {
    ...base,
    stage: "Requisition",
    stageIndex: 0,
    owner: "Department Manager",
    owningRole: "Department Manager",
    previousAction: "Requisition raised",
    nextAction: "Approve the requisition",
    permittedRoles: ["Department Manager", "Stores Manager", OWNER],
    permission: { module: "inventory", feature: "requisition", action: "approve" },
    blocker: null,
    financialConsequence: "None until stock is issued.",
  };
}
