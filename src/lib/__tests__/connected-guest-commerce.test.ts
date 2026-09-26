import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("connected guest commerce", () => {
  it("uses one guarded mutation contract across Guest and Delivery", () => {
    const guest = read("src/lib/guest-ordering.ts");
    const delivery = read("src/lib/public-delivery.ts");
    for (const source of [guest, delivery]) {
      expect(source).toContain('"neo_guest_cart_add_item"');
      expect(source).toContain('"neo_guest_cart_set_quantity"');
      expect(source).toContain('"neo_guest_cart_update"');
      expect(source).not.toMatch(/from\("cart_items"\)\.(insert|update|delete)/);
      expect(source).not.toMatch(/from\("carts"\)\.(insert|update|delete)/);
    }
  });

  it("keeps pricing and checkout server-authoritative", () => {
    const guest = read("src/lib/guest-ordering.ts");
    const delivery = read("src/lib/public-delivery.ts");
    expect(guest).toContain('"delivery_quote_cart"');
    expect(delivery).toContain('"delivery_quote_cart"');
    expect(guest).toContain('"delivery_place_order"');
    expect(delivery).toContain('"delivery_place_order"');
  });

  it("preserves selected dishes and favourites from Explore", () => {
    const explore = read("src/routes/guest.$hotelSlug.explore.tsx");
    const order = read("src/routes/guest.$hotelSlug.order.tsx");
    expect(explore).toContain('search={{ item: String(item["id"]) }}');
    expect(explore).toContain("useToggleFavourite");
    expect(order).toContain("requestedItem");
  });

  it("keeps sign-in forms on the dedicated guest sign-in route", () => {
    for (const path of [
      "src/routes/guest.$hotelSlug.order.tsx",
      "src/routes/guest.$hotelSlug.account.tsx",
      "src/routes/delivery.$hotelSlug.index.tsx",
      "src/routes/delivery.$hotelSlug.cart.tsx",
    ]) {
      expect(read(path)).not.toContain("CustomerAuthPanel");
      expect(read(path)).toContain("GuestSignInPrompt");
    }
  });
});