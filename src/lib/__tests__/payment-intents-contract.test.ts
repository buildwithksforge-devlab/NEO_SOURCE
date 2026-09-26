/**
 * The payment surface must keep three promises:
 *
 *  1. A card slip keyed in by hand is never described as an integrated terminal.
 *  2. Only a real processor can confirm a provider-backed tender.
 *  3. Every collection screen offers the same tenders, from one catalogue.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAYMENT_METHOD_CATALOGUE, paymentMethod } from "@/lib/payment-methods";
import { EXTERNAL_METHODS } from "@/lib/pos";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const read = (p: string) => readFileSync(p, "utf8");

describe("payment method catalogue", () => {
  it("keeps recorded card and integrated terminal as different things", () => {
    expect(paymentMethod("card")?.kind).toBe("recorded");
    expect(paymentMethod("card-terminal")?.kind).toBe("provider");
    expect(paymentMethod("card-terminal")?.provider).toBe("card_terminal");
    expect(paymentMethod("qr")?.kind).toBe("provider");
  });

  it("treats only processor-confirmed tenders as external at the till", () => {
    expect(Object.keys(EXTERNAL_METHODS).sort()).toEqual(["card-terminal", "mpesa", "qr"]);
    for (const method of Object.keys(EXTERNAL_METHODS)) {
      expect(paymentMethod(method)?.kind).toBe("provider");
    }
  });

  it("gives every provider-backed method one place it is set up", () => {
    for (const m of PAYMENT_METHOD_CATALOGUE.filter((x) => x.kind === "provider")) {
      expect(m.configPath, `${m.value} needs a configuration route`).toBeTruthy();
    }
  });
});

describe("checkout screens use the one picker", () => {
  const surfaces = [
    "src/routes/_shell.pos.orders.$id.tsx",
    "src/components/events/EventBillDialog.tsx",
    "src/components/pms/DepositPanel.tsx",
    "src/components/pms/ReservationActions.tsx",
  ];

  it.each(surfaces)("%s renders PaymentMethodPicker", (file) => {
    expect(read(file)).toContain("PaymentMethodPicker");
  });

  it("no longer offers an ad-hoc till method list", () => {
    const pos = read("src/routes/_shell.pos.orders.$id.tsx");
    expect(pos).not.toContain("PAYMENT_METHODS.map");
  });
});

describe("provider intents", () => {
  it("only the callback may apply a provider answer", () => {
    expect(RPC_MANIFEST["neo_payment_intent_apply"]).toBe("service_role");
    expect(RPC_MANIFEST["neo_payment_intent_open"]).toBe("authenticated");
    expect(RPC_MANIFEST["neo_payment_intent_status"]).toBe("authenticated");
  });

  it("rejects a callback that carries no usable token or outcome", () => {
    const route = read("src/routes/api/public/payments.callback.$token.ts");
    expect(route).toContain("token.length < 16");
    expect(route).toContain("No outcome in payload");
    expect(route).toContain("neo_payment_intent_apply");
  });
});
