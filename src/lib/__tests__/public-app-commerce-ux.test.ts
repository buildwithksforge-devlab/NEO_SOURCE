import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const cart = read("src/routes/delivery.$hotelSlug.cart.tsx");
const deliveryCheckout = read("src/routes/delivery.$hotelSlug.checkout.tsx");
const guestCheckout = read("src/routes/guest.$hotelSlug.checkout.tsx");
const mpesaFunctions = read("src/lib/mpesa.functions.ts");
const favourites = read("src/routes/guest.$hotelSlug.favourites.tsx");
const folio = read("src/routes/guest.$hotelSlug.folio.tsx");
const rider = read("src/routes/rider.index.tsx");
const active = read("src/routes/rider.active.tsx");
const partner = read("src/routes/partner.$propertySlug.tsx");
const shell = read("src/components/public/PublicAppShell.tsx");

describe("public commerce IA", () => {
  it("keeps cart and checkout as separate routes", () => {
    expect(cart).toContain('/delivery/$hotelSlug/checkout');
    expect(deliveryCheckout).toContain('Checkout');
    expect(deliveryCheckout).toContain('Confirm fulfilment, address and payment');
  });
  it("makes favourites and guest folio checkout first-class", () => {
    expect(favourites).toContain('Favourites');
    expect(folio).toContain('/guest/$hotelSlug/checkout');
    expect(guestCheckout).toContain('useGuestFolioMpesaCheckout');
    expect(mpesaFunctions).toContain('neo_guest_folio_mpesa_start');
  });
});

describe("operational app state contracts", () => {
  it("uses canonical delivery order states in rider UI", () => {
    expect(rider).not.toContain('["rider-assigned", "collected", "en-route", "arrived"]');
    expect(active).toContain('["rider-assigned", "collected", "out-for-delivery"]');
    expect(active).not.toContain('status === "arrived"');
  });
  it("uses richer shared visual hierarchy in rider and partner", () => {
    expect(rider).toContain('neo-rider-hero');
    expect(partner).toContain('neo-partner-hero');
    expect(partner).toContain('neo-partner-tabs');
  });
});

describe("important public text contrast", () => {
  it("does not use very faint contact/footer text in the shared shell", () => {
    expect(shell).not.toContain('neo-public-copy space-y-0.5 text-white/55');
    expect(shell).not.toContain('text-[0.7rem] text-white/50 transition-colors');
  });
});
