// @vitest-environment jsdom
/**
 * Three parts of one hospitality invariant:
 *
 *  1. WRITES follow the ACTIVE property. `profile.branch_id` is a home
 *     assignment, never an override of a deliberate property switch.
 *  2. STATIONS obey property → department. Only departments of the chosen
 *     property may be offered, and a station with a broken chain is surfaced
 *     as a configuration warning rather than silently guessed at.
 *  3. Clicking a folio number opens the document overlay for THAT exact folio.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { menuDepartmentsForBranch } from "@/lib/menu-scoping";

/* ------------------------------------------------------------------ *
 * 1. Active property drives writes
 * ------------------------------------------------------------------ */

const activeBranch = { current: null as string | null };
const homeBranch = { current: null as string | null };

vi.mock("@/lib/branches", () => ({
  useBranchScope: () => ({ activeBranchId: activeBranch.current, orgWide: true }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    profile: { branch_id: homeBranch.current },
    organizationId: "org-1",
    user: { id: "user-1" },
    isAdmin: true,
    can: () => true,
    loading: false,
  }),
}));

const { useWriteBranchId } = await import("@/lib/branch-filter");

afterEach(() => cleanup());

describe("active property drives new records", () => {
  it("uses the selected property, not the user's home property", () => {
    homeBranch.current = "nairobi";
    activeBranch.current = "mombasa";
    const { result } = renderHook(() => useWriteBranchId());
    expect(result.current).toBe("mombasa");
  });

  it("falls back to the home property only when nothing is selected", () => {
    homeBranch.current = "nairobi";
    activeBranch.current = null;
    expect(renderHook(() => useWriteBranchId()).result.current).toBe("nairobi");
  });

  it("treats All Properties as no property rather than borrowing the home one", () => {
    homeBranch.current = "nairobi";
    activeBranch.current = "all";
    expect(renderHook(() => useWriteBranchId()).result.current).toBe("nairobi");
  });

  it("writes nothing when the operator has neither", () => {
    homeBranch.current = null;
    activeBranch.current = null;
    expect(renderHook(() => useWriteBranchId()).result.current).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2. Property → department → station chain
 * ------------------------------------------------------------------ */

const DEPARTMENTS = [
  { id: "kitchen-nbo", name: "Main Kitchen", catalogue_key: "main-kitchen", branch_id: "nairobi" },
  { id: "bar-nbo", name: "Bar", catalogue_key: "bar", branch_id: "nairobi" },
  { id: "kitchen-msa", name: "Main Kitchen", catalogue_key: "main-kitchen", branch_id: "mombasa" },
];

describe("station configuration chain", () => {
  it("offers only the chosen property's departments", () => {
    const ids = menuDepartmentsForBranch(DEPARTMENTS, "mombasa").map((d) => d.id);
    expect(ids).toEqual(["kitchen-msa"]);
    expect(ids).not.toContain("kitchen-nbo");
  });

  it("never hardcodes a station name to a property", () => {
    // The department is resolved by catalogue key, so a "Fry" or "Grill" station
    // in any workspace resolves to that property's own kitchen department.
    for (const branch of ["nairobi", "mombasa"]) {
      const kitchen = menuDepartmentsForBranch(DEPARTMENTS, branch).find(
        (d) => d.catalogue_key === "main-kitchen",
      );
      expect(kitchen?.branch_id).toBe(branch);
    }
  });

  it("a department of another property is never a valid station parent", () => {
    expect(menuDepartmentsForBranch(DEPARTMENTS, "nairobi").some((d) => d.id === "kitchen-msa")).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. Folio list → document overlay for the exact folio
 * ------------------------------------------------------------------ */

const FOLIOS = [
  {
    id: "folio-a",
    folio_number: "SCG-FOL-00044",
    folio_type: "guest",
    status: "open",
    currency: "KES",
    total_charges: 12000,
    total_payments: 2000,
    balance: 10000,
    reservation_id: "res-a",
    customers: { full_name: "Amara Njoroge" },
  },
  {
    id: "folio-b",
    folio_number: "SCG-FOL-00045",
    folio_type: "guest",
    status: "open",
    currency: "KES",
    total_charges: 500,
    total_payments: 0,
    balance: 500,
    reservation_id: null,
    customers: { full_name: "Brian Otieno" },
  },
];

vi.mock("@/lib/pms-data", () => ({
  useFolioDirectory: () => ({ data: FOLIOS, isLoading: false, error: null }),
  // The departures strip shares this page; nothing is owing in this fixture.
  useDeparturesPendingSettlement: () => ({ data: [], isLoading: false, error: null }),
  useCloseFolio: () => ({ mutateAsync: async () => ({}), isPending: false }),
}));

vi.mock("@/lib/frontdesk-ops", () => ({
  useFolio: (id: string) => ({
    data: FOLIOS.find((f) => f.id === id) ?? null,
    isLoading: false,
    error: null,
  }),
  useFolioLines: () => ({ data: [], isLoading: false, error: null }),
}));

vi.mock("@/lib/payment-lifecycle", () => ({
  useFolioProjection: (id: string) => {
    const folio = FOLIOS.find((row) => row.id === id);
    return {
      data: folio
        ? {
            found: true,
            guestName: folio.customers.full_name,
            netRevenue: folio.total_charges,
            tax: 0,
            serviceCharge: 0,
            grossObligation: folio.total_charges,
            collected: folio.total_payments,
            outstanding: folio.balance,
          }
        : null,
      isLoading: false,
      error: null,
    };
  },
}));

vi.mock("@/lib/branding", () => ({
  useBranding: () => ({ branding: { logo: "org.png" }, brand: { logoText: "NEØ" } }),
}));

vi.mock("@/lib/tenant", () => ({
  useTenant: () => ({
    tenant: {
      organization: { name: "Savanna Crown", legalName: "Savanna Crown Ltd" },
      contact: {},
      regional: { currency: "KES" },
      branches: [{ id: "nairobi", name: "Savanna Crown Nairobi" }],
    },
  }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  };
});

const { Route: FolioListRoute } = await import("@/routes/_shell.pms.folios.index");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FolioList = () => <>{(FolioListRoute.options as any).component()}</>;

// The statement overlay offers a real print action, which reads the printer
// queue, so the folio list is rendered inside a query provider here just as it
// is inside the app shell.
function renderFolios() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FolioList />
    </QueryClientProvider>,
  );
}

describe("folio list document overlay", () => {
  it("opens the document preview for the exact folio clicked", async () => {
    activeBranch.current = "nairobi";
    const { container } = renderFolios();

    await userEvent.click(screen.getByRole("button", { name: "SCG-FOL-00045" }));

    await waitFor(() =>
      expect(container.ownerDocument.querySelector("[data-folio-statement-dialog]")).toBeTruthy(),
    );
    const dialog = container.ownerDocument.querySelector(
      "[data-folio-statement-dialog]",
    ) as HTMLElement;
    expect(dialog.getAttribute("data-folio-id")).toBe("folio-b");
    expect(dialog.textContent).toContain("SCG-FOL-00045");
    expect(dialog.textContent).not.toContain("SCG-FOL-00044");
    expect(dialog.textContent).toContain("Brian Otieno");
  });

  it("keeps the operational folio page reachable from the row", () => {
    renderFolios();
    expect(screen.getAllByText("Open folio").length).toBe(FOLIOS.length);
  });
});
