import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000001";
const branch = "00000000-0000-4000-8000-000000000002";
const reservation = "00000000-0000-4000-8000-000000000003";
const folio = "00000000-0000-4000-8000-000000000004";
const deposit = "00000000-0000-4000-8000-000000000005";
const customer = "00000000-0000-4000-8000-000000000006";
const originalJournal = "00000000-0000-4000-8000-000000000007";
const cashAccount = "00000000-0000-4000-8000-000000000008";
const liabilityAccount = "00000000-0000-4000-8000-000000000009";
const otherAccount = "00000000-0000-4000-8000-000000000010";
const otherBranch = "00000000-0000-4000-8000-000000000098";
const otherOrg = "00000000-0000-4000-8000-000000000099";

describe("PMS original-deposit journal guard migration", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE ROLE anon NOLOGIN;

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
        status text,
        journal_id uuid
      );

      CREATE TABLE public.chart_of_accounts (
        id uuid PRIMARY KEY,
        organization_id uuid,
        code text
      );

      CREATE TABLE public.journal_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        branch_id uuid,
        currency text,
        status text,
        reversed_by_journal_id uuid,
        source_document_type text,
        source_document_id uuid,
        total_debit numeric,
        total_credit numeric
      );

      CREATE TABLE public.journal_entry_lines (
        journal_id uuid,
        organization_id uuid,
        branch_id uuid,
        account_id uuid,
        debit numeric,
        credit numeric
      );

      CREATE FUNCTION public.neo_fact_currency(uuid,uuid)
      RETURNS text
      LANGUAGE sql
      AS $$ SELECT 'KES'::text $$;

      CREATE FUNCTION public.neo_connection_journal_matches(
        _journal uuid,_org uuid,_branch uuid,_currency text,
        _amount numeric,_type text,_source uuid
      )
      RETURNS boolean
      LANGUAGE sql STABLE
      AS $$
        SELECT EXISTS (
          SELECT 1
          FROM public.journal_entries j
          WHERE j.id = _journal
            AND j.organization_id = _org
            AND j.branch_id IS NOT DISTINCT FROM _branch
            AND j.currency = _currency
            AND j.status = 'posted'
            AND j.reversed_by_journal_id IS NULL
            AND j.source_document_type = _type
            AND j.source_document_id = _source
            AND _amount > 0
            AND _amount::text NOT IN ('NaN','Infinity','-Infinity')
            AND j.total_debit = _amount
            AND j.total_credit = _amount
            AND NOT EXISTS (
              SELECT 1
              FROM public.journal_entry_lines l
              LEFT JOIN public.chart_of_accounts a
                ON a.id = l.account_id
              WHERE l.journal_id = j.id
                AND (
                  l.organization_id IS DISTINCT FROM _org
                  OR l.branch_id IS DISTINCT FROM _branch
                  OR a.organization_id IS DISTINCT FROM _org
                  OR l.debit IS NULL OR l.credit IS NULL
                  OR l.debit < 0 OR l.credit < 0
                )
            )
            AND (
              SELECT coalesce(sum(l.debit),0)
              FROM public.journal_entry_lines l
              WHERE l.journal_id = j.id
            ) = _amount
            AND (
              SELECT coalesce(sum(l.credit),0)
              FROM public.journal_entry_lines l
              WHERE l.journal_id = j.id
            ) = _amount
        )
      $$;

      CREATE FUNCTION public.neo_gl_post(
        _org uuid,_branch uuid,_module text,
        _source_type text,_source uuid,_action text,
        _date date,_currency text,_description text,
        _lines jsonb,_customer uuid
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $$
      DECLARE jid uuid;
      BEGIN
        INSERT INTO public.journal_entries (
          organization_id,branch_id,currency,status,
          source_document_type,source_document_id,
          total_debit,total_credit
        )
        VALUES (
          _org,_branch,_currency,'posted',
          _source_type || ':' || _action,_source,
          (SELECT sum((x->>'debit')::numeric)
           FROM jsonb_array_elements(_lines) x
           WHERE x ? 'debit'),
          (SELECT sum((x->>'credit')::numeric)
           FROM jsonb_array_elements(_lines) x
           WHERE x ? 'credit')
        )
        RETURNING id INTO jid;

        RETURN jsonb_build_object('ok',true,'journal_id',jid);
      END;
      $$;
    `);

    await db.exec(readFileSync(
      "supabase/migrations/20261024120000_f03_guest_deposit_liability_clearing.sql",
      "utf8"
    ));

    await db.exec(readFileSync(
      "supabase/migrations/20261116231000_pms_deposit_original_journal_guard.sql",
      "utf8"
    ));
  }, 30000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.journal_entry_lines,
        public.journal_entries,
        public.finance_posting_receipts,
        public.reservation_deposits,
        public.folios,
        public.chart_of_accounts;
    `);

    await db.query(
      `INSERT INTO public.folios
       VALUES ($1,$2,$3,$4)`,
      [folio,org,branch,reservation]
    );

    await db.query(
      `INSERT INTO public.reservation_deposits
       VALUES ($1,$2,$3,$4,$5,4000,'KES','held',$6)`,
      [deposit,org,branch,reservation,customer,folio]
    );

    for (const [id,code] of [
      [cashAccount,"1010"],
      [liabilityAccount,"2020"],
      [otherAccount,"2999"]
    ]) {
      await db.query(
        `INSERT INTO public.chart_of_accounts VALUES ($1,$2,$3)`,
        [id,org,code]
      );
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  async function seedOriginal(options: {
    amount?: number;
    currency?: string;
    branch?: string;
    org?: string;
    status?: string;
    source?: string;
    liabilityAccount?: string;
    reversed?: boolean;
    receiptJournal?: string | null;
  } = {}) {
    const amount = options.amount ?? 4000;

    await db.query(
      `INSERT INTO public.journal_entries (
        id,organization_id,branch_id,currency,status,
        reversed_by_journal_id,source_document_type,
        source_document_id,total_debit,total_credit
       )
       VALUES ($1,$2,$3,$4,$5,$6,
               'reservation_deposit:deposit',$7,$8,$8)`,
      [
        originalJournal,
        options.org ?? org,
        options.branch ?? branch,
        options.currency ?? "KES",
        options.status ?? "posted",
        options.reversed ? otherAccount : null,
        options.source ?? deposit,
        amount
      ]
    );

    await db.query(
      `INSERT INTO public.journal_entry_lines
       VALUES ($1,$2,$3,$4,$5,0),
              ($1,$2,$3,$6,0,$5)`,
      [
        originalJournal,
        options.org ?? org,
        options.branch ?? branch,
        cashAccount,
        amount,
        options.liabilityAccount ?? liabilityAccount
      ]
    );

    await db.query(
      `INSERT INTO public.finance_posting_receipts
       VALUES ($1,$2,'posted',$3)`,
      [
        org,
        `deposit:${deposit}`,
        options.receiptJournal === undefined
          ? originalJournal
          : options.receiptJournal
      ]
    );
  }

  async function apply() {
    return db.query(
      `UPDATE public.reservation_deposits
       SET status='applied' WHERE id=$1`,
      [deposit]
    );
  }

  async function expectRejected() {
    await expect(apply()).rejects.toThrow();

    const result = await db.query<{status:string}>(
      `SELECT status FROM public.reservation_deposits
       WHERE id=$1`,
      [deposit]
    );

    expect(result.rows[0]?.status).toBe("held");
  }

  async function applicationCount() {
    const result = await db.query<{count:string}>(
      `SELECT count(*)::text AS count
       FROM public.journal_entries
       WHERE source_document_type =
         'reservation_deposit_application:application'
       AND source_document_id=$1`,
      [deposit]
    );
    return Number(result.rows[0]!.count);
  }

  it("installs the journal guard and permits a valid deposit", async () => {
    await seedOriginal();
    await apply();
    expect(await applicationCount()).toBe(1);
  });

  it("does not duplicate the application journal", async () => {
    await seedOriginal();
    await apply();
    await apply();
    expect(await applicationCount()).toBe(1);
  });

  it("rejects a posted receipt without a journal", async () => {
    await db.query(
      `INSERT INTO public.finance_posting_receipts
       VALUES ($1,$2,'posted',NULL)`,
      [org,`deposit:${deposit}`]
    );
    await expectRejected();
  });

  it("rejects the wrong journal link", async () => {
    await seedOriginal({receiptJournal:otherAccount});
    await expectRejected();
  });

  it("rejects an original journal with the wrong amount", async () => {
    await seedOriginal({amount:3000});
    await expectRejected();
  });

  it("rejects an original journal in the wrong currency", async () => {
    await seedOriginal({currency:"USD"});
    await expectRejected();
  });

  it("rejects an original journal from another branch", async () => {
    await seedOriginal({branch:otherBranch});
    await expectRejected();
  });

  it("rejects an original journal from another organisation", async () => {
    await seedOriginal({org:otherOrg});
    await expectRejected();
  });

  it("rejects a journal with the wrong source identity", async () => {
    await seedOriginal({source:otherAccount});
    await expectRejected();
  });

  it("rejects an original journal that is not posted", async () => {
    await seedOriginal({status:"draft"});
    await expectRejected();
  });

  it("rejects a reversed original journal", async () => {
    await seedOriginal({reversed:true});
    await expectRejected();
  });

  it("rejects a journal without an account 2020 credit", async () => {
    await seedOriginal({liabilityAccount:otherAccount});
    await expectRejected();
  });
});
