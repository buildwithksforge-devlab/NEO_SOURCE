-- Local-only candidate. Do not deploy.
-- Reconcile confirmed reservation-linked deposits without
-- creating payment records or changing existing guest transactions.
BEGIN;

DO $repair$
DECLARE
    fn regprocedure :=
      to_regprocedure('public.neo_folio_financial_components(uuid,uuid)');
    src text;
    marker text := '-- neo_folio_applied_deposit_projection_v1';
    location integer;
    prefix text;
    suffix text;
    eligibility text := $eligible$
AND (
  d.payment_id IS NULL
  OR EXISTS (
    SELECT 1
    FROM public.payments linked
    WHERE linked.id = d.payment_id
      AND linked.organization_id = f.organization_id
      AND linked.currency = f.currency
      AND linked.amount = d.amount
      AND linked.status IN ('confirmed','posted','completed')
      AND linked.folio_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.payment_allocations allocation
        WHERE allocation.payment_id = linked.id
      )
  )
)
$eligible$;
    validation text := $validate$
  -- Guard against invalid or conflicting applied collections.
  IF EXISTS (
    SELECT 1
    FROM public.reservation_deposits d
    LEFT JOIN public.payments p ON p.id = d.payment_id
    WHERE d.organization_id = f.organization_id
      AND d.applied_folio_id = f.id
      AND d.status = 'applied'
      AND (
        d.amount IS NULL
        OR d.amount <= 0
        OR d.amount::text IN ('NaN','Infinity','-Infinity')
        OR d.currency IS DISTINCT FROM f.currency
        OR (
          d.payment_id IS NOT NULL
          AND (
            p.id IS NULL
            OR p.organization_id IS DISTINCT FROM f.organization_id
            OR p.currency IS DISTINCT FROM f.currency
            OR p.amount IS DISTINCT FROM d.amount
            OR COALESCE(p.status,'') NOT IN
                 ('confirmed','posted','completed')
            OR (
              p.folio_id IS NOT NULL
              AND p.folio_id IS DISTINCT FROM f.id
            )
            OR (
              p.folio_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM public.payment_allocations a
                WHERE a.payment_id = p.id
              )
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Applied reservation deposit requires payment reconciliation'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reservation_deposits d
    WHERE d.organization_id = f.organization_id
      AND d.applied_folio_id = f.id
      AND d.status = 'applied'
      AND d.payment_id IS NOT NULL
    GROUP BY d.payment_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Payment reused by applied deposits'
      USING ERRCODE='23514';
  END IF;

$validate$;
BEGIN
    IF fn IS NULL THEN
      RAISE EXCEPTION 'Canonical Finance function missing';
    END IF;

    SELECT pg_get_functiondef(fn) INTO src;

    IF position('-- neo_folio_payment_tenant_guard_v1' IN src)=0
       OR position(marker IN src)=0 THEN
      RAISE EXCEPTION 'Unrecognised Finance function';
    END IF;

    location := position(marker IN src);
    prefix := substring(src FROM 1 FOR location - 1);
    suffix := substring(src FROM location);

    IF (
      length(prefix) -
      length(replace(prefix,'AND d.payment_id IS NULL',''))
    ) <> length('AND d.payment_id IS NULL')
       OR (
      length(suffix) -
      length(replace(suffix,'AND d.payment_id IS NULL',''))
    ) <> length('AND d.payment_id IS NULL')
    THEN
      RAISE EXCEPTION 'Unexpected deposit SQL structure';
    END IF;

    -- Currency checking must include all applied deposits.
    prefix := replace(
      prefix,
      'AND d.payment_id IS NULL',
      ''
    );

    -- Count verified reservation-linked deposits only when
    -- their payment is not already counted on this folio.
    suffix := replace(
      suffix,
      'AND d.payment_id IS NULL',
      eligibility
    );

    src := prefix || validation || suffix;

    EXECUTE src;
END;
$repair$;

COMMIT;