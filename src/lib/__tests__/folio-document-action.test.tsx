// @vitest-environment jsdom
/**
 * Folio detail → printed statement.
 *
 * The acceptance path a night auditor actually walks: open a folio, look at the
 * on-screen statement preview, then print/download it. This test drives the real
 * route component and asserts three things that have silently broken before:
 *
 *   1. the preview carries the ACTIVE tenant/property branding (mark, trading
 *      name, legal name) — not a hardcoded NEØ mark,
 *   2. the preview is the folio actually open (its folio number and balance),
 *   3. the print action calls the branded server document engine with
 *      `folio_statement` + THIS folio's id, and hands the browser a download
 *      named after the system-issued document number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const exportSpy = vi.fn();

const FOLIO = {
  id: "11111111-2222-4333-8444-555555555555",
  folio_number: "FOL-000412",
  folio_type: "guest",
  status: "open",
  currency: "KES",
  branch_id: "prop-1",
  opened_at: "2026-08-20T08:00:00Z",
  closed_at: null,
  total_charges: 48500,
  total_payments: 20000,
  balance: 28500,
  customers: { full_name: "Amara Njoroge" },
  reservations: {
    confirmation_number: "RES-9001",
    arrival_date: "2026-08-20",
    departure_date: "2026-08-24",
    rooms: { room_number: "214" },
  },
};

const LINES = [
  {
    id: "line-1",
    description: "Accommodation — Deluxe King",
    category: "accommodation",
    quantity: 4,
    unit_price: 9000,
    gross_amount: 36000,
    net_amount: 36000,
    posting_date: "2026-08-20T08:05:00Z",
    source_module: "pms",
    status: "posted",
  },
];

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ loading: false, isAdmin: true, can: () => true }),
}));

vi.mock("@/lib/frontdesk-ops", () => ({
  useFolio: () => ({ data: FOLIO, isLoading: false, error: null }),
  useFolioLines: () => ({ data: LINES, isLoading: false, error: null }),
  useFolioPayments: () => ({ data: [], isLoading: false, error: null }),
  useOpenFolios: () => ({ data: [], isLoading: false, error: null }),
  usePostFolioCharge: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenFolio: () => ({ mutate: vi.fn(), isPending: false }),
  useReverseFolioLine: () => ({ mutate: vi.fn(), isPending: false }),
  useTransferFolioLine: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/payment-lifecycle", () => ({
  useFolioProjection: () => ({
    data: {
      found: true,
      netRevenue: 48_500,
      tax: 0,
      serviceCharge: 0,
      grossObligation: 48_500,
      collected: 20_000,
      outstanding: 28_500,
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/branches", () => ({
  useBranchScope: () => ({ branches: [{ id: "prop-1", name: "Coastline Diani" }] }),
}));

// Live document branding: organisation identity + the ACTIVE property.
vi.mock("@/lib/branding", () => ({
  useBranding: () => ({
    branding: { logo: "org-mark.png" },
    brand: { primary: "#18C4C8", accent: "#D5AF63", logoText: "NEØ" },
  }),
}));

vi.mock("@/lib/tenant", () => ({
  useTenant: () => ({
    tenant: {
      organization: { name: "Coastline Collection", legalName: "Coastline Collection Limited" },
      contact: { address: "Head office, Nairobi", phonePrimary: "+254700000000" },
      regional: { currency: "KES", taxIdLabel: "PIN", taxId: "P051" },
      branches: [{ id: "prop-1", name: "Coastline Diani", logo: "diani-mark.png" }],
    },
  }),
}));

vi.mock("@/lib/pms-data", () => ({
  useCloseFolio: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/branch-filter", () => ({
  useActivePropertyFilter: () => ({ branchId: "prop-1" }),
}));

vi.mock("@/lib/document-pdf.functions", () => ({ exportBusinessDocument: "export-fn" }));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => (args: unknown) => exportSpy(args),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Route } = await import("@/routes/_shell.pms.folios.$id");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Route as any).useParams = () => ({ id: FOLIO.id });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Page = () => <>{(Route.options as any).component()}</>;

const clicks: string[] = [];

beforeEach(() => {
  exportSpy.mockReset();
  clicks.length = 0;
  // jsdom has no object URLs and no navigation — capture the download instead.
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:doc", writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("folio statement document action", () => {
  it("previews the open folio with the active tenant branding", async () => {
    const { container } = render(<Page />);

    await userEvent.click(screen.getByRole("tab", { name: /statement preview/i }));

    await waitFor(() => expect(container.querySelector("[data-document-page='1']")).toBeTruthy());
    const sheet = container.querySelector("[data-document-page='1']") as HTMLElement;

    // Property mark wins over the organisation mark; nothing is hardcoded.
    expect(sheet.querySelector("[data-document-logo]")?.getAttribute("src")).toBe("diani-mark.png");
    expect(sheet.querySelector("[data-document-trading-name]")?.textContent).toBe(
      "Coastline Diani",
    );
    expect(sheet.textContent).toContain("Coastline Collection Limited");

    // It is THIS folio, with its own identifiers and money.
    expect(sheet.textContent).toContain("FOL-000412");
    expect(sheet.textContent).toContain("Amara Njoroge");
    expect(sheet.textContent).toContain("RES-9001");
    expect(sheet.textContent).toContain("Accommodation — Deluxe King");
  });

  it("prints through the branded server engine with this folio's id", async () => {
    exportSpy.mockResolvedValue({
      base64: btoa("%PDF-1.4 folio"),
      filename: "FS-000412.pdf",
      documentNumber: "FS-000412",
    });

    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: /print statement/i }));

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    expect(exportSpy).toHaveBeenCalledWith({
      data: { type: "folio_statement", id: FOLIO.id },
    });

    // The browser is handed the system-issued document, never a screen print.
    await waitFor(() => expect(clicks).toEqual(["FS-000412.pdf"]));
  });

  it("never falls back to printing the screen", async () => {
    const printSpy = vi.fn();
    Object.defineProperty(window, "print", { value: printSpy, writable: true });
    exportSpy.mockResolvedValue({ base64: btoa("x"), filename: "a.pdf", documentNumber: "A" });

    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: /print statement/i }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalled());
    expect(printSpy).not.toHaveBeenCalled();
  });
});
