// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { parseAvailabilitySearch } from "@/lib/availability-search";

/**
 * Real router integration: the availability page is mounted inside a router
 * whose route id matches the application route, new dates are typed into the
 * visible fields, the actual Search button is clicked, and the browser
 * location plus the rendered result description are asserted.
 *
 * The data hooks are stubbed because this test is about the submit →
 * navigation → search-param → query contract, not about the RPC.
 */

const availabilityCalls: Array<{ arrival: string; departure: string }> = [];

vi.mock("@/lib/branch-filter", () => ({
  useActivePropertyFilter: () => ({ branchId: "branch-zawadi", applyTo: <T,>(q: T) => q }),
}));

vi.mock("@/lib/pms-data", () => ({
  useRoomTypes: () => ({ data: [{ id: "rt-fam", name: "Family Room" }], isLoading: false, error: null }),
  useAvailability: (params: { arrival: string; departure: string }) => {
    availabilityCalls.push({ arrival: params.arrival, departure: params.departure });
    return {
      data: [
        {
          room_id: "r-201",
          room_number: "201",
          room_type_id: "rt-fam",
          room_type_name: "Family Room",
          floor: "2",
          branch_id: "branch-zawadi",
          branch_name: "Zawadi Springs Nairobi",
          max_occupancy: 4,
          readiness: "ready",
          maintenance_status: "operational",
          occupancy_status: "vacant",
          nights: 1,
          qualification: "Sellable",
        },
      ],
      isLoading: false,
      error: null,
      refetch: () => undefined,
    };
  },
}));

async function mountAt(url: string) {
  const { AvailabilityPage, AVAILABILITY_ROUTE_ID } = await import("@/components/pms/AvailabilitySearchPage");
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: "_shell" });
  const availabilityRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/pms/availability",
    validateSearch: parseAvailabilitySearch,
    component: AvailabilityPage,
  });
  const reservationRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/pms/reservations/new",
    validateSearch: parseAvailabilitySearch,
    component: () => <div>new reservation</div>,
  });
  const waitlistRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/pms/waitlist",
    validateSearch: parseAvailabilitySearch,
    component: () => <div>waitlist</div>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      shellRoute.addChildren([availabilityRoute, reservationRoute, waitlistRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  expect(availabilityRoute.id).toBe(AVAILABILITY_ROUTE_ID);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<RouterProvider router={router as any} />);
  await screen.findByLabelText("Arrival");
  return router;
}

afterEach(() => {
  cleanup();
  availabilityCalls.length = 0;
});

/** Browser-like submit: cancelable, bubbling, exactly what a Search click fires. */
function submitForm() {
  const form = screen.getByTestId("availability-form") as HTMLFormElement;
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return { form, event };
}


/**
 * Type into a controlled field and wait until React has committed the value.
 *
 * `userEvent.type` resolves once the keystrokes are dispatched, not once the
 * controlled `draft` state has re-rendered. Submitting before that commit reads
 * a stale/half-typed draft, which the page correctly rejects as invalid — the
 * source of the parallel-load flake. Waiting on the input's own value is the
 * exact deterministic signal that the draft state is up to date.
 */
async function setField(
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLInputElement,
  value: string,
) {
  await user.clear(input);
  await user.type(input, value);
  await waitFor(() => expect(input.value).toBe(value));
}

function formQuery(form: HTMLFormElement) {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form).entries()) params.append(key, String(value));
  return params;
}

/**
 * Warm the route module once. Transforming + importing the availability page,
 * TanStack Router and testing-library costs seconds of CPU when the whole
 * suite runs in parallel; paying that inside the first `it` was what pushed it
 * past the 5s default. The cost is real work, not a race, so it is hoisted out
 * of the timed test rather than papered over with a global timeout bump.
 */
beforeAll(async () => {
  await import("@/components/pms/AvailabilitySearchPage");
}, 60_000);

describe("availability search submits natively", { timeout: 20_000 }, () => {
  it("does not prevent a valid submit and serialises the typed draft", async () => {
    const user = userEvent.setup({ delay: null });
    await mountAt(
      "/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=all&adults=2&children=0",
    );

    expect(await screen.findByText("2026-08-24 → 2026-08-25")).toBeTruthy();

    const arrival = screen.getByLabelText("Arrival") as HTMLInputElement;
    const departure = screen.getByLabelText("Departure") as HTMLInputElement;
    await setField(user, arrival, "2026-08-25");
    await setField(user, departure, "2026-08-26");

    const { form, event } = submitForm();

    // The browser's native GET must be allowed to run.
    expect(event.defaultPrevented).toBe(false);

    const params = formQuery(form);
    expect(params.get("arrival")).toBe("2026-08-25");
    expect(params.get("departure")).toBe("2026-08-26");
    expect(params.get("roomType")).toBe("all");
    expect(params.get("adults")).toBe("2");
    expect(params.get("children")).toBe("0");
    expect(`${form.getAttribute("action")}?${params.toString()}`).toBe(
      "/pms/availability?arrival=2026-08-25&departure=2026-08-26&roomType=all&adults=2&children=0",
    );
  });

  it("keeps room type, adults and children in the submitted query", async () => {
    const user = userEvent.setup({ delay: null });
    await mountAt(
      "/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=rt-fam&adults=3&children=1",
    );

    const departure = screen.getByLabelText("Departure") as HTMLInputElement;
    await setField(user, departure, "2026-08-27");

    const { form, event } = submitForm();
    expect(event.defaultPrevented).toBe(false);

    const params = formQuery(form);
    expect(params.get("arrival")).toBe("2026-08-24");
    expect(params.get("departure")).toBe("2026-08-27");
    expect(params.get("roomType")).toBe("rt-fam");
    expect(params.get("adults")).toBe("3");
    expect(params.get("children")).toBe("1");
  });

  it("is a plain GET form with no nested form and a real submit button", async () => {
    await mountAt(
      "/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=all&adults=2&children=0",
    );
    const form = screen.getByTestId("availability-form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/pms/availability");
    expect(form.querySelectorAll("form").length).toBe(0);
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).type).toBe("submit");
  });

  it("reconstructs the controlled draft and the query from the loaded search params", async () => {
    await mountAt(
      "/pms/availability?arrival=2026-08-25&departure=2026-08-26&roomType=all&adults=2&children=0",
    );

    expect((screen.getByLabelText("Arrival") as HTMLInputElement).value).toBe("2026-08-25");
    expect((screen.getByLabelText("Departure") as HTMLInputElement).value).toBe("2026-08-26");
    expect(await screen.findByText("2026-08-25 → 2026-08-26")).toBeTruthy();
    expect(availabilityCalls.at(-1)).toEqual({ arrival: "2026-08-25", departure: "2026-08-26" });

    const params = formQuery(screen.getByTestId("availability-form") as HTMLFormElement);
    expect(params.get("arrival")).toBe("2026-08-25");
    expect(params.get("roomType")).toBe("all");
  });

  it("rebuilds state when the location changes, as reload and back/forward do", async () => {
    const router = await mountAt(
      "/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=all&adults=2&children=0",
    );

    router.history.push(
      "/pms/availability?arrival=2026-08-25&departure=2026-08-26&roomType=all&adults=2&children=0",
    );
    await waitFor(() => expect(screen.getByText("2026-08-25 → 2026-08-26")).toBeTruthy());
    expect((screen.getByLabelText("Arrival") as HTMLInputElement).value).toBe("2026-08-25");

    router.history.back();
    await waitFor(() => expect(screen.getByText("2026-08-24 → 2026-08-25")).toBeTruthy());
    expect((screen.getByLabelText("Departure") as HTMLInputElement).value).toBe("2026-08-25");

    router.history.forward();
    await waitFor(() => expect(screen.getByText("2026-08-25 → 2026-08-26")).toBeTruthy());
  });

  it("matches the production route definition", async () => {
    const { AVAILABILITY_ROUTE_ID } = await import("@/components/pms/AvailabilitySearchPage");
    const { Route } = await import("@/routes/_shell.pms.availability");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (Route as any).options;
    expect(opts.validateSearch).toBe(parseAvailabilitySearch);
    expect(AVAILABILITY_ROUTE_ID).toBe("/_shell/pms/availability");
  });

  it("prevents an invalid submit and keeps the typed values visible", async () => {
    const user = userEvent.setup({ delay: null });
    const router = await mountAt(
      "/pms/availability?arrival=2026-08-24&departure=2026-08-25&roomType=all&adults=2&children=0",
    );

    const departure = screen.getByLabelText("Departure") as HTMLInputElement;
    await setField(user, departure, "2026-08-24");

    const { event } = submitForm();
    expect(event.defaultPrevented).toBe(true);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText("Departure") as HTMLInputElement).value).toBe("2026-08-24");
    expect(router.state.location.search).toMatchObject({ departure: "2026-08-25" });
  });
});

