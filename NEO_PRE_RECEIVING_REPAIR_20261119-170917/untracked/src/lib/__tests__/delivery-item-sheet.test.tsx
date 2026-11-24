// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryItemSheet } from "@/components/public/DeliveryItemSheet";

const mocks = vi.hoisted(() => ({ modifiers: vi.fn() }));
vi.mock("@/lib/guest-ordering", () => ({ useGuestMenuModifiers: mocks.modifiers }));
vi.mock("@/lib/public-delivery", () => ({ money: (amount: number, currency: string) => `${currency} ${amount}` }));
vi.mock("@/components/public/PublicAppShell", () => ({
  useWorkspace: () => ({ organization_id: "hotel", primary_color: "#18c4c8" }),
  BrandButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

const item = { id: "dish", name: "Grilled vegetables", description: "", image: null, price: 800, currency: "KES" };

afterEach(cleanup);

describe("Delivery item options", () => {
  it("requires a configured choice and submits its saved option ID and quantity", () => {
    mocks.modifiers.mockReturnValue({
      isSuccess: true,
      data: { dish: [{ group_id: "side", name: "Side", required: true, multi_select: false,
        options: [{ option_id: "rice", name: "Rice", extra_charge: 0 }, { option_id: "chips", name: "Chips", extra_charge: 100 }] }] },
    });
    const onAdd = vi.fn();
    render(<DeliveryItemSheet item={item} pending={false} onClose={vi.fn()} onAdd={onAdd} />);
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add to cart" });
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Rice" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Chips/ }));
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith({ optionIds: ["chips"], quantity: 2 });
  });

  it("leaves the basket untouched when the options lookup fails", () => {
    const refetch = vi.fn();
    const onAdd = vi.fn();
    mocks.modifiers.mockReturnValue({ isError: true, isSuccess: false, refetch });
    render(<DeliveryItemSheet item={item} pending={false} onClose={vi.fn()} onAdd={onAdd} />);
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add to cart" });
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});
