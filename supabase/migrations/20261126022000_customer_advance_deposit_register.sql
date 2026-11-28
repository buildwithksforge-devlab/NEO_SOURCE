BEGIN;

CREATE TABLE public.neo_customer_advance_deposits (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL
      REFERENCES public.organizations(id),

    branch_id uuid NOT NULL
      REFERENCES public.branches(id),

    customer_id uuid NOT NULL
      REFERENCES public.customers(id),

    payment_id uuid NOT NULL UNIQUE
      REFERENCES public.payments(id),

    journal_id uuid NOT NULL UNIQUE,

    currency text NOT NULL
      CHECK (currency ~ '^[A-Z]{3}$'),

    original_amount numeric(18,2) NOT NULL
      CHECK (
        original_amount > 0
        AND original_amount::text NOT IN (
          'NaN','Infinity','-Infinity'
        )
      ),

    received_by uuid NOT NULL,

    received_at timestamptz NOT NULL DEFAULT now(),

    intent_key text NOT NULL,

    UNIQUE (organization_id,intent_key)

);

CREATE TABLE public.neo_customer_deposit_movements (

    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id uuid NOT NULL
      REFERENCES public.organizations(id),

    branch_id uuid NOT NULL
      REFERENCES public.branches(id),

    deposit_id uuid NOT NULL
      REFERENCES public.neo_customer_advance_deposits(id),

    movement_type text NOT NULL
      CHECK (
        movement_type IN ('allocation','refund')
      ),

    source_record_id uuid NOT NULL,

    journal_id uuid NOT NULL UNIQUE,

    amount numeric(18,2) NOT NULL
      CHECK (
        amount > 0
        AND amount::text NOT IN (
          'NaN','Infinity','-Infinity'
        )
      ),

    performed_by uuid NOT NULL,

    performed_at timestamptz NOT NULL DEFAULT now(),

    intent_key text NOT NULL,

    UNIQUE (organization_id,intent_key)

);

CREATE INDEX neo_customer_advance_deposit_lookup
ON public.neo_customer_advance_deposits (
    organization_id,
    branch_id,
    customer_id,
    received_at DESC
);

CREATE INDEX neo_customer_deposit_movement_lookup
ON public.neo_customer_deposit_movements (
    deposit_id,
    performed_at DESC
);

ALTER TABLE public.neo_customer_advance_deposits
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.neo_customer_deposit_movements
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.neo_customer_advance_deposits,
  public.neo_customer_deposit_movements
FROM PUBLIC,anon,authenticated;


-- The register must never recognise an unposted
-- customer collection as an available deposit.

CREATE OR REPLACE FUNCTION
public.neo_customer_advance_deposit_position(
    _branch uuid,
    _customer uuid
)
RETURNS jsonb

LANGUAGE plpgsql

STABLE

SECURITY DEFINER

SET search_path TO pg_catalog,public

AS $function$

DECLARE

    org uuid := public.current_org_id();

BEGIN

    IF auth.uid() IS NULL

      OR org IS NULL

      OR _branch IS NULL

      OR _customer IS NULL

      OR public.current_access_scope() IS NULL

      OR public.current_access_scope() = 'technical'

      OR public.neo_branch_in_scope(_branch) IS NOT TRUE

      OR NOT coalesce(

        public.has_permission('finance','view')

        OR public.has_permission(
          'finance','ar.allocate_receipt'
        )

        OR public.is_org_admin(),

        false

      )

    THEN

      RAISE EXCEPTION 'Customer deposit access denied'
        USING ERRCODE='42501';

    END IF;

    IF NOT EXISTS (

      SELECT 1

      FROM public.customers c

      WHERE c.id = _customer

        AND c.organization_id = org

    ) THEN

      RAISE EXCEPTION 'Customer unavailable'
        USING ERRCODE='42501';

    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.neo_customer_advance_deposits d
        LEFT JOIN public.payments p
          ON p.id = d.payment_id
        LEFT JOIN public.journal_entries j
          ON j.id = d.journal_id
        WHERE d.organization_id = org
          AND d.branch_id = _branch
          AND d.customer_id = _customer
          AND (
              p.id IS NULL
              OR p.organization_id IS DISTINCT FROM org
              OR p.branch_id IS DISTINCT FROM _branch
              OR p.customer_id IS DISTINCT FROM _customer
              OR p.posted_journal_id IS DISTINCT FROM d.journal_id
              OR p.status IS DISTINCT FROM 'confirmed'
              OR p.amount IS DISTINCT FROM d.original_amount
              OR p.currency IS DISTINCT FROM d.currency
              OR j.id IS NULL
              OR j.organization_id IS DISTINCT FROM org
              OR j.branch_id IS DISTINCT FROM _branch
              OR j.currency IS DISTINCT FROM d.currency
              OR j.status IS DISTINCT FROM 'posted'
              OR j.reversed_by_journal_id IS NOT NULL
              OR j.total_debit IS DISTINCT FROM d.original_amount
              OR j.total_credit IS DISTINCT FROM d.original_amount
          )
    ) THEN
        RAISE EXCEPTION
          'Customer deposit accounting requires reconciliation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.neo_customer_deposit_movements m
        JOIN public.neo_customer_advance_deposits d
          ON d.id = m.deposit_id
        LEFT JOIN public.journal_entries j
          ON j.id = m.journal_id
        WHERE d.organization_id = org
          AND d.branch_id = _branch
          AND d.customer_id = _customer
          AND (
              m.organization_id IS DISTINCT FROM org
              OR m.branch_id IS DISTINCT FROM _branch
              OR j.id IS NULL
              OR j.organization_id IS DISTINCT FROM org
              OR j.branch_id IS DISTINCT FROM _branch
              OR j.currency IS DISTINCT FROM d.currency
              OR j.status IS DISTINCT FROM 'posted'
              OR j.reversed_by_journal_id IS NOT NULL
              OR j.total_debit IS DISTINCT FROM m.amount
              OR j.total_credit IS DISTINCT FROM m.amount
          )
    ) THEN
        RAISE EXCEPTION
          'Customer deposit movements require reconciliation';
    END IF;

    RETURN coalesce((

      SELECT jsonb_agg(

        to_jsonb(x)

        ORDER BY x.received_at DESC,x.id

      )

      FROM (

        SELECT

          d.id,

          p.receipt_number,

          d.currency,

          d.original_amount,

          coalesce(m.allocated,0) AS allocated_amount,

          coalesce(m.refunded,0) AS refunded_amount,

          d.original_amount

            - coalesce(m.allocated,0)

            - coalesce(m.refunded,0)

            AS available_amount,

          d.received_at

        FROM public.neo_customer_advance_deposits d

        JOIN public.payments p

          ON p.id = d.payment_id

          AND p.organization_id = d.organization_id

          AND p.branch_id = d.branch_id

          AND p.customer_id = d.customer_id

          AND p.posted_journal_id = d.journal_id

          AND p.status = 'confirmed'

          AND p.amount = d.original_amount

          AND p.currency = d.currency

        JOIN public.journal_entries j

          ON j.id = d.journal_id

          AND j.organization_id = d.organization_id

          AND j.branch_id = d.branch_id

          AND j.currency = d.currency

          AND j.status = 'posted'

          AND j.reversed_by_journal_id IS NULL

          AND j.total_debit = d.original_amount

          AND j.total_credit = d.original_amount

        LEFT JOIN LATERAL (

          SELECT

            sum(a.amount) FILTER (
              WHERE a.movement_type = 'allocation'
            ) AS allocated,

            sum(a.amount) FILTER (
              WHERE a.movement_type = 'refund'
            ) AS refunded

          FROM public.neo_customer_deposit_movements a

          WHERE a.deposit_id = d.id

            AND a.organization_id = d.organization_id

            AND a.branch_id = d.branch_id

        ) m ON true

        WHERE d.organization_id = org

          AND d.branch_id = _branch

          AND d.customer_id = _customer

      ) x

    ),'[]'::jsonb);

END;

$function$;

REVOKE ALL ON FUNCTION
public.neo_customer_advance_deposit_position(uuid,uuid)
FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION
public.neo_customer_advance_deposit_position(uuid,uuid)
TO authenticated;

NOTIFY pgrst,'reload schema';

COMMIT;