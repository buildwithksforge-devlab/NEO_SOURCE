/**
 * Every record must be able to say whose desk it is on and what happens next.
 */
import { describe, expect, it } from "vitest";
import {
  GUEST_MONEY_STAGES,
  MAINTENANCE_STAGES,
  PROCUREMENT_STAGES,
  STORES_STAGES,
  grnPosition,
  requisitionPosition,
  stayPosition,
  supplierInvoicePosition,
  supplierPaymentPosition,
  workOrderPosition,
  type WorkflowPosition,
} from "@/lib/workflow-position";

const complete = (p: WorkflowPosition) => {
  // The mandatory fields, checked the same way for every conveyor.
  expect(p.stage).toBeTruthy();
  expect(p.stages).toContain(p.stage);
  expect(p.stageIndex).toBe(p.stages.indexOf(p.stage));
  expect(p.owner).toBeTruthy();
  expect(p.owningRole).toBeTruthy();
  if (!p.complete) {
    expect(p.nextAction).toBeTruthy();
    expect(p.permittedRoles.length).toBeGreaterThan(0);
  }
  return p;
};

describe("supplier payment position", () => {
  it("states the worked example: a scheduled payment is Finance's to approve and release", () => {
    const scheduled = complete(supplierPaymentPosition({ status: "scheduled", invoice_id: "inv-1" }));
    expect(scheduled.nextAction).toBe("Submit for approval");
    expect(scheduled.blocker).toBeNull();
    expect(scheduled.financialConsequence).toContain("does not move money");

    const awaiting = complete(supplierPaymentPosition({ status: "awaiting_approval", invoice_id: "inv-1" }));
    expect(awaiting.owner).toBe("Finance Manager");
    expect(awaiting.nextAction).toBe("Approve payment");
    expect(awaiting.permittedRoles).toEqual(["Finance Manager", "Owner/Director"]);
    expect(awaiting.permission).toEqual({ module: "finance", feature: "payment", action: "approve" });

    const approved = complete(supplierPaymentPosition({ status: "approved", invoice_id: "inv-1" }));
    expect(approved.nextAction).toBe("Release for payment");
    expect(approved.financialConsequence).toContain("Release commits");
  });

  it("keeps scheduling, release and settlement as separate stages", () => {
    const stageOf = (status: string) => supplierPaymentPosition({ status, invoice_id: "i" }).stage;
    const stages = ["scheduled", "approved", "released", "paid"].map(stageOf);
    expect(stages).toEqual(["Payment scheduled", "Payment approved", "Released", "Paid"]);
    // Each step moves strictly forward along the conveyor.
    const indexes = stages.map((s) => PROCUREMENT_STAGES.indexOf(s as never));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(4);
  });

  it("only calls a payment finished once the journal exists", () => {
    const paid = supplierPaymentPosition({ status: "paid" });
    expect(paid.complete).toBe(false);
    expect(paid.nextAction).toBe("Post the payment journal");
    expect(paid.blocker).toContain("journal has not been written");

    const journalised = supplierPaymentPosition({ status: "paid", journal_id: "j-1" });
    expect(journalised.complete).toBe(true);
    expect(journalised.stage).toBe("Journalised");
    expect(journalised.nextAction).toBeNull();
  });

  it("names the precise blocker rather than a generic hold", () => {
    expect(supplierPaymentPosition({ status: "scheduled" }).blocker).toContain("No supplier invoice");
    expect(
      supplierPaymentPosition({ status: "approved", hold_reason: "Period 08 is closed" }).blocker,
    ).toBe("Period 08 is closed");
    expect(supplierPaymentPosition({ status: "wobble" }).blocker).toContain("Unrecognised");
  });
});

describe("supplier invoice and GRN positions", () => {
  it("separates operational acceptance from Finance posting", () => {
    const accepted = complete(grnPosition({ status: "accepted", po_id: "po-1" }));
    expect(accepted.stage).toBe("Inventory recognised");
    expect(accepted.owner).toBe("Accountant");
    expect(accepted.nextAction).toBe("Post the GRNI accrual to Finance");
    expect(accepted.financialConsequence).toContain("goods-received-not-invoiced");

    const posted = complete(grnPosition({ status: "accepted", posting_status: "posted", journal_id: "j" }));
    expect(posted.stage).toBe("GRNI posted");
    expect(posted.nextAction).toBe("Capture the supplier invoice");
  });

  it("flags a receipt Finance has blocked, and one with no purchase order", () => {
    expect(grnPosition({ status: "accepted", posting_status: "blocked" }).blocker).toContain(
      "exception register",
    );
    expect(grnPosition({ status: "draft" }).blocker).toContain("not linked to a purchase order");
  });

  it("holds a matching exception with Finance, not with the clerk", () => {
    const held = complete(
      supplierInvoicePosition({ status: "held", hold_reason: "Price above 5% tolerance" }),
    );
    expect(held.owner).toBe("Finance Manager");
    expect(held.blocker).toBe("Price above 5% tolerance");
    expect(held.nextAction).toBe("Resolve the matching exception");
    expect(held.financialConsequence).toContain("No payable");

    const captured = complete(supplierInvoicePosition({ status: "captured" }));
    expect(captured.blocker).toContain("cannot be matched three ways");
  });
});

describe("guest money position", () => {
  it("walks a stay from reservation through to Finance", () => {
    const reserved = complete(stayPosition({ status: "confirmed" }));
    expect(reserved.nextAction).toBe("Assign a room");

    const owing = complete(stayPosition({ status: "confirmed", deposit_required: 5000, deposit_paid: 0 }));
    expect(owing.stage).toBe("Deposit");
    expect(owing.nextAction).toBe("Collect the pre-arrival deposit");
    expect(owing.financialConsequence).toContain("liability");

    const assigned = complete(stayPosition({ status: "confirmed", room_id: "r-1" }));
    expect(assigned.nextAction).toBe("Check the guest in");

    const inHouse = complete(stayPosition({ status: "in_house", room_id: "r-1", folio_balance: 3250 }));
    expect(inHouse.owner).toBe("Cashier");
    expect(inHouse.nextAction).toBe("Settle the folio balance");
    expect(inHouse.blocker).toContain("3250.00");

    const settled = complete(stayPosition({ status: "in_house", room_id: "r-1", folio_balance: 0 }));
    expect(settled.stage).toBe("Settled");
    expect(settled.nextAction).toBe("Check the guest out");
  });

  it("does not call a departure done until the revenue is posted and the folio is clear", () => {
    const out = stayPosition({ status: "checked_out", folio_balance: 0 });
    expect(out.complete).toBe(false);
    expect(out.nextAction).toBe("Post the stay revenue to Finance");

    const posted = stayPosition({ status: "checked_out", folio_balance: 0, posted: true });
    expect(posted.complete).toBe(true);
    expect(posted.stage).toBe("Posted to Finance");

    const owing = stayPosition({ status: "checked_out", folio_balance: 900, posted: true });
    expect(owing.complete).toBe(false);
    expect(owing.blocker).toContain("900.00");
  });

  it("blocks check-in while a deposit is outstanding, quoting the shortfall", () => {
    const p = stayPosition({ status: "confirmed", room_id: "r-1", deposit_required: 5000, deposit_paid: 2000 });
    expect(p.nextAction).toBe("Check the guest in");
    expect(p.blocker).toContain("3000.00");
  });
});

describe("maintenance position", () => {
  it("will not call a repaired room ready before inspection and any cleaning", () => {
    const repaired = complete(workOrderPosition({ status: "completed", room_id: "r" }));
    expect(repaired.stage).toBe("Inspection");
    expect(repaired.blocker).toContain("not been inspected");

    const inspected = complete(
      workOrderPosition({
        status: "completed",
        inspected_at: "2026-08-31T00:00:00Z",
        requires_housekeeping: true,
      }),
    );
    expect(inspected.stage).toBe("Housekeeping");
    expect(inspected.owner).toBe("Housekeeping Supervisor");

    const ready = workOrderPosition({
      status: "completed",
      inspected_at: "2026-08-31T00:00:00Z",
      requires_housekeeping: true,
      housekeeping_cleared_at: "2026-08-31T02:00:00Z",
    });
    expect(ready.stage).toBe("Ready");
    expect(ready.complete).toBe(true);
    expect(ready.nextAction).toBeNull();
  });

  it("asks for a technician before it asks for a repair", () => {
    expect(workOrderPosition({ status: "assigned" }).nextAction).toBe("Assign a technician");
    expect(workOrderPosition({ status: "in_progress", assigned_to: "u-1" }).nextAction).toBe(
      "Complete the repair",
    );
  });
});

describe("stores issue position", () => {
  it("moves requisition → approval → issue → acknowledgement → balanced", () => {
    expect(complete(requisitionPosition({ status: "submitted" })).nextAction).toBe(
      "Approve the requisition",
    );
    expect(complete(requisitionPosition({ status: "approved" })).nextAction).toBe("Issue the stock");

    const issued = complete(
      requisitionPosition({ status: "issued", requested_quantity: 10, issued_quantity: 6 }),
    );
    expect(issued.previousAction).toBe("Partially issued from store");
    expect(issued.nextAction).toBe("Acknowledge receipt at the destination");

    const balanced = requisitionPosition({ status: "received", issued_quantity: 6, received_quantity: 6 });
    expect(balanced.stage).toBe("Balanced");
    expect(balanced.complete).toBe(true);
  });

  it("routes a shortage back to the store instead of quietly closing", () => {
    const short = complete(
      requisitionPosition({ status: "received", issued_quantity: 6, received_quantity: 4 }),
    );
    expect(short.complete).toBe(false);
    expect(short.owner).toBe("Stores Manager");
    expect(short.blocker).toContain("2.00 issued but not received");
  });

  it("returns a rejected requisition to the requester with the reason", () => {
    const p = complete(requisitionPosition({ status: "rejected", rejection_reason: "Budget exhausted" }));
    expect(p.blocker).toBe("Budget exhausted");
    expect(p.nextAction).toBe("Revise and resubmit");
    expect(p.financialConsequence).toContain("no stock moved");
  });
});

describe("conveyor definitions", () => {
  it("names each stage once, in order, on every conveyor", () => {
    for (const stages of [PROCUREMENT_STAGES, GUEST_MONEY_STAGES, MAINTENANCE_STAGES, STORES_STAGES]) {
      expect(new Set(stages).size).toBe(stages.length);
      expect(stages.length).toBeGreaterThan(2);
    }
    expect(PROCUREMENT_STAGES).toContain("GRNI posted");
    expect(PROCUREMENT_STAGES.indexOf("Released")).toBeLessThan(PROCUREMENT_STAGES.indexOf("Paid"));
  });
});
