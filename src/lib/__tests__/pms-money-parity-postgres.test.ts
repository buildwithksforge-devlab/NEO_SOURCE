import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000001";
const folio = "00000000-0000-4000-8000-000000000002";
const payment = "00000000-0000-4000-8000-000000000003";
const deposit = "00000000-0000-4000-8000-000000000004";
const line = "00000000-0000-4000-8000-000000000005";

const migration = readFileSync(
  "supabase/migrations/20261115013000_finance_checkout_ledger_parity.sql",
  "utf8"
);

const canonical = migration.match(
  /CREATE OR REPLACE FUNCTION public\.neo_folio_financial_components\(_folio uuid,_org uuid\)[\s\S]*?\$function\$;/
)?.[0];

if (!canonical) {
  throw new Error("Canonical November 15 Finance function not found");
}

type Balance = {
  finance: number;
  checkout: number;
  difference: number;
};

describe("Real PostgreSQL PMS and Finance balance compatibility", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE TABLE public.folios (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        currency text NOT NULL DEFAULT 'KES'
      );

      CREATE TABLE public.folio_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        folio_id uuid,
        organization_id uuid,
        status text DEFAULT 'posted',
        line_type text DEFAULT 'charge',
        category text DEFAULT 'accommodation',
        net_amount numeric DEFAULT 0,
        tax_amount numeric DEFAULT 0,
        service_charge_amount numeric DEFAULT 0,
        discount_amount numeric DEFAULT 0
      );

      CREATE TABLE public.payments (
        id uuid PRIMARY KEY,
        folio_id uuid,
        organization_id uuid,
        amount numeric NOT NULL,
        currency text NOT NULL DEFAULT 'KES',
        status text NOT NULL
      );

      CREATE TABLE public.payment_allocations (
        payment_id uuid,
        folio_id uuid,
        amount numeric NOT NULL
      );

      CREATE TABLE public.reservation_deposits (
        id uuid PRIMARY KEY,
        organization_id uuid,
        applied_folio_id uuid,
        applied_folio_line_id uuid,
        payment_id uuid,
        amount numeric NOT NULL,
        currency text NOT NULL DEFAULT 'KES',
        status text NOT NULL
      );
    `);

    await db.exec(canonical);
  }, 30000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.payment_allocations,
        public.reservation_deposits,
        public.payments,
        public.folio_lines,
        public.folios;

      INSERT INTO public.folios(id,organization_id,currency)
      VALUES ('${folio}','${org}','KES');

      INSERT INTO public.folio_lines(
        folio_id,organization_id,line_type,
        category,net_amount,tax_amount,service_charge_amount
      )
      VALUES (
        '${folio}','${org}','charge',
        'accommodation',12000,0,0
      );
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function assess(): Promise<Balance> {
    const projection = await db.query<{
      components: Record<string, unknown>;
    }>(
      "SELECT public.neo_folio_financial_components($1,$2) AS components",
      [folio,org]
    );

    const finance = Number(
      projection.rows[0]?.components?.["outstanding"]
    );

    expect(Number.isFinite(finance)).toBe(true);

    // Reproduces the current pms_check_out SQL arithmetic.
    const checkoutResult = await db.query<{
      outstanding: string;
    }>(`
      SELECT round(
        (
          SELECT coalesce(sum(l.net_amount),0)
          FROM public.folio_lines l
          WHERE l.folio_id=$1
            AND coalesce(l.status,'posted')
                NOT IN ('void','voided','reversed')
            AND coalesce(l.line_type,'charge')
                NOT IN ('payment','deposit','refund')
        )
        -
        (
          SELECT coalesce(sum(a.amount),0)
          FROM public.payment_allocations a
          JOIN public.payments p ON p.id=a.payment_id
          WHERE a.folio_id=$1 AND p.status='confirmed'
        )
        -
        (
          SELECT coalesce(sum(l.net_amount),0)
          FROM public.folio_lines l
          WHERE l.folio_id=$1
            AND coalesce(l.status,'posted')
                NOT IN ('void','voided','reversed')
            AND coalesce(l.line_type,'charge')
                IN ('payment','deposit')
        ),2
      ) AS outstanding
    `,[folio]);

    const checkout = Number(
      checkoutResult.rows[0]?.outstanding
    );

    return {
      finance,
      checkout,
      difference: checkout-finance
    };
  }

  async function addPayment(
    amount: number,
    status = "confirmed",
    allocated = true
  ) {
    await db.query(
      `INSERT INTO public.payments(
        id,folio_id,organization_id,amount,currency,status
      ) VALUES ($1,$2,$3,$4,'KES',$5)`,
      [payment,folio,org,amount,status]
    );

    if (allocated) {
      await db.query(
        `INSERT INTO public.payment_allocations(
          payment_id,folio_id,amount
        ) VALUES ($1,$2,$3)`,
        [payment,folio,amount]
      );
    }
  }

  async function addAppliedDeposit(
    amount: number,
    linkedPayment: boolean
  ) {
    await db.query(
      `INSERT INTO public.folio_lines(
        id,folio_id,organization_id,
        line_type,category,net_amount
      ) VALUES ($1,$2,$3,'payment','payment',$4)`,
      [line,folio,org,amount]
    );

    await db.query(
      `INSERT INTO public.reservation_deposits(
        id,organization_id,applied_folio_id,
        applied_folio_line_id,payment_id,
        amount,currency,status
      ) VALUES ($1,$2,$3,$4,$5,$6,'KES','applied')`,
      [
        deposit,org,folio,line,
        linkedPayment ? payment : null,
        amount
      ]
    );
  }

  it("agrees for a normal paid bill", async () => {
    await addPayment(3000);
    expect(await assess()).toEqual({
      finance: 9000,
      checkout: 9000,
      difference: 0
    });
  });

  it("agrees for an applied deposit without a payment row", async () => {
    await addAppliedDeposit(4000,false);
    await addPayment(3000);

    expect(await assess()).toEqual({
      finance: 5000,
      checkout: 5000,
      difference: 0
    });
  });

  it("exposes double counting when an applied deposit also has an allocated payment", async () => {
    await addPayment(4000);
    await addAppliedDeposit(4000,true);

    const result = await assess();

    expect(result.finance).toBe(8000);
    expect(result.checkout).toBe(4000);
    expect(result.difference).toBe(-4000);
  });

  it("exposes a confirmed reservation deposit payment not transferred to the folio", async () => {
    // Reservation collected KES 4,000 before the folio existed.
    await addPayment(4000,"confirmed",false);

    // Original payment remains attached to the reservation,
    // not to the newly created folio.
    await db.query(
      `UPDATE public.payments
       SET folio_id=NULL
       WHERE id=$1`,
      [payment]
    );

    // Check-in applies the deposit as a folio payment line
    // and retains the original payment_id linkage.
    await addAppliedDeposit(4000,true);

    const result = await assess();

    // Canonical Finance currently omits the linked deposit.
    expect(result.finance).toBe(12000);

    // Legacy checkout recognises the applied deposit line.
    expect(result.checkout).toBe(8000);

    // This must be resolved before canonical checkout deployment.
    expect(result.difference).toBe(-4000);
  });
  it("exposes different treatment of a confirmed unallocated payment", async () => {
    await addPayment(3000,"confirmed",false);

    const result = await assess();

    expect(result.finance).toBe(9000);
    expect(result.checkout).toBe(12000);
    expect(result.difference).toBe(3000);
  });

  it("does not treat a pending payment as collected", async () => {
    await addPayment(3000,"pending",false);

    expect(await assess()).toEqual({
      finance: 12000,
      checkout: 12000,
      difference: 0
    });
  });

  it("does not count a reversed deposit line as an active deposit", async () => {
    await addAppliedDeposit(4000,false);

    await db.query(
      `UPDATE public.folio_lines SET status='reversed'
       WHERE id=$1`,
      [line]
    );

    expect(await assess()).toEqual({
      finance: 12000,
      checkout: 12000,
      difference: 0
    });
  });

  it("refuses a different-currency confirmed collection", async () => {
    await addPayment(3000);

    await db.query(
      `UPDATE public.payments SET currency='USD'
       WHERE id=$1`,
      [payment]
    );

    await expect(assess()).rejects.toThrow(
      /different currency/i
    );
  });
});