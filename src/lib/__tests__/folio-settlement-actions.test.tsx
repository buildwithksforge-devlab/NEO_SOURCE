// @vitest-environment jsdom
/**
 * Folio detail — settlement action availability by context.
 *
 * The folio screen offers correcting/settlement actions (post charge, transfer,
 * reverse, reopen, print statement). Each is legitimate in some contexts and
 * wrong in others. This test pins the contract:
 *
 *   open folio          → post charge; transfer/reverse offered on positive lines
 *   closed/settled folio→ no post charge, no transfer/reverse; reopen instead
 *   reversal line       → no further transfer/reverse on the contra posting
 *   no print permission → the statement action is absent, not a dead button
 *   reason-gated actions→ visible but DISABLED until the reason is supplied
 *
 * It also proves the gating is presentation-only: the amounts shown are exactly
 * the figures on the canonical record in every context. No Finance calculation
 * is performed, re-derived or altered by the permission state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { money } from "@/lib/pms";

const auth = {
  isAdmin: true,
  can: (_module: string, _action: string) => true,
};

const folioState: { row: Record<string, unknown>; lines: Record<string, unknown>[] } = {
  row: {},
  lines: [],
};

const BASE = {
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

const line = (over: Record<string, unknown>) => ({
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
  ...over,
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ loading: false, isAdmin: auth.isAdmin, can: auth.can }),
}));

vi.mock("@/lib/frontdesk-ops", () => ({
  useFolio: () => ({ data: folioState.row, isLoading: false, error: null }),
  useFolioLines: () => ({ data: folioState.lines, isLoading: false, error: null }),
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
      contact: {},
      regional: { currency: "KES" },
      branches: [{ id: "prop-1", name: "Coastline Diani" }],
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
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  };
});

const { Route } = await import("@/routes/_shell.pms.folios.$id");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Route as any).useParams = () => ({ id: BASE.id });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Page = () => <>{(Route.options as any).component()}</>;

/**
 * The row action cluster renders inline buttons (>=md) and an overflow menu
 * (<md) from the same source list, so a label present anywhere means the
 * action is offered; absent everywhere means it is withdrawn.
 */
const rowAction = (label: string) => screen.queryAllByText(label);

beforeEach(() => {
  auth.isAdmin = true;
  auth.can = () => true;
  folioState.row = { ...BASE };
  folioState.lines = [line({})];
});

afterEach(cleanup);

describe("settlement actions by folio context", () => {
  it("open folio: posting and line corrections are offered", async () => {
    render(<Page />);

    expect(screen.getByRole("button", { name: /post charge/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reopen folio/i })).toBeNull();
    expect(screen.getByRole("button", { name: /print statement/i })).toBeTruthy();

    expect(rowAction("Transfer").length).toBeGreaterThan(0);
    expect(rowAction("Reverse").length).toBeGreaterThan(0);
  });

  for (const status of ["closed", "settled", "voided"]) {
    it(`${status} folio: corrections are withdrawn and only reopen remains`, async () => {
      folioState.row = { ...BASE, status, closed_at: "2026-08-24T10:00:00Z" };
      render(<Page />);

      expect(screen.queryByRole("button", { name: /post charge/i })).toBeNull();
      expect(screen.getByRole("button", { name: /reopen folio/i })).toBeTruthy();

      expect(rowAction("Transfer")).toEqual([]);
      expect(rowAction("Reverse")).toEqual([]);
    });
  }

  it("a contra posting cannot itself be transferred or reversed again", async () => {
    folioState.lines = [line({ id: "line-neg", gross_amount: -36000, net_amount: -36000 })];
    render(<Page />);

    expect(rowAction("Transfer")).toEqual([]);
    expect(rowAction("Reverse")).toEqual([]);
  });

  it("without print permission the statement action is absent, not a dead button", () => {
    auth.isAdmin = false;
    auth.can = (module: string, action: string) =>
      module === "pms" && action.startsWith("folios");
    render(<Page />);

    expect(screen.getByRole("button", { name: /post charge/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /print statement/i })).toBeNull();
  });

  it("without the folio view permission the whole screen is refused", () => {
    auth.isAdmin = false;
    auth.can = () => false;
    render(<Page />);

    expect(screen.queryByRole("button", { name: /post charge/i })).toBeNull();
    expect(screen.getByText(/pms\.folios\.view/i)).toBeTruthy();
  });
});

describe("reason-gated actions stay disabled until justified", () => {
  it("reversal cannot be submitted without a written reason", async () => {
    render(<Page />);
    await userEvent.click(rowAction("Reverse")[0]!);

    const dialog = await screen.findByRole("dialog", {}, { timeout: 8000 });
    const submit = within(dialog).getByRole("button", { name: /post reversal/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/reason/i), {
      target: { value: "Duplicate posting from PMS" },
    });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  });

  it("reopening a closed folio requires a reason", async () => {
    folioState.row = { ...BASE, status: "closed", closed_at: "2026-08-24T10:00:00Z" };
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: /reopen folio/i }));

    const dialog = await screen.findByRole("dialog", {}, { timeout: 8000 });
    const submit = within(dialog).getByRole("button", { name: /reopen folio/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("gating never touches the money", () => {
  const shown = () => {
    const text = document.body.textContent ?? "";
    return {
      charges: text.includes(money(48500, "KES")),
      payments: text.includes(money(20000, "KES")),
      balance: text.includes(money(28500, "KES")),
    };
  };

  it("shows the record's own figures identically in every context", () => {
    const contexts = [
      () => undefined,
      () => {
        folioState.row = { ...BASE, status: "closed", closed_at: "2026-08-24T10:00:00Z" };
      },
      () => {
        auth.isAdmin = false;
        auth.can = (module: string, action: string) =>
          module === "pms" && action.startsWith("folios");
      },
    ];

    for (const apply of contexts) {
      apply();
      render(<Page />);
      expect(shown()).toEqual({ charges: true, payments: true, balance: true });
      cleanup();
      // Reset for the next context.
      auth.isAdmin = true;
      auth.can = () => true;
      folioState.row = { ...BASE };
    }
  });
});
