import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tax = (code: string, value: number, options: Record<string, unknown> = {}) => ({
  code, name: code, method: "percentage", value, ...options,
});

describe("decimal tax lines", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(readFileSync("supabase/migrations/20261120171000_tax_line_calculator.sql", "utf8"));
  }, 15_000);
  afterAll(async () => db?.close());

  async function calculate(price: number, quantity: number, discount: number, rules: object[]) {
    const { rows } = await db.query<{ result: {
      selling_amount: number; net: number; included_tax: number; added_tax: number;
      total: number; taxes: { code: string; amount: number }[];
    } }>("SELECT neo_tax_calculate_line($1,$2,$3,$4::jsonb) AS result", [price, quantity, discount, JSON.stringify(rules)]);
    return rows[0]!.result;
  }

  it("reconciles KES 120 bread to net 101.70, VAT 16.27 and CTL 2.03", async () => {
    expect(await calculate(120, 1, 0, [tax("VAT", .16), tax("CTL", .02)])).toMatchObject({
      selling_amount: 120, net: 101.7, included_tax: 18.3, added_tax: 0, total: 120,
      taxes: [{ code: "VAT", amount: 16.27 }, { code: "CTL", amount: 2.03 }],
    });
  });

  it.each([["VAT", .16, 16.55], ["CTL", .02, 2.35]])("applies %s by itself", async (name, rate, amount) => {
    expect(await calculate(120, 1, 0, [tax(name, rate)])).toMatchObject({
      total: 120, taxes: [{ code: name, amount }],
    });
  });

  it("applies fixed, compounded and exclusive amounts in rule order", async () => {
    const result = await calculate(120, 1, 0, [
      tax("Fixed", 10, { method: "fixed" }),
      tax("Levy", .1, { compound_on_prior: true }),
      tax("Exclusive", .05, { inclusive: false }),
    ]);
    expect(result).toMatchObject({
      net: 99.09, included_tax: 20.91, added_tax: 4.95, total: 124.95,
      taxes: [{ amount: 10 }, { amount: 10.91 }, { amount: 4.95 }],
    });
  });

  it("supports untaxed, exempt and zero-rated lines without charging tax", async () => {
    expect(await calculate(120, 3, 60, [])).toMatchObject({ total: 300, net: 300, taxes: [] });
    expect(await calculate(120, 1, 0, [
      { code: "EX", name: "Exempt", treatment: "exempt" },
      { code: "ZR", name: "Zero-rated", treatment: "zero_rated" },
    ])).toMatchObject({ total: 120, net: 120, taxes: [{ code: "ZR", amount: 0 }] });
  });

  it("calculates a discounted partial quantity reversal using the supplied snapshot", async () => {
    const rules = [tax("VAT", .16), tax("CTL", .02)];
    const sale = await calculate(120, 2, 20, rules);
    const reversal = await calculate(120, -1, 10, rules);
    expect(sale.total).toBe(220);
    expect(reversal.total).toBe(-110);
    expect(Math.round((reversal.net + reversal.included_tax) * 100)).toBe(-11000);
    expect(reversal.taxes.every((part) => part.amount < 0)).toBe(true);
  });
});
