CREATE OR REPLACE FUNCTION public.neo_approval_standard_types()
RETURNS TABLE(key text, name text)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT * FROM (VALUES
    ('discount', 'Discount'),
    ('bill-void', 'Bill void request'),
    ('bill-adjustment', 'Bill adjustment'),
    ('complimentary-meal', 'Complimentary meal'),
    ('complimentary-room', 'Complimentary room'),
    ('refund', 'Refund approval'),
    ('payment-reversal', 'Payment reversal'),
    ('write-off', 'Write-off approval'),
    ('cash-variance', 'Cash variance review'),
    ('rate-override', 'Rate override'),
    ('price-change', 'Manual price change'),
    ('credit-account', 'Credit account approval'),
    ('purchase-request', 'Purchase requisition'),
    ('purchase-order', 'Purchase order / LPO'),
    ('procurement-variance', 'Procurement variance / exception'),
    ('supplier-invoice', 'Supplier invoice'),
    ('procurement-approval', 'Procurement approval'),
    ('stock-adjustment', 'Stock adjustment'),
    ('stock-write-off', 'Stock write-off'),
    ('expense', 'Expense approval'),
    ('till-reopen', 'Till reopening'),
    ('event-quotation', 'Event quotation'),
    ('event-pricing-exception', 'Event pricing exception')
  ) AS v(key, name);
$$;

CREATE OR REPLACE FUNCTION public.neo_approval_ensure_types()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _created int := 0;
  _t record;
BEGIN
  IF _org IS NULL THEN RETURN 0; END IF;
  FOR _t IN SELECT * FROM public.neo_approval_standard_types()
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.approval_types t
                    WHERE t.organization_id = _org AND t.key = _t.key) THEN
      INSERT INTO public.approval_types (organization_id, key, name, levels, active)
      VALUES (_org, _t.key, _t.name, 1, true);
      _created := _created + 1;
    END IF;
  END LOOP;
  RETURN _created;
END;
$function$;

-- Backfill: every existing workspace gets the standard catalogue it was missing.
INSERT INTO public.approval_types (organization_id, key, name, levels, active)
SELECT o.id, s.key, s.name, 1, true
FROM public.organizations o
CROSS JOIN public.neo_approval_standard_types() s
WHERE NOT EXISTS (
  SELECT 1 FROM public.approval_types t
  WHERE t.organization_id = o.id AND t.key = s.key
);