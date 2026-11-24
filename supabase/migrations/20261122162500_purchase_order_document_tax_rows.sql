BEGIN;

CREATE OR REPLACE FUNCTION public.neo_lpo_document_tax_totals(_order uuid, _org uuid, _totals jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH tax AS (
    SELECT CASE WHEN l.tax_rate>0 AND l.tax_rate<=100 THEN 'Tax at '||trim_scale(l.tax_rate)::text||'%'
      ELSE 'Other recorded tax' END AS label, sum(l.tax_amount) amount
    FROM public.purchase_order_lines l WHERE l.order_id=_order AND l.organization_id=_org AND l.tax_amount<>0
    GROUP BY 1
  ), breakdown AS (
    SELECT sum(amount) amount,
      jsonb_agg(jsonb_build_object('label',label,'amount',amount,'section','tax') ORDER BY label) rows FROM tax
  )
  SELECT CASE WHEN b.amount IS NOT NULL AND b.amount=(SELECT (row->>'amount')::numeric
      FROM jsonb_array_elements(_totals) row WHERE lower(row->>'label')='tax' LIMIT 1)
    THEN (SELECT jsonb_agg(part ORDER BY position, subposition)
      FROM (
        SELECT p.part,p.position,0::bigint subposition FROM jsonb_array_elements(_totals) WITH ORDINALITY p(part,position)
          WHERE lower(p.part->>'label')<>'tax'
        UNION ALL
        SELECT r.part,p.position,r.subposition FROM jsonb_array_elements(_totals) WITH ORDINALITY p(part,position)
          CROSS JOIN LATERAL jsonb_array_elements(b.rows) WITH ORDINALITY r(part,subposition)
          WHERE lower(p.part->>'label')='tax'
      ) lines)
    ELSE _totals END FROM breakdown b;
$function$;
REVOKE ALL ON FUNCTION public.neo_lpo_document_tax_totals(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;

DO $documents$
DECLARE
  staff text := replace(pg_get_functiondef('public.neo_document_payload(text,uuid)'::regprocedure),chr(13)||chr(10),chr(10));
  partner text := replace(pg_get_functiondef('public.neo_partner_lpo_payload(uuid,uuid,text)'::regprocedure),chr(13)||chr(10),chr(10));
  staff_hook text := $hook$ELSE coalesce(_totals,'[]'::jsonb) END,$hook$;
  partner_begin text := $hook$'totals',jsonb_build_array($hook$;
  partner_end text := $hook$
    ),
    'meta',jsonb_strip_nulls$hook$;
BEGIN
  IF strpos(staff,'neo_lpo_document_tax_totals')=0 THEN
    IF strpos(staff,'neo_pos_sales_tax_receipt')=0 OR (length(staff)-length(replace(staff,staff_hook,'')))<>length(staff_hook) THEN
      RAISE EXCEPTION 'Staff document payload needs review before adding saved LPO tax rows';
    END IF;
    EXECUTE replace(staff,staff_hook,
      $hook$WHEN _type='purchase_order' THEN public.neo_lpo_document_tax_totals(_id,_org,coalesce(_totals,'[]'::jsonb)) ELSE coalesce(_totals,'[]'::jsonb) END,$hook$);
  END IF;
  IF strpos(partner,'neo_lpo_document_tax_totals')=0 THEN
    IF (length(partner)-length(replace(partner,partner_begin,'')))<>length(partner_begin)
      OR (length(partner)-length(replace(partner,partner_end,'')))<>length(partner_end) THEN
      RAISE EXCEPTION 'Partner LPO payload needs review before adding saved tax rows';
    END IF;
    EXECUTE replace(replace(partner,partner_begin,
      $hook$'totals',public.neo_lpo_document_tax_totals(p.id,p.organization_id,jsonb_build_array($hook$),
      partner_end,replace(partner_end,'),',')),') );
  END IF;
END;
$documents$;

NOTIFY pgrst,'reload schema';
COMMIT;
