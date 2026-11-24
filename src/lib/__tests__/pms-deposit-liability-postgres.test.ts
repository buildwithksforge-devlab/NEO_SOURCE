import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000001";
const branch = "00000000-0000-4000-8000-000000000002";
const reservation = "00000000-0000-4000-8000-000000000003";
const folio = "00000000-0000-4000-8000-000000000004";
const deposit = "00000000-0000-4000-8000-000000000005";
const customer = "00000000-0000-4000-8000-000000000006";

describe("Real PostgreSQL guest deposit liability trigger", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE TABLE public.folios (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid
      );

      CREATE TABLE public.reservation_deposits (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        reservation_id uuid,
        customer_id uuid,
        amount numeric,
        currency text,
        status text,
        applied_folio_id uuid
      );

      CREATE TABLE public.finance_posting_receipts (
        organization_id uuid,
        idempotency_key text,
        status text
      );

      CREATE TABLE public.journal_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        status text,
        source_type text,
        source_id uuid,
        lines jsonb
      );

      CREATE FUNCTION public.neo_fact_currency(uuid,uuid)
      RETURNS text
      LANGUAGE sql
      AS $$ SELECT 'KES'::text $$;

      CREATE FUNCTION public.neo_gl_post(
        _org uuid,
        _branch uuid,
        _module text,
        _source_type text,
        _source uuid,
        _action text,
        _date date,
        _currency text,
        _description text,
        _lines jsonb,
        _customer uuid
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $$
      DECLARE
        jid uuid;
        amount numeric;
        state text;
      BEGIN
        amount := (
          SELECT coalesce(sum((v->>'debit')::numeric),0)
          FROM jsonb_array_elements(_lines) v
        );

        IF amount IS DISTINCT FROM (
          SELECT coalesce(sum((v->>'credit')::numeric),0)
          FROM jsonb_array_elements(_lines) v
        ) THEN
          RAISE EXCEPTION 'Journal is not balanced';
        END IF;

        state := CASE WHEN amount=4999
                      THEN 'draft' ELSE 'posted' END;

        INSERT INTO public.journal_entries (
          organization_id,branch_id,status,
          source_type,source_id,lines
        )
        VALUES (
          _org,_branch,state,
          _source_type || ':' || _action,_source,_lines
        )
        RETURNING id INTO jid;

        RETURN jsonb_build_object(
          'ok',state='posted',
          'journal_id',jid
        );
      END;
      $$;
    `);

    // Supabase roles required by the real migration's REVOKE statement.
    // These roles exist only inside this disposable PGlite database.
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
    `);

    const migration = readFileSync(
      "supabase/migrations/20261024120000_f03_guest_deposit_liability_clearing.sql",
      "utf8"
    );
    await db.exec(migration);
  }, 30000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.journal_entries,
        public.finance_posting_receipts,
        public.reservation_deposits,
        public.folios;
    `);

    await db.query(
      `INSERT INTO public.folios (
        id,organization_id,branch_id,reservation_id
      ) VALUES ($1,$2,$3,$4)`,
      [folio,org,branch,reservation]
    );

    await db.query(
      `INSERT INTO public.reservation_deposits (
        id,organization_id,branch_id,reservation_id,
        customer_id,amount,currency,status,applied_folio_id
      ) VALUES ($1,$2,$3,$4,$5,4000,'KES','held',$6)`,
      [deposit,org,branch,reservation,customer,folio]
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  async function markOriginalPosted() {
    await db.query(
      `INSERT INTO public.finance_posting_receipts
        (organization_id,idempotency_key,status)
       VALUES ($1,$2,'posted')`,
      [org,`deposit:${deposit}`]
    );
  }

  async function apply() {
    return db.query(
      `UPDATE public.reservation_deposits
       SET status='applied'
       WHERE id=$1`,
      [deposit]
    );
  }

  async function journalRows() {
    const result = await db.query<{
      status: string;
      source_type: string;
      lines: Array<{
        code: string;
        debit?: number;
        credit?: number;
      }>;
    }>(
      `SELECT status,source_type,lines
       FROM public.journal_entries
       WHERE source_id=$1`,
      [deposit]
    );
    return result.rows;
  }

  it("posts 2020 debit and 1060 credit exactly once", async () => {
    await markOriginalPosted();
    await apply();

    const rows = await journalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("posted");
    expect(rows[0]!.source_type).toBe(
      "reservation_deposit_application:application"
    );

    const debit = rows[0]!.lines.find(x=>x.code==="2020");
    const credit = rows[0]!.lines.find(x=>x.code==="1060");

    expect(Number(debit?.debit)).toBe(4000);
    expect(Number(credit?.credit)).toBe(4000);
  });

  it("does not repost when status remains applied", async () => {
    await markOriginalPosted();
    await apply();
    await apply();

    expect(await journalRows()).toHaveLength(1);
  });

  it("refuses application without an original posted receipt", async () => {
    await expect(apply()).rejects.toThrow(
      /original receipt is posted/i
    );
    expect(await journalRows()).toHaveLength(0);
  });

  it("refuses an original receipt that is only pending", async () => {
    await db.query(
      `INSERT INTO public.finance_posting_receipts
       (organization_id,idempotency_key,status)
       VALUES ($1,$2,'pending')`,
      [org,`deposit:${deposit}`]
    );

    await expect(apply()).rejects.toThrow(
      /original receipt is posted/i
    );
  });

  it("refuses a mismatch between folio and deposit organisation", async () => {
    await markOriginalPosted();
    await db.query(
      `UPDATE public.folios
       SET organization_id=$1 WHERE id=$2`,
      ["00000000-0000-4000-8000-000000000099",folio]
    );

    await expect(apply()).rejects.toThrow(
      /matching guest folio/i
    );
  });

  it("refuses a mismatch between folio and deposit branch", async () => {
    await markOriginalPosted();
    await db.query(
      `UPDATE public.folios
       SET branch_id=$1 WHERE id=$2`,
      ["00000000-0000-4000-8000-000000000098",folio]
    );

    await expect(apply()).rejects.toThrow(
      /matching guest folio/i
    );
  });

  it("refuses a mismatch between folio and reservation", async () => {
    await markOriginalPosted();
    await db.query(
      `UPDATE public.folios
       SET reservation_id=$1 WHERE id=$2`,
      ["00000000-0000-4000-8000-000000000097",folio]
    );

    await expect(apply()).rejects.toThrow(
      /matching guest folio/i
    );
  });

  it("refuses non-positive deposits", async () => {
    await markOriginalPosted();
    await db.query(
      `UPDATE public.reservation_deposits
       SET amount=0 WHERE id=$1`,
      [deposit]
    );

    await expect(apply()).rejects.toThrow(
      /zero or negative deposit/i
    );
  });

  it("refuses changing deposit amount while applying", async () => {
    await markOriginalPosted();

    await expect(
      db.query(
        `UPDATE public.reservation_deposits
         SET amount=5000,status='applied'
         WHERE id=$1`,
        [deposit]
      )
    ).rejects.toThrow(
      /identity, location and amount cannot change/i
    );
  });

  it("rolls back application when journal is not posted", async () => {
    await markOriginalPosted();

    await db.query(
      `UPDATE public.reservation_deposits
       SET amount=4999 WHERE id=$1`,
      [deposit]
    );

    await expect(apply()).rejects.toThrow(
      /GL posting failed/i
    );

    expect(await journalRows()).toHaveLength(0);

    const result = await db.query<{status:string}>(
      `SELECT status FROM public.reservation_deposits
       WHERE id=$1`,
      [deposit]
    );
    expect(result.rows[0]?.status).toBe("held");
  });

  it("refuses applying a deposit from an unexpected status", async () => {
    await markOriginalPosted();
    await db.query(
      `UPDATE public.reservation_deposits
       SET status='cancelled' WHERE id=$1`,
      [deposit]
    );

    await expect(apply()).rejects.toThrow(
      /Cannot apply deposit/i
    );
  });
});
