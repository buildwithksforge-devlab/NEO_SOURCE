-- A front-desk incidental charge cannot stand in for the inventory transaction for a stock sale.
BEGIN;
CREATE FUNCTION public.neo_pms_manual_stock_sale_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp
AS $function$
BEGIN
 IF NEW.line_type='charge' AND coalesce(NEW.source_module,'manual') IN ('manual','pms','pms.folio')
  AND replace(lower(trim(NEW.category)),'_','-') IN (
   'food-beverage','restaurant','bar','coffee','coffee-station','pastry','room-service','minibar'
  ) THEN
  RAISE EXCEPTION 'Post this stock sale from POS or Minibar and charge it to the guest folio'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_pms_manual_stock_sale_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_pms_manual_stock_sale_guard BEFORE INSERT ON public.folio_lines
 FOR EACH ROW EXECUTE FUNCTION public.neo_pms_manual_stock_sale_guard();
COMMIT;
