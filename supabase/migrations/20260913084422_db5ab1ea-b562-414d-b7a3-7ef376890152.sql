CREATE OR REPLACE FUNCTION public.inventory_normalise_unit(_unit text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  -- People type the same unit many ways: "pc", "PCS(Piece)", "Piece(PC)",
  -- "Bottle ". Fold to one spelling before any unit comparison, otherwise a
  -- stray capital or bracket skips whole-unit rounding.
  SELECT regexp_replace(
           lower(btrim(
             CASE
               WHEN btrim(regexp_replace(coalesce(_unit,''), '\(.*?\)', '', 'g')) <> ''
                 THEN regexp_replace(coalesce(_unit,''), '\(.*?\)', '', 'g')
               ELSE coalesce((regexp_match(coalesce(_unit,''), '\(([^)]+)\)'))[1], '')
             END
           )),
           '[^a-z]', '', 'g');
$function$;

CREATE OR REPLACE FUNCTION public.inventory_round_for_unit(_qty numeric, _unit text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _qty IS NULL THEN _qty
    WHEN public.inventory_normalise_unit(_unit) IN (
      'pc','pcs','piece','pieces','each','unit','units',
      'bottle','bottles','can','cans','carton','cartons','crate','crates',
      'ream','reams','roll','rolls','bag','bags','tin','tins','jar','jars',
      'set','sets','pack','packs','box','boxes','sachet','sachets','tray','trays',
      'bun','buns','loaf','loaves','dozen','dozens','tot','tots','glass','glasses',
      'plate','plates','bar','bars','tube','tubes','pair','pairs'
    ) THEN ceil(_qty)
    ELSE _qty
  END;
$function$;