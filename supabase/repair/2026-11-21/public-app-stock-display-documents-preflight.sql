-- Read-only. Run before installing the three public app updates.
WITH routines AS (
  SELECT to_regprocedure('public.neo_pos_department_menu_availability(uuid,text)') AS stock,
    to_regprocedure('public.neo_production_display_pair(uuid,uuid[],text,boolean)') AS display_pair,
    to_regprocedure('public.neo_public_property(text)') AS public_property,
    to_regprocedure('public.neo_guest_folio_projection(uuid,uuid)') AS guest_folios
)
SELECT
  stock::text AS staff_stock_routine,
  coalesce(strpos(pg_get_functiondef(stock),'b.output_location_id')>0,false) AS department_batch_alignment_installed,
  display_pair::text AS display_pair_routine,
  public_property::text AS property_publication_routine,
  guest_folios::text AS guest_folio_routine,
  to_regprocedure('public.neo_public_menu_with_stock(uuid,uuid,text)') IS NOT NULL AS public_stock_installed,
  to_regprocedure('public.neo_production_display_activation_claim(text)') IS NOT NULL AS display_activation_installed,
  to_regprocedure('public.neo_partner_lpo_payload(uuid,uuid,text)') IS NOT NULL AS partner_lpo_installed
FROM routines;
