alter table branches add column timezone text;
alter table branches add column created_at timestamptz default now();
CREATE OR REPLACE FUNCTION public.neo_fact_timezone(_org uuid, _branch uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    (SELECT nullif(b.timezone, '') FROM public.branches b
      WHERE b.organization_id = _org AND (_branch IS NULL OR b.id = _branch)
      ORDER BY (b.id = _branch) DESC, b.created_at LIMIT 1),
    'Africa/Nairobi');
$function$;
CREATE OR REPLACE FUNCTION public.neo_module_label(_module text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _module IN ('pos','pos_order') THEN 'pos'
    WHEN _module IN ('folio','folio_charge','folio_payment') THEN 'folio'
    WHEN _module IN ('events','event_earned','event_deposit','event_invoice','event_cancellation') THEN 'events'
    WHEN _module IN ('laundry','laundry_order') THEN 'laundry'
    WHEN _module IN ('delivery','delivery_order') THEN 'delivery'
    WHEN _module IN ('procurement','supplier_invoice','supplier_payment') THEN 'procurement'
    ELSE coalesce(_module,'other') END
$function$;
