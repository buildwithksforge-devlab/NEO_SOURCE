/**
 * Canonical business-document presentation profiles.
 *
 * Financial and operational truth still comes exclusively from
 * neo_document_payload(). These profiles only control presentation.
 */

export type DocumentColumnKey =
  | "description"
  | "date"
  | "quantity"
  | "unit"
  | "unit_price"
  | "tax"
  | "total"
  | "note";

export type DocumentTableColumn = {
  key: DocumentColumnKey;
  label: string;
  width: number;
  align: "left" | "right";
};

export type DocumentLayoutProfile = {
  family:
    | "receipt"
    | "sales"
    | "guest"
    | "events"
    | "procurement"
    | "inventory"
    | "hr"
    | "operations";
  detailHeading: string;
  partyFallback: string;
  showFiscalSection?: boolean;
  preferThermal?: boolean;
  columns?: readonly DocumentTableColumn[];
};

export const DOCUMENT_LAYOUTS = {
  pos_receipt: {
    family: "receipt",
    detailHeading: "PAYMENT & TRANSACTION DETAILS",
    partyFallback: "Customer",
    preferThermal: true,
    columns: [
      { key: "description", label: "Item", width: 220, align: "left" },
      { key: "quantity", label: "Qty", width: 45, align: "right" },
      { key: "unit_price", label: "Unit price", width: 85, align: "right" },
      { key: "tax", label: "Tax", width: 65, align: "right" },
      { key: "total", label: "Amount", width: 90, align: "right" },
    ],
  },

  invoice: {
    family: "sales",
    detailHeading: "PAYMENT, TAX & INVOICE DETAILS",
    partyFallback: "Bill to",
    showFiscalSection: true,
    columns: [
      { key: "description", label: "Description", width: 220, align: "left" },
      { key: "quantity", label: "Qty", width: 45, align: "right" },
      { key: "unit_price", label: "Unit price", width: 85, align: "right" },
      { key: "tax", label: "Tax", width: 65, align: "right" },
      { key: "total", label: "Amount", width: 90, align: "right" },
    ],
  },

  folio_statement: {
    family: "guest",
    detailHeading: "STAY & FOLIO DETAILS",
    partyFallback: "Guest",
    columns: [
      { key: "date", label: "Date", width: 82, align: "left" },
      { key: "description", label: "Description", width: 183, align: "left" },
      { key: "quantity", label: "Qty", width: 45, align: "right" },
      { key: "unit_price", label: "Rate", width: 75, align: "right" },
      { key: "tax", label: "Tax", width: 55, align: "right" },
      { key: "total", label: "Amount", width: 65, align: "right" },
    ],
  },

  beo: {
    family: "events",
    detailHeading: "EVENT SERVICE DETAILS",
    partyFallback: "Event",
    columns: [
      { key: "description", label: "Service stage", width: 300, align: "left" },
      { key: "note", label: "Timing", width: 205, align: "right" },
    ],
  },

  purchase_order: {
    family: "procurement",
    detailHeading: "DELIVERY, PAYMENT TERMS & ORDER DETAILS",
    partyFallback: "Supplier",
    columns: [
      { key: "description", label: "Item", width: 190, align: "left" },
      { key: "quantity", label: "Qty", width: 50, align: "right" },
      { key: "unit", label: "Unit", width: 45, align: "right" },
      { key: "unit_price", label: "Unit price", width: 75, align: "right" },
      { key: "tax", label: "Tax", width: 55, align: "right" },
      { key: "total", label: "Total", width: 90, align: "right" },
    ],
  },

  goods_receipt: {
    family: "procurement",
    detailHeading: "RECEIVING & INSPECTION DETAILS",
    partyFallback: "Supplier",
    columns: [
      { key: "description", label: "Item", width: 220, align: "left" },
      { key: "quantity", label: "Received", width: 65, align: "right" },
      { key: "unit", label: "Unit", width: 50, align: "right" },
      { key: "unit_price", label: "Unit cost", width: 75, align: "right" },
      { key: "total", label: "Accepted value", width: 95, align: "right" },
    ],
  },

  requisition: {
    family: "inventory",
    detailHeading: "REQUISITION & ISSUE DETAILS",
    partyFallback: "Requesting department",
    columns: [
      { key: "description", label: "Item", width: 260, align: "left" },
      { key: "quantity", label: "Requested", width: 70, align: "right" },
      { key: "unit", label: "Unit", width: 60, align: "right" },
      { key: "note", label: "Approved / issued", width: 115, align: "right" },
    ],
  },

  stock_sheet: {
    family: "inventory",
    detailHeading: "COUNT & VARIANCE DETAILS",
    partyFallback: "Store location",
    columns: [
      { key: "description", label: "Item", width: 220, align: "left" },
      { key: "quantity", label: "Counted", width: 60, align: "right" },
      { key: "unit", label: "Unit", width: 55, align: "right" },
      { key: "unit_price", label: "Unit cost", width: 80, align: "right" },
      { key: "total", label: "Variance value", width: 90, align: "right" },
    ],
  },

  staff_schedule: {
    family: "hr",
    detailHeading: "ROSTER & SHIFT DETAILS",
    partyFallback: "Department",
    columns: [
      { key: "description", label: "Employee", width: 230, align: "left" },
      { key: "note", label: "Shift", width: 275, align: "left" },
    ],
  },

  task_sheet: {
    family: "operations",
    detailHeading: "TASK & WORK DETAILS",
    partyFallback: "Department",
    columns: [
      { key: "description", label: "Task", width: 260, align: "left" },
      { key: "note", label: "Assignment / status", width: 245, align: "left" },
    ],
  },

  payslip: {
    family: "hr",
    detailHeading: "PAYROLL DETAILS",
    partyFallback: "Employee",
  },
} as const satisfies Record<string, DocumentLayoutProfile>;

export type DocumentLayoutType = keyof typeof DOCUMENT_LAYOUTS;

export function documentLayout(type: string): DocumentLayoutProfile {
  return (
    DOCUMENT_LAYOUTS[type as DocumentLayoutType] ?? {
      family: "operations",
      detailHeading: "DOCUMENT DETAILS",
      partyFallback: "Party",
    }
  );
}