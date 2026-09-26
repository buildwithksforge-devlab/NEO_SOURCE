// @vitest-environment jsdom
/**
 * New Reservation — Room & rate contract.
 *
 * Live defect: clicking a matching rate left the field unselected, the nightly
 * rate at zero and Continue disabled, and every room type's plans were listed.
 * These tests drive the real UI (clicks on the rendered rate list) rather than
 * asserting on strings, and cover the Availability room handoff plus an
 * incompatible-plan negative case.
 */
import { readFileSync } from "node:fs";
import { useCallback, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  RatePlanPicker,
  roomTypeForRoom,
  selectableRatePlans,
} from "@/components/pms/RatePlanPicker";

afterEach(cleanup);

const STANDARD_DOUBLE = "2d977c9f-ed62-5caa-b083-dff47c82afaa";
const DELUXE_TWIN = "8f0a1c2d-1111-4222-8333-444455556666";
const ROOM_113 = "aaaa1111-2222-4333-8444-555566667777";

const PLANS = [
  {
    id: "71ef16f9-65c1-5faa-a28a-88c6e720a09f",
    name: "Standard Double — Bed & Breakfast (Resident)",
    code: "SCN-SD-BB",
    status: "active",
    base_rate: 8500,
    currency: "KES",
    room_type_id: STANDARD_DOUBLE,
    meal_plan_id: "meal-bb",
  },
  {
    id: "92c71610-aaae-5c1c-8516-243bd7d2d9cf",
    name: "Standard Double — Room Only (Resident)",
    code: "SCN-SD-RO",
    status: "active",
    base_rate: 7500,
    currency: "KES",
    room_type_id: STANDARD_DOUBLE,
    meal_plan_id: null,
  },
  {
    id: "deluxe-plan",
    name: "Deluxe Twin — Bed & Breakfast",
    code: "SCN-DT-BB",
    status: "active",
    base_rate: 14000,
    currency: "KES",
    room_type_id: DELUXE_TWIN,
    meal_plan_id: null,
  },
  {
    id: "archived-plan",
    name: "Standard Double — Retired Promo",
    code: "SCN-SD-OLD",
    status: "archived",
    base_rate: 4000,
    currency: "KES",
    room_type_id: STANDARD_DOUBLE,
    meal_plan_id: null,
  },
];

const ROOMS = [
  { id: ROOM_113, room_type_id: STANDARD_DOUBLE },
  { id: "room-201", room_type_id: DELUXE_TWIN },
];

/** Mirrors the wizard's Room & rate state machine. */
function Harness({
  initialRoomId = "",
  generic = false,
}: {
  initialRoomId?: string;
  generic?: boolean;
}) {
  const plans = generic
    ? [
        ...PLANS,
        {
          id: "generic-plan",
          name: "Any Room Type Promo",
          code: "SCN-ANY",
          status: "active",
          base_rate: 6000,
          currency: "KES",
          room_type_id: null,
          meal_plan_id: null,
        },
      ]
    : PLANS;
  const handoffRoomType = roomTypeForRoom(ROOMS, initialRoomId);
  const [roomTypeId, setRoomTypeId] = useState<string>(handoffRoomType ?? "");
  const [ratePlanId, setRatePlanId] = useState("");
  const [mealPlanId, setMealPlanId] = useState("");

  const changeRoomType = useCallback((next: string) => {
    setRoomTypeId(next);
    setRatePlanId("");
    setMealPlanId("");
  }, []);

  return (
    <div>
      <button type="button" onClick={() => changeRoomType(STANDARD_DOUBLE)}>
        Pick Standard Double
      </button>
      <button type="button" onClick={() => changeRoomType(DELUXE_TWIN)}>
        Pick Deluxe Twin
      </button>
      <RatePlanPicker
        plans={plans}
        roomTypeId={roomTypeId || null}
        value={ratePlanId}
        onSelect={(planId) => {
          setRatePlanId(planId);
          const plan = selectableRatePlans(plans, roomTypeId || null).find((p) => p.id === planId);
          setMealPlanId(plan?.meal_plan_id ?? "");
        }}
      />
      <p data-testid="selected-plan">{ratePlanId || "none"}</p>
      <p data-testid="selected-meal">{mealPlanId || "none"}</p>
      <p data-testid="room-type">{roomTypeId || "none"}</p>
    </div>
  );
}

describe("rate plan applicability", () => {
  it("offers only active plans for the selected room type", () => {
    const offered = selectableRatePlans(PLANS, STANDARD_DOUBLE).map((p) => p.code);
    expect(offered).toEqual(["SCN-SD-BB", "SCN-SD-RO"]);
  });

  it("never offers a generic (null room type) plan", () => {
    const anyType = [...PLANS, { ...PLANS[0]!, id: "any", code: "ANY", room_type_id: null }];
    expect(selectableRatePlans(anyType, STANDARD_DOUBLE).map((p) => p.code)).not.toContain("ANY");
    expect(selectableRatePlans(anyType, STANDARD_DOUBLE).map((p) => p.code)).toEqual([
      "SCN-SD-BB",
      "SCN-SD-RO",
    ]);
  });

  it("offers nothing until a room type is chosen", () => {
    expect(selectableRatePlans(PLANS, null)).toHaveLength(0);
  });
});

describe("Room & rate interaction", () => {
  it("persists the clicked rate plan and inherits its meal plan", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Pick Standard Double" }));
    const option = screen.getByRole("radio", {
      name: /Standard Double — Bed & Breakfast \(Resident\)/,
    });
    expect(option).toHaveProperty("ariaChecked", "false");

    await user.click(option);

    expect(screen.getByTestId("selected-plan").textContent).toBe(
      "71ef16f9-65c1-5faa-a28a-88c6e720a09f",
    );
    expect(screen.getByTestId("selected-meal").textContent).toBe("meal-bb");
    expect(
      screen.getByRole("radio", { name: /Bed & Breakfast \(Resident\)/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("never lists another room type's plan (incompatible plan is unreachable)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Pick Standard Double" }));

    expect(screen.queryByRole("radio", { name: /Deluxe Twin/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Retired Promo/ })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("clears a stale meal plan when a room-only plan is selected after a board plan", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Pick Standard Double" }));

    await user.click(screen.getByRole("radio", { name: /Bed & Breakfast \(Resident\)/ }));
    expect(screen.getByTestId("selected-meal").textContent).toBe("meal-bb");

    await user.click(screen.getByRole("radio", { name: /Room Only \(Resident\)/ }));
    expect(screen.getByTestId("selected-meal").textContent).toBe("none");
    expect(screen.getByTestId("selected-plan").textContent).toBe(
      "92c71610-aaae-5c1c-8516-243bd7d2d9cf",
    );
  });

  it("does not render a generic plan in the list", async () => {
    const user = userEvent.setup();
    render(<Harness generic />);
    await user.click(screen.getByRole("button", { name: "Pick Standard Double" }));
    expect(screen.queryByRole("radio", { name: /Any Room Type Promo/ })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("clears an incompatible rate plan when the room type changes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Pick Standard Double" }));
    await user.click(screen.getByRole("radio", { name: /Room Only \(Resident\)/ }));
    expect(screen.getByTestId("selected-plan").textContent).not.toBe("none");

    await user.click(screen.getByRole("button", { name: "Pick Deluxe Twin" }));

    expect(screen.getByTestId("selected-plan").textContent).toBe("none");
    expect(screen.getByTestId("selected-meal").textContent).toBe("none");
    expect(screen.getByRole("radio", { name: /Deluxe Twin/ })).toBeTruthy();
  });

  it("preselects the room type of a room handed off from Availability (Room 113)", async () => {
    const user = userEvent.setup();
    render(<Harness initialRoomId={ROOM_113} />);

    expect(screen.getByTestId("room-type").textContent).toBe(STANDARD_DOUBLE);
    await user.click(screen.getByRole("radio", { name: /Room Only \(Resident\)/ }));
    expect(screen.getByTestId("selected-plan").textContent).toBe(
      "92c71610-aaae-5c1c-8516-243bd7d2d9cf",
    );
  });

  it("guides the operator instead of showing an empty control", () => {
    render(<RatePlanPicker plans={PLANS} roomTypeId={null} value="" onSelect={() => {}} />);
    expect(screen.getByText(/Select a room type first/)).toBeTruthy();
  });
});

describe("wizard wiring", () => {
  const source = readFileSync("src/routes/_shell.pms.reservations.new.tsx", "utf8");

  it("uses the shared picker and the canonical quote engine", () => {
    expect(source).toContain("RatePlanPicker");
    expect(source).toContain("useRateQuote");
    expect(source).toContain("changeRoomType");
    expect(source).toContain("roomTypeForRoom");
  });

  it("does not price in the browser or insert without a derived rate", () => {
    expect(source).toContain("The selected rate plan produced no price for these dates");
    expect(source).not.toMatch(/nightly_rate:\s*Number\(/);
  });
});
